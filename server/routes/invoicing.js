/**
 * /api/invoicing
 * ---------------------------------------------------------------------------
 * Mirrors Access's Invoicing_Main.frm (project dashboard) + ProceedToInvoice.frm
 * (per-project release settings) + Invoice-New_Edit.frm (invoice CRUD). Real
 * schema (confirmed 2026-08-25):
 *
 *   invoicingprojectrelease  one row per project once released for invoicing:
 *                            proceedtoinvoice, invpaymethodid (delivery
 *                            method), scheduletypeid, numberofinvoices,
 *                            firstdate, lastdate
 *   invoices                 invoicecode, invoicestatusid, invoiceyear,
 *                            invoiceseq, iscorrective, sourceinvoiceid,
 *                            projectid
 *   invoicesdetails          1:1 with invoices (invoiceid): amount, the
 *                            three status-driving dates (invoicedate,
 *                            invoicesentdate, invoicedipositdate),
 *                            invoiceduedate, vatid/vatamount, business
 *                            partner refs, comments
 *   invoicesstatus / invoicescheduletypes / invoicepaymentmethods /
 *   invoices_vattypes        small reference tables (see /lookups)
 *
 * Status is NEVER set directly — it's always derived from the three dates
 * via the DB function set_new_invoice_status(), already deployed on this
 * database (ported from the Access VBA rule). Creating a corrective invoice
 * (isCorrective + sourceInvoiceId) auto-cancels the source invoice
 * (status 6), matching Access's CancelInvoice behaviour.
 *
 * Invoice numbering simplification: real Access data pools HITT and
 * HiTT/OSM into one shared per-year sequence with FHiTT separate; that
 * nuance isn't replicated here. This uses one pooled sequence per
 * (year, corrective) across all entities — matches the visible pattern in
 * the test data (consecutive codes like 2026-002/003/004) but hasn't been
 * verified against the exact historical Access numbering rule. Fine for
 * this test environment; flag to finance before this goes near production.
 *
 * PDF generation (GET /invoices/:id/pdf) matches a real sample invoice
 * Alex provided directly. The entity letterhead (legal name/address/VAT/
 * email/web) isn't stored in the DB anywhere, so it's hardcoded in
 * lib/invoicePdf.js from the sample, for HiTT only. FHiTT/HiTT-OSM
 * currently fall back to the same HiTT letterhead, which is almost
 * certainly wrong for a different legal entity — see that file's header
 * comment before sending one of those to a real client.
 *
 * The invoice's field labels + email subject/body ARE in the DB, per
 * language (invoicedocumentcontrols / invoicedocumenttext) — resolved via
 * lib/invoiceDocText.js from the recipient business partner's
 * businesspartners.languageid (tax company's BP first, then the project's).
 *
 * "Send by email" (Access's cmdSendToEmailPDF): GET/POST /invoices/:id/email.
 * The PDF is attached; the sender mailbox + transport come from the billing
 * entity record (Settings -> Entities -> "Invoice email"), via
 * invoiceSenderFor / invoiceMailChannel:
 *   mailsender     the From mailbox (falls back to the entity's invoicing
 *                  email, then GRAPH_MAIL_SENDER / SMTP_FROM)
 *   mailtransport  'graph' (lib/graph.js) or 'smtp' (lib/mailer.js) — pick
 *                  SMTP when the sender mailbox isn't in the M365 tenant, so
 *                  Graph can't send as it. Unset -> inferred from which
 *                  transport is configured.
 * The user confirms From/recipient/subject/body in a dialog before the POST
 * — nothing is sent without that.
 * ---------------------------------------------------------------------------
 */
const express = require("express");
const { pool } = require("../config/db");
const { requireModuleAccess } = require("../lib/permissions");
const { streamInvoicePdf, renderInvoicePdfBuffer } = require("../lib/invoicePdf");
const { invoiceLabels, fillTemplate } = require("../lib/invoiceDocText");
const { ensureEntitySchema } = require("../lib/entitySchema");
const { graphMailConfigured, sendMail } = require("../lib/graph");
const { smtpConfigured, sendSmtpMail } = require("../lib/mailer");
const { logAudit } = require("../lib/audit");

const router = express.Router();

async function invoiceProjectCode(projectId) {
  try {
    const { rows } = await pool.query(`SELECT projectnumber FROM projects WHERE id = $1::bigint`, [projectId]);
    return rows[0]?.projectnumber ? `project ${rows[0].projectnumber}` : `project #${projectId}`;
  } catch {
    return `project #${projectId}`;
  }
}

// Extras the Access invoicing schema doesn't have — added at runtime
// (mirrored in server/db/schema-changes.sql) the same way audit/appconfig
// columns are:
//   invoicesdetails.updatedat / updatedby   "last updated by" in the modal
//   invoicesdetails.currency                 EUR by default
//   invoicelineitems                         one row per invoiceable item
//   invoicecurrencies                        Settings-managed currency list
let invoicingSchemaReady = null;
function ensureInvoicingSchema() {
  if (!invoicingSchemaReady) {
    invoicingSchemaReady = (async () => {
      await pool.query(`ALTER TABLE invoicesdetails ADD COLUMN IF NOT EXISTS updatedat timestamptz`);
      await pool.query(`ALTER TABLE invoicesdetails ADD COLUMN IF NOT EXISTS updatedby bigint`);
      await pool.query(`ALTER TABLE invoicesdetails ADD COLUMN IF NOT EXISTS currency varchar(8) DEFAULT 'EUR'`);
      // "Sent" tracking — set when the invoice PDF is emailed from the app
      // (POST /invoices/:id/email). Separate from invoicesentdate, which
      // drives the date-derived status.
      await pool.query(`ALTER TABLE invoicesdetails ADD COLUMN IF NOT EXISTS emailedat timestamptz`);
      await pool.query(`ALTER TABLE invoicesdetails ADD COLUMN IF NOT EXISTS emailedby bigint`);
      await pool.query(`ALTER TABLE invoicesdetails ADD COLUMN IF NOT EXISTS emailedto text`);
      await pool.query(`ALTER TABLE invoicesdetails ADD COLUMN IF NOT EXISTS emailedcount int NOT NULL DEFAULT 0`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS invoicelineitems (
          id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          invoiceid   bigint NOT NULL,
          sortorder   int NOT NULL DEFAULT 0,
          description text,
          quantity    numeric(14,2) NOT NULL DEFAULT 1,
          unitprice   numeric(14,2) NOT NULL DEFAULT 0
        )`);
      await pool.query(`CREATE INDEX IF NOT EXISTS invoicelineitems_invoiceid_idx ON invoicelineitems (invoiceid)`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS invoicecurrencies (
          id     bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          code   varchar(8) NOT NULL UNIQUE,
          symbol varchar(8) NOT NULL DEFAULT '',
          label  varchar(64) NOT NULL DEFAULT ''
        )`);
      await pool.query(`ALTER TABLE invoicecurrencies ADD COLUMN IF NOT EXISTS sortorder int NOT NULL DEFAULT 0`);
      await pool.query(
        `INSERT INTO invoicecurrencies (code, symbol, label, sortorder)
         VALUES ('EUR', '€', 'Euro', 0)
         ON CONFLICT (code) DO NOTHING`
      );
    })().catch((err) => {
      invoicingSchemaReady = null; // let a later call retry
      throw err;
    });
  }
  return invoicingSchemaReady;
}

// GET /api/invoicing/lookups
router.get("/lookups", async (req, res) => {
  try {
    await ensureInvoicingSchema();
    const [statuses, scheduleTypes, deliveryMethods, vatTypes, bankAccounts, currencies] = await Promise.all([
      pool.query(`SELECT id, statusdesc AS label FROM invoicesstatus ORDER BY id`),
      pool.query(`SELECT id, scheduledesc AS label, defaultvalue FROM invoicescheduletypes ORDER BY id`),
      pool.query(`SELECT id, methoddesc AS label FROM invoicepaymentmethods ORDER BY id`),
      pool.query(`SELECT id, percentage, vatdescription_short_en AS label FROM invoices_vattypes ORDER BY id`),
      // dipositaccountid on invoicesdetails references bankaccts.acctid, NOT bankaccts.id.
      pool.query(`SELECT acctid AS id, bankname || ' — ' || iban AS label FROM bankaccts ORDER BY acctid`),
      pool.query(`SELECT code, symbol, label FROM invoicecurrencies ORDER BY sortorder, (code = 'EUR') DESC, code`),
    ]);
    res.json({
      statuses: statuses.rows,
      scheduleTypes: scheduleTypes.rows,
      deliveryMethods: deliveryMethods.rows,
      vatTypes: vatTypes.rows,
      bankAccounts: bankAccounts.rows,
      currencies: currencies.rows,
    });
  } catch (err) {
    console.error("[GET /api/invoicing/lookups] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/invoicing/tax-companies?search= — every tax company across all
// business partners, for the invoice modal's "choose another" picker.
router.get("/tax-companies", requireModuleAccess("invoicing"), async (req, res) => {
  const search = (req.query.search || "").trim();
  try {
    const params = [];
    let where = "";
    if (search) {
      params.push(`%${search}%`);
      where = `WHERE tc.taxcompanyname ILIKE $1 OR tc.vatnumber ILIKE $1
                 OR bp.bpname ILIKE $1 OR tc.emailinvoicing ILIKE $1`;
    }
    const { rows } = await pool.query(
      `SELECT tc.id, tc.taxcompanyname, tc.vatnumber, tc.emailinvoicing,
              tc.businesspartnerid AS "bpId", bp.bpname AS "bpName"
       FROM taxcompanies tc
       LEFT JOIN businesspartners bp ON bp.id = tc.businesspartnerid::bigint
       ${where}
       ORDER BY tc.taxcompanyname
       LIMIT 300`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/invoicing/tax-companies] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/invoicing/projects — dashboard list: every invoiceable project
// with its release settings (if any), latest quotation budget, and
// invoiced-to-date total so the frontend can bucket by
// not-released/not-started/partial/total.
router.get("/projects", requireModuleAccess("invoicing"), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.id, p.projectnumber AS code, p.projectname AS name,
             ent.entitydesc AS "entityLabel", ps.projectstatusdesc AS "projectStatusLabel",
             p.busspartnerid AS "bpId", bp.bpname AS "bpName",
             q.finalquotation AS budget,
             r.proceedtoinvoice, r.scheduletypeid, r.numberofinvoices,
             r.firstdate, r.lastdate, r.invpaymethodid,
             COUNT(i.id) FILTER (WHERE i.invoicestatusid IS DISTINCT FROM 6) AS "invoiceCount",
             COALESCE(SUM(d.amount) FILTER (WHERE i.invoicestatusid IS DISTINCT FROM 6), 0) AS "invoicedTotal"
      FROM projects p
      LEFT JOIN entity ent ON ent.id = p.entityid::bigint
      LEFT JOIN projectstatus ps ON ps.id = p.projectstatusid::bigint
      LEFT JOIN businesspartners bp ON bp.id = p.busspartnerid::bigint
      LEFT JOIN LATERAL (
        SELECT finalquotation FROM projectquotations
        WHERE projectid = p.id ORDER BY quotationdate DESC NULLS LAST, id DESC LIMIT 1
      ) q ON true
      LEFT JOIN invoicingprojectrelease r ON r.projectid = p.id
      LEFT JOIN invoices i ON i.projectid = p.id::double precision
      LEFT JOIN invoicesdetails d ON d.invoiceid = i.id
      WHERE p.notinvoiceable IS NOT TRUE
      GROUP BY p.id, ent.entitydesc, ps.projectstatusdesc, bp.bpname, q.finalquotation,
               r.proceedtoinvoice, r.scheduletypeid, r.numberofinvoices,
               r.firstdate, r.lastdate, r.invpaymethodid
      ORDER BY p.projectnumber DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/invoicing/projects] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/invoicing/projects/:projectId/release
router.get("/projects/:projectId/release", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT projectid, proceedtoinvoice, invpaymethodid, scheduletypeid,
              numberofinvoices, firstdate, lastdate, updatedat, updatedby
       FROM invoicingprojectrelease WHERE projectid = $1`,
      [req.params.projectId]
    );
    res.json(rows[0] || null);
  } catch (err) {
    console.error("[GET /api/invoicing/projects/:projectId/release] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// PATCH /api/invoicing/projects/:projectId/release — upsert (Access's
// ProceedToInvoice.frm save: insert if never released, else update).
router.patch("/projects/:projectId/release", async (req, res) => {
  const { projectId } = req.params;
  const { proceedToInvoice, invPayMethodId, scheduleTypeId, numberOfInvoices, firstDate, lastDate, employeeId } = req.body || {};
  try {
    const existing = await pool.query(`SELECT id FROM invoicingprojectrelease WHERE projectid = $1`, [projectId]);
    if (existing.rows.length) {
      await pool.query(
        `UPDATE invoicingprojectrelease SET
           proceedtoinvoice = COALESCE($1, proceedtoinvoice),
           invpaymethodid = $2, scheduletypeid = $3, numberofinvoices = $4,
           firstdate = $5::date, lastdate = $6::date,
           updatedat = now(), updatedby = $7
         WHERE id = $8`,
        [proceedToInvoice ?? null, invPayMethodId || null, scheduleTypeId || null, numberOfInvoices || null,
         firstDate || null, lastDate || null, employeeId || null, existing.rows[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO invoicingprojectrelease
           (projectid, proceedtoinvoice, invpaymethodid, scheduletypeid, numberofinvoices, firstdate, lastdate, updatedat, updatedby)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, now(), $8)`,
        [projectId, !!proceedToInvoice, invPayMethodId || null, scheduleTypeId || null, numberOfInvoices || null,
         firstDate || null, lastDate || null, employeeId || null]
      );
    }
    res.status(204).end();
    invoiceProjectCode(projectId).then((label) =>
      logAudit(req, {
        kind: "invoice.release",
        desc: `Proceed-to-invoice settings saved for ${label} (proceed: ${proceedToInvoice ? "yes" : "no"})`,
      })
    );
  } catch (err) {
    console.error("[PATCH /api/invoicing/projects/:projectId/release] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/invoicing/projects/:projectId/invoices
router.get("/projects/:projectId/invoices", async (req, res) => {
  try {
    await ensureInvoicingSchema();
    const { rows } = await pool.query(
      `SELECT i.id, i.invoicecode, i.invoicestatusid, ist.statusdesc AS "statusLabel",
              i.invoiceyear, i.invoiceseq, i.iscorrective, i.sourceinvoiceid,
              d.amount, d.invoicedate, d.invoiceduedate, d.invoicesentdate, d.invoicedipositdate,
              d.numocclient, d.purchaseorder, d.descriptionservice, d.invoicecomments,
              d.vatid, vt.vatdescription_short_en AS "vatLabel", d.vatamount,
              d.busspartnertoinvoiceid, tc.taxcompanyname AS "invoicingPartnerLabel",
              d.dipositaccountid,
              COALESCE(d.currency, 'EUR') AS currency,
              d.updatedat AS "updatedAt", d.updatedby AS "updatedById",
              NULLIF(TRIM(CONCAT(ue.employeefirstname, ' ', ue.employeelastname)), '') AS "updatedByName",
              d.emailedat AS "emailedAt", COALESCE(d.emailedcount, 0) AS "emailedCount", d.emailedto AS "emailedTo",
              NULLIF(TRIM(CONCAT(ee.employeefirstname, ' ', ee.employeelastname)), '') AS "emailedByName",
              COALESCE(li.items, '[]'::json) AS "lineItems"
       FROM invoices i
       LEFT JOIN invoicesdetails d ON d.invoiceid = i.id
       LEFT JOIN invoicesstatus ist ON ist.id = i.invoicestatusid::bigint
       LEFT JOIN invoices_vattypes vt ON vt.id = d.vatid
       LEFT JOIN taxcompanies tc ON tc.id = d.busspartnertoinvoiceid::bigint
       LEFT JOIN employees ue ON ue.id = d.updatedby
       LEFT JOIN employees ee ON ee.id = d.emailedby
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object(
                  'id', l.id, 'description', l.description,
                  'quantity', l.quantity, 'unitPrice', l.unitprice
                ) ORDER BY l.sortorder, l.id) AS items
         FROM invoicelineitems l WHERE l.invoiceid = i.id
       ) li ON true
       WHERE i.projectid = $1::double precision
       ORDER BY i.invoiceyear DESC NULLS LAST, i.invoiceseq DESC NULLS LAST, i.id DESC`,
      [req.params.projectId]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/invoicing/projects/:projectId/invoices] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/invoicing/invoices — every invoice across all projects, for the
// dashboard's "Invoice view" tab. One flat row per invoice with the tax
// company it's billed to, its project, amount, status, "sent" markers,
// last-updated stamp, and (for correctives) the code + record of the
// invoice it replaces. Ordered most-recently-updated first.
router.get("/invoices", requireModuleAccess("invoicing"), async (req, res) => {
  try {
    await ensureInvoicingSchema();
    const { rows } = await pool.query(`
      SELECT i.id, i.invoicecode, i.invoicestatusid, ist.statusdesc AS "statusLabel",
             i.iscorrective, i.sourceinvoiceid AS "sourceInvoiceId",
             src.invoicecode AS "sourceInvoiceCode", sp.id::text AS "sourceProjectId",
             d.amount, COALESCE(d.currency, 'EUR') AS currency,
             d.descriptionservice,
             d.busspartnertoinvoiceid AS "taxCompanyId",
             tc.taxcompanyname AS "taxCompanyName",
             tc.businesspartnerid AS "taxCompanyBpId",
             d.emailedat AS "emailedAt", COALESCE(d.emailedcount, 0) AS "emailedCount",
             d.emailedto AS "emailedTo",
             NULLIF(TRIM(CONCAT(ee.employeefirstname, ' ', ee.employeelastname)), '') AS "emailedByName",
             d.updatedat AS "updatedAt",
             NULLIF(TRIM(CONCAT(ue.employeefirstname, ' ', ue.employeelastname)), '') AS "updatedByName",
             p.id::text AS "projectId", p.projectnumber AS "projectCode", p.projectname AS "projectName",
             p.busspartnerid AS "projectBpId", pbp.bpname AS "projectBpName",
             ent.entitydesc AS "entityLabel"
      FROM invoices i
      LEFT JOIN invoicesdetails d ON d.invoiceid = i.id
      LEFT JOIN invoicesstatus ist ON ist.id = i.invoicestatusid::bigint
      LEFT JOIN invoices src ON src.id = i.sourceinvoiceid
      LEFT JOIN projects sp ON sp.id = src.projectid::bigint
      LEFT JOIN taxcompanies tc ON tc.id = d.busspartnertoinvoiceid::bigint
      LEFT JOIN projects p ON p.id = i.projectid::bigint
      LEFT JOIN businesspartners pbp ON pbp.id = p.busspartnerid::bigint
      LEFT JOIN entity ent ON ent.id = p.entityid::bigint
      LEFT JOIN employees ee ON ee.id = d.emailedby
      LEFT JOIN employees ue ON ue.id = d.updatedby
      ORDER BY d.updatedat DESC NULLS LAST,
               i.invoiceyear DESC NULLS LAST, i.invoiceseq DESC NULLS LAST, i.id DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/invoicing/invoices] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// Loads everything the invoice PDF needs, including the recipient's
// invoicing email and the language that drives its labels
// (tax company's business partner first, then the project's). Returns null
// when the invoice doesn't exist.
async function loadInvoiceForPdf(invoiceId) {
  await ensureInvoicingSchema();
  await ensureEntitySchema();
  const { rows } = await pool.query(
    `SELECT i.id, i.invoicecode,
            d.amount, d.invoicedate, d.invoiceduedate, d.invoicesentdate, d.invoicedipositdate,
            d.numocclient, d.purchaseorder, d.descriptionservice, d.invoicecomments,
            COALESCE(d.currency, 'EUR') AS currency,
            vt.percentage AS "vatPercentage", d.vatamount,
            tc.taxcompanyname AS "taxCompanyName", tc.vatnumber AS "taxCompanyVat",
            tc.emailinvoicing AS "taxCompanyEmail",
            tca.streetname AS "taxCompanyStreet", tca.zipcode AS "taxCompanyZip",
            tca.city AS "taxCompanyCity", co.countrydesc AS "taxCompanyCountry",
            p.projectnumber AS "projectCode", p.projectname AS "projectName",
            ent.entitydesc AS "entityLabel",
            ent.legalname AS "entityLegalName", ent.vatnumber AS "entityVat",
            ent.address AS "entityAddress", ent.emailinvoicing AS "entityEmail",
            ent.webpage AS "entityWeb", ent.logo AS "entityLogo",
            ent.mailtransport AS "entityMailTransport", ent.mailsender AS "entityMailSender",
            d.emailedat AS "emailedAt", COALESCE(d.emailedcount, 0) AS "emailedCount", d.emailedto AS "emailedTo",
            COALESCE(tcbp.languageid, pbp.languageid)::int AS "languageId",
            COALESCE(eba.bankname, ba.bankname) AS "bankName",
            COALESCE(eba.bankaddrline1, ba.bankaddrline1) AS "bankAddressLine1",
            COALESCE(eba.bankaddrline2, ba.bankaddrline2) AS "bankAddressLine2",
            COALESCE(eba.iban, ba.iban) AS iban,
            COALESCE(eba.bicswift, ba.bicswift) AS "bicSwift",
            cur.symbol AS "currencySymbol",
            COALESCE(li.items, '[]'::json) AS "lineItems"
     FROM invoices i
     LEFT JOIN invoicesdetails d ON d.invoiceid = i.id
     LEFT JOIN projects p ON p.id = i.projectid::bigint
     LEFT JOIN businesspartners pbp ON pbp.id = p.busspartnerid::bigint
     LEFT JOIN entity ent ON ent.id = p.entityid::bigint
     LEFT JOIN LATERAL (SELECT * FROM bankaccts WHERE entityid = ent.id ORDER BY id LIMIT 1) eba ON true
     LEFT JOIN invoices_vattypes vt ON vt.id = d.vatid
     LEFT JOIN taxcompanies tc ON tc.id = d.busspartnertoinvoiceid::bigint
     LEFT JOIN businesspartners tcbp ON tcbp.id = tc.businesspartnerid::bigint
     LEFT JOIN taxcompaniesaddresses tca ON tca.taxcompanyid = tc.id
     LEFT JOIN countries co ON co.id = tca.countryid::bigint
     LEFT JOIN bankaccts ba ON ba.acctid = d.dipositaccountid::bigint
     LEFT JOIN invoicecurrencies cur ON cur.code = COALESCE(d.currency, 'EUR')
     LEFT JOIN LATERAL (
       SELECT json_agg(json_build_object(
                'description', l.description, 'quantity', l.quantity, 'unitPrice', l.unitprice
              ) ORDER BY l.sortorder, l.id) AS items
       FROM invoicelineitems l WHERE l.invoiceid = i.id
     ) li ON true
     WHERE i.id = $1`,
    [invoiceId]
  );
  if (!rows.length) return null;
  const row = rows[0];
  const zipCity = [row.taxCompanyZip, row.taxCompanyCity].filter(Boolean).join(" ");
  row.taxCompanyZipCity = row.taxCompanyCountry ? `${zipCity}, (${row.taxCompanyCountry})` : zipCity;
  row.labels = await invoiceLabels(row.languageId);
  return row;
}

// GET /api/invoicing/invoices/:id/pdf — streams the invoice as a PDF,
// styled to match the real HITT invoice template. See lib/invoicePdf.js
// for the letterhead-data caveat (HiTT only, confirmed from a real sample).
router.get("/invoices/:id/pdf", async (req, res) => {
  try {
    const data = await loadInvoiceForPdf(req.params.id);
    if (!data) return res.status(404).json({ error: "not_found" });
    streamInvoicePdf(res, data);
  } catch (err) {
    console.error("[GET /api/invoicing/invoices/:id/pdf] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const splitAddrs = (v) =>
  String(v || "").split(/[;,]/).map((s) => s.trim()).filter(Boolean);

// The mailbox an invoice email is sent from. Per entity (Settings →
// Entities → "Invoice email"), not by entity name. Preference:
//   1. the entity's configured sender mailbox
//   2. the entity's invoicing email
//   3. a server default (GRAPH_MAIL_SENDER, then SMTP_FROM)
const DEFAULT_INVOICE_SENDER = process.env.GRAPH_MAIL_SENDER || process.env.SMTP_FROM || "";
function invoiceSenderFor(data) {
  const d = data || {};
  return d.entityMailSender || d.entityEmail || DEFAULT_INVOICE_SENDER || "";
}

// Which transport carries an invoice email — the entity's configured
// transport (Settings → Entities), else inferred: a sender mailbox that
// isn't in the M365 tenant can't go through Graph, so fall back to SMTP
// when only SMTP is configured, otherwise Graph.
function invoiceMailChannel(data) {
  const explicit = String((data && data.entityMailTransport) || "").trim().toLowerCase();
  if (explicit === "smtp" || explicit === "graph") return explicit;
  if (!graphMailConfigured() && smtpConfigured()) return "smtp";
  return "graph";
}
function invoiceMailReady(channel) {
  return channel === "smtp" ? smtpConfigured() : graphMailConfigured();
}
const MAIL_UNAVAILABLE_MSG = {
  smtp: "Invoice email over SMTP isn't configured on the server — set SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS.",
  graph: "Invoice email over Microsoft Graph isn't configured on the server — the Graph app registration and its Mail.Send permission are required.",
};

// GET /api/invoicing/invoices/:id/email — the prefilled recipient / subject /
// body for the "email this invoice" dialog, in the partner's language.
router.get("/invoices/:id/email", requireModuleAccess("invoicing"), async (req, res) => {
  try {
    const data = await loadInvoiceForPdf(req.params.id);
    if (!data) return res.status(404).json({ error: "not_found" });
    const tokens = { InvoiceCode: data.invoicecode || "", Entity: data.entityLabel || data.entityLegalName || "" };
    const channel = invoiceMailChannel(data);
    res.json({
      from: invoiceSenderFor(data),
      to: data.taxCompanyEmail || "",
      subject: fillTemplate(data.labels.get("strSubject", "[{Entity}] New invoice"), tokens),
      body: fillTemplate(
        data.labels.get("strBody", "Please find attached invoice {InvoiceCode}."),
        tokens
      ),
      invoiceCode: data.invoicecode || null,
      languageId: data.languageId,
      channel,
      mailConfigured: invoiceMailReady(channel),
      emailedAt: data.emailedAt || null,
      emailedCount: Number(data.emailedCount) || 0,
      emailedTo: data.emailedTo || null,
    });
  } catch (err) {
    console.error("[GET /api/invoicing/invoices/:id/email] error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// POST /api/invoicing/invoices/:id/email  { to, cc, subject, body }
// Renders the invoice PDF and sends it as an attachment. FHiTT invoices go
// over SMTP (lib/mailer.js), everything else through Microsoft Graph
// (lib/graph.js). All four body fields are optional — anything omitted
// falls back to the language-aware default.
router.post("/invoices/:id/email", requireModuleAccess("invoicing"), async (req, res) => {
  let data;
  try {
    data = await loadInvoiceForPdf(req.params.id);
  } catch (err) {
    console.error("[POST /api/invoicing/invoices/:id/email] load error:", err.message);
    return res.status(502).json({ error: "database_unreachable", message: err.message });
  }
  if (!data) return res.status(404).json({ error: "not_found" });

  const channel = invoiceMailChannel(data);
  if (!invoiceMailReady(channel)) {
    return res.status(503).json({ error: "mail_unavailable", message: MAIL_UNAVAILABLE_MSG[channel] });
  }

  try {
    const tokens = { InvoiceCode: data.invoicecode || "", Entity: data.entityLabel || data.entityLegalName || "" };
    const to = splitAddrs(req.body?.to || data.taxCompanyEmail);
    const cc = splitAddrs(req.body?.cc);
    if (!to.length) {
      return res.status(400).json({
        error: "no_recipient",
        message: "No recipient — add an invoicing email to the tax company, or type one in.",
      });
    }
    const bad = [...to, ...cc].find((a) => !EMAIL_RE.test(a));
    if (bad) {
      return res.status(400).json({ error: "bad_email", message: `"${bad}" doesn't look like an email address.` });
    }

    const subject =
      (typeof req.body?.subject === "string" && req.body.subject.trim()) ||
      fillTemplate(data.labels.get("strSubject", "[{Entity}] New invoice"), tokens);
    const body =
      (typeof req.body?.body === "string" && req.body.body.trim()) ||
      fillTemplate(data.labels.get("strBody", "Please find attached invoice {InvoiceCode}."), tokens);

    let pdf;
    try {
      pdf = await renderInvoicePdfBuffer(data);
    } catch (err) {
      console.error("[POST /invoices/:id/email] pdf render failed:", err.message);
      return res.status(500).json({ error: "pdf_failed", message: "Could not render the invoice PDF." });
    }

    const from = invoiceSenderFor(data);
    const mailArgs = {
      from,
      to,
      cc,
      subject,
      text: body,
      attachments: [
        { filename: `${data.invoicecode || "invoice"}.pdf`, contentType: "application/pdf", content: pdf },
      ],
    };
    try {
      if (channel === "smtp") await sendSmtpMail(mailArgs);
      else await sendMail(mailArgs);
    } catch (err) {
      console.error(`[POST /invoices/:id/email] send failed (${channel}):`, err.message);
      return res.status(502).json({
        error: "send_failed",
        message: "The email could not be sent — check the server's mail configuration and logs.",
      });
    }

    const recipients = [...to, ...cc].join(", ");
    const sentAt = new Date().toISOString();
    try {
      await pool.query(
        `UPDATE invoicesdetails
            SET emailedat = now(), emailedby = $2, emailedto = $3,
                emailedcount = COALESCE(emailedcount, 0) + 1
          WHERE invoiceid = $1`,
        [req.params.id, req.hittUser.employeeId || null, recipients.slice(0, 500)]
      );
    } catch (err) {
      // The mail already went out — don't fail the request over the marker.
      console.error("[POST /invoices/:id/email] could not record the send:", err.message);
    }

    res.json({ sent: true, from, to, cc, emailedAt: sentAt });
    logAudit(req, {
      kind: "invoice.email",
      desc: `Emailed invoice ${data.invoicecode || `#${req.params.id}`} from ${from} to ${recipients} (${channel})`,
      level: 2,
    });
  } catch (err) {
    console.error("[POST /api/invoicing/invoices/:id/email] error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

async function computeVat(client, amount, vatId) {
  const vt = await client.query(`SELECT percentage FROM invoices_vattypes WHERE id = $1`, [vatId || 4]);
  const pct = Number(vt.rows[0]?.percentage ?? 0);
  const vatAmount = amount ? Math.round(Number(amount) * (pct / 100) * 100) / 100 : 0;
  return { pct, vatAmount };
}

async function computeStatus(client, invoiceDate, invoiceSentDate, invoiceDipositDate) {
  const { rows } = await client.query(
    `SELECT set_new_invoice_status($1::date, $2::date, $3::date) AS status`,
    [invoiceDate || null, invoiceSentDate || null, invoiceDipositDate || null]
  );
  return rows[0].status;
}

// Line items — normalize the client payload, compute the invoice amount
// from them, and persist. Returns null when `lineItems` wasn't sent at all
// (legacy callers that still post a flat `amount`).
function normalizeLineItems(lineItems) {
  if (!Array.isArray(lineItems)) return null;
  return lineItems
    .map((li) => ({
      description: (li && li.description != null ? String(li.description) : "").trim() || null,
      quantity: Number(li && li.quantity),
      unitPrice: Number(li && li.unitPrice),
    }))
    .filter((li) => li.description || li.quantity || li.unitPrice)
    .map((li) => ({
      description: li.description,
      quantity: Number.isFinite(li.quantity) ? li.quantity : 0,
      unitPrice: Number.isFinite(li.unitPrice) ? li.unitPrice : 0,
    }));
}
function lineItemsTotal(items) {
  return Math.round(items.reduce((s, li) => s + li.quantity * li.unitPrice, 0) * 100) / 100;
}
async function writeLineItems(client, invoiceId, items) {
  await client.query(`DELETE FROM invoicelineitems WHERE invoiceid = $1`, [invoiceId]);
  for (let i = 0; i < items.length; i++) {
    await client.query(
      `INSERT INTO invoicelineitems (invoiceid, sortorder, description, quantity, unitprice)
       VALUES ($1, $2, $3, $4, $5)`,
      [invoiceId, i, items[i].description, items[i].quantity, items[i].unitPrice]
    );
  }
}

// POST /api/invoicing/projects/:projectId/invoices — create (regular or
// corrective). A corrective invoice auto-cancels its source invoice.
router.post("/projects/:projectId/invoices", async (req, res) => {
  const { projectId } = req.params;
  const {
    isCorrective, sourceInvoiceId, invoiceDate, invoiceDueDate, invoiceSentDate, invoiceDipositDate,
    amount, vatId, numOcClient, purchaseOrder, descriptionService, invoiceComments,
    taxCompanyId, dipositAccountId, lineItems, currency,
  } = req.body || {};

  const items = normalizeLineItems(lineItems);
  const effectiveAmount = items ? lineItemsTotal(items) : (amount || null);
  const invCurrency = (currency || "EUR").toString().slice(0, 8);

  const client = await pool.connect();
  try {
    await ensureInvoicingSchema();
    await client.query("BEGIN");

    const proj = await client.query(`SELECT busspartnerid, busspartnertoinvoiceid FROM projects WHERE id = $1`, [projectId]);
    if (!proj.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_found", message: "project not found" });
    }

    const year = new Date(invoiceDate || Date.now()).getFullYear();
    const seqRes = await client.query(
      `SELECT COALESCE(MAX(invoiceseq), 0) + 1 AS next FROM invoices
       WHERE invoiceyear = $1 AND COALESCE(iscorrective, false) = $2`,
      [year, !!isCorrective]
    );
    const seq = Number(seqRes.rows[0].next);
    const code = `${isCorrective ? "R" : ""}${year}-${String(seq).padStart(3, "0")}`;

    const { vatAmount } = await computeVat(client, effectiveAmount, vatId);
    const status = await computeStatus(client, invoiceDate, invoiceSentDate, invoiceDipositDate);

    const invRes = await client.query(
      `INSERT INTO invoices (invoicecode, invoicestatusid, invoiceyear, invoiceseq, iscorrective, sourceinvoiceid, projectid)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [code, status, year, seq, !!isCorrective, sourceInvoiceId || null, projectId]
    );
    const invoiceId = invRes.rows[0].id;

    await client.query(
      `INSERT INTO invoicesdetails
         (invoiceid, amount, invoicedate, invoiceduedate, invoicesentdate, invoicedipositdate,
          numocclient, purchaseorder, descriptionservice, invoicecomments, vatid, vatamount,
          busspartnerid, busspartnertoinvoiceid, dipositaccountid, currency, updatedat, updatedby)
       VALUES ($1, $2, $3::date, $4::date, $5::date, $6::date, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now(), $17)`,
      [
        invoiceId, effectiveAmount, invoiceDate || null, invoiceDueDate || null, invoiceSentDate || null, invoiceDipositDate || null,
        numOcClient || null, purchaseOrder || null, descriptionService || null, invoiceComments || null,
        vatId || 4, vatAmount, proj.rows[0].busspartnerid || null,
        taxCompanyId || proj.rows[0].busspartnertoinvoiceid || null, dipositAccountId || null, invCurrency,
        req.hittUser?.employeeId || null,
      ]
    );

    if (items && items.length) await writeLineItems(client, invoiceId, items);

    if (isCorrective && sourceInvoiceId) {
      await client.query(`UPDATE invoices SET invoicestatusid = 6 WHERE id = $1`, [sourceInvoiceId]);
    }

    await client.query("COMMIT");
    res.status(201).json({ id: invoiceId, invoicecode: code, invoicestatusid: status });
    invoiceProjectCode(projectId).then((label) =>
      logAudit(req, {
        kind: "invoice.create",
        desc: `Created invoice ${code}${isCorrective ? " (corrective)" : ""} for ${label}` +
          (effectiveAmount != null ? `, ${invCurrency} ${Number(effectiveAmount).toLocaleString()}` : ""),
      })
    );
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[POST /api/invoicing/projects/:projectId/invoices] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/invoicing/invoices/:id — edit. Supports partial updates: any
// field not present in the body keeps its current value. Status and VAT
// amount are always recomputed server-side (from the merged, post-update
// values) — never trusted from the client.
router.patch("/invoices/:id", async (req, res) => {
  const { id } = req.params;
  const body = req.body || {};

  const client = await pool.connect();
  try {
    await ensureInvoicingSchema();
    await client.query("BEGIN");

    const current = await client.query(`SELECT * FROM invoicesdetails WHERE invoiceid = $1`, [id]);
    if (!current.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_found" });
    }
    const row = current.rows[0];

    const items = normalizeLineItems(body.lineItems); // null if not sent

    const merged = {
      amount: body.amount !== undefined ? body.amount : row.amount,
      invoiceDate: body.invoiceDate !== undefined ? body.invoiceDate : row.invoicedate,
      invoiceDueDate: body.invoiceDueDate !== undefined ? body.invoiceDueDate : row.invoiceduedate,
      invoiceSentDate: body.invoiceSentDate !== undefined ? body.invoiceSentDate : row.invoicesentdate,
      invoiceDipositDate: body.invoiceDipositDate !== undefined ? body.invoiceDipositDate : row.invoicedipositdate,
      numOcClient: body.numOcClient !== undefined ? body.numOcClient : row.numocclient,
      purchaseOrder: body.purchaseOrder !== undefined ? body.purchaseOrder : row.purchaseorder,
      descriptionService: body.descriptionService !== undefined ? body.descriptionService : row.descriptionservice,
      invoiceComments: body.invoiceComments !== undefined ? body.invoiceComments : row.invoicecomments,
      vatId: body.vatId !== undefined ? body.vatId : row.vatid,
      taxCompanyId: body.taxCompanyId !== undefined ? body.taxCompanyId : row.busspartnertoinvoiceid,
      dipositAccountId: body.dipositAccountId !== undefined ? body.dipositAccountId : row.dipositaccountid,
      currency: body.currency !== undefined ? (body.currency || "EUR") : (row.currency || "EUR"),
    };
    // When line items are sent, they define the invoice amount.
    if (items) merged.amount = lineItemsTotal(items);

    const { vatAmount } = await computeVat(client, merged.amount, merged.vatId);
    const status = await computeStatus(client, merged.invoiceDate, merged.invoiceSentDate, merged.invoiceDipositDate);

    await client.query(
      `UPDATE invoicesdetails SET
         amount = $1, invoicedate = $2::date, invoiceduedate = $3::date,
         invoicesentdate = $4::date, invoicedipositdate = $5::date,
         numocclient = $6, purchaseorder = $7, descriptionservice = $8, invoicecomments = $9,
         vatid = $10, vatamount = $11, busspartnertoinvoiceid = $12, dipositaccountid = $13,
         currency = $16, updatedat = now(), updatedby = $15
       WHERE invoiceid = $14`,
      [
        merged.amount || null, merged.invoiceDate || null, merged.invoiceDueDate || null,
        merged.invoiceSentDate || null, merged.invoiceDipositDate || null,
        merged.numOcClient || null, merged.purchaseOrder || null, merged.descriptionService || null, merged.invoiceComments || null,
        merged.vatId || 4, vatAmount, merged.taxCompanyId || null, merged.dipositAccountId || null, id,
        req.hittUser?.employeeId || null, merged.currency.toString().slice(0, 8),
      ]
    );
    if (items) await writeLineItems(client, id, items);
    await client.query(`UPDATE invoices SET invoicestatusid = $1 WHERE id = $2`, [status, id]);
    const { rows: codeRows } = await client.query(`SELECT invoicecode FROM invoices WHERE id = $1`, [id]);

    await client.query("COMMIT");
    res.json({ invoicestatusid: status, vatamount: vatAmount });
    logAudit(req, {
      kind: "invoice.update",
      desc: `Updated invoice ${codeRows[0]?.invoicecode || `#${id}`}`,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[PATCH /api/invoicing/invoices/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/invoicing/invoices/:id
router.delete("/invoices/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureInvoicingSchema();
    await client.query("BEGIN");
    await client.query(`DELETE FROM invoicelineitems WHERE invoiceid = $1`, [req.params.id]);
    await client.query(`DELETE FROM invoicesdetails WHERE invoiceid = $1`, [req.params.id]);
    const { rows: delRows } = await client.query(`DELETE FROM invoices WHERE id = $1 RETURNING invoicecode`, [req.params.id]);
    await client.query("COMMIT");
    res.status(204).end();
    if (delRows.length) {
      logAudit(req, { kind: "invoice.delete", desc: `Deleted invoice ${delRows[0].invoicecode || `#${req.params.id}`}` });
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[DELETE /api/invoicing/invoices/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
