/**
 * Veri*Factu — issue flow (phase V2)
 * ---------------------------------------------------------------------------
 * Turns a draft invoice into a legal one:
 *   1. assign a gap-free fiscal number from the entity's series
 *   2. lock it (invoicesdetails.issued_at)
 *   3. when Veri*Factu is on for the entity and auto-submit is left checked,
 *      register it with the AEAT via BOLD and store the response
 *
 * A BOLD/AEAT outage never blocks step 1–2 (AEAT developer FAQ): the invoice
 * is issued, its verifactu_records row stays `pending`, and a background job
 * (phase V4) retries. A hard rejection (bad data) leaves an `error` record
 * with the message; the invoice is still issued — fix the data and retry
 * (isFix) or raise a rectificativa (phase V3).
 *
 * `toOpsInvoice` is a pure transform (rows in → normalised object out) and is
 * unit-tested in scripts/verifactu-issue.test.js. Everything else needs the
 * DB / network.
 * ---------------------------------------------------------------------------
 */
const { pool } = require("../../config/db");
const { logAudit } = require("../audit");
const { buildAltaPayload, normalizeFiscalId, isValidSpanishTaxId } = require("./mapping");
const { configForEntity, featureEnabled } = require("./index");
const { VerifactuError } = require("./errors");

class IssueError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "IssueError";
    this.status = status;
    this.code = code;
  }
}

/** Is the "pre-check recipient NIF with the AEAT on issue" option on? */
async function idCheckEnabled() {
  try {
    const { rows } = await pool.query(`SELECT configvalue FROM appconfig WHERE configkey = 'verifactu.id_check'`);
    return rows[0] && rows[0].configvalue === "true";
  } catch {
    return false;
  }
}

/**
 * Contrast the recipient NIF + name against the AEAT (BOLD /id_check).
 * Only meaningful for a Spanish NIF recipient. Resolves silently on a match
 * or an outage; throws IssueError(422) on a genuine mismatch.
 */
async function runRecipientCheck(ops, cfg) {
  if (!cfg || !cfg.enabled) return;
  const rec = ops.recipient;
  if (!rec || (rec.fiscalIdType && rec.fiscalIdType !== "nif")) return; // foreign — /id_check doesn't apply
  const irsId = normalizeFiscalId(rec.fiscalId);
  if (!irsId || !rec.name) return;
  if (!isValidSpanishTaxId(irsId)) {
    throw new IssueError(422, "recipient_check_failed",
      `The recipient's VAT number "${irsId}" is not a valid Spanish NIF/NIE/CIF — fix it on the tax company, or set its fiscal-ID type if the client is foreign.`);
  }
  try {
    await cfg.provider.idCheck({ irsId, name: rec.name }, { apiKey: cfg.apiKey });
  } catch (err) {
    if (err instanceof VerifactuError) {
      if (err.retryable) return; // AEAT/BOLD unreachable — don't block issuing
      throw new IssueError(422, "recipient_check_failed",
        `The AEAT could not confirm the recipient "${rec.name}" (${irsId}). Check the tax company's name and NIF. (${err.message})`);
    }
    throw err;
  }
}

/** ISO date (YYYY-MM-DD) for a JS date or DB timestamp, in Europe/Madrid. */
function madridDate(d = new Date()) {
  // en-CA gives YYYY-MM-DD; the timeZone pins us to Spain regardless of host TZ.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d instanceof Date ? d : new Date(d));
}

/**
 * Pure: DB rows → the OpsInvoice shape mapping.buildAltaPayload expects.
 * @param {object} r  { invoice, details, entity, taxCompany, vatType, correctedInvoices }
 */
function toOpsInvoice(r) {
  const { invoice, details, entity, taxCompany, vatType } = r;
  if (!details) throw new IssueError(422, "no_details", "invoice has no detail row");

  const issuedDate = details.invoicedate ? madridDate(details.invoicedate) : madridDate();
  const isCorrective = !!invoice.iscorrective;

  let recipient = null;
  if (taxCompany) {
    const foreign = taxCompany.fiscalidtype && taxCompany.fiscalidtype !== "nif";
    recipient = {
      name: taxCompany.taxcompanyname || "",
      fiscalId: taxCompany.vatnumber || "",
      fiscalIdType: foreign ? taxCompany.fiscalidtype : "nif",
      country: foreign ? (taxCompany.fiscalcountry || "") : (taxCompany.fiscalcountry || "ES"),
    };
  }

  const rate = Number(vatType ? vatType.percentage : 0) || 0;
  const net = Number(details.amount) || 0;
  const vat = {
    rate,
    amount: details.vatamount != null ? Number(details.vatamount) : undefined,
    operation: vatType && vatType.verifactu_vatoperation ? vatType.verifactu_vatoperation : undefined,
    key: vatType && vatType.verifactu_vatkey ? vatType.verifactu_vatkey : "01",
  };

  return {
    number: invoice.invoicecode || `DRAFT-${invoice.id}`,
    issuedDate,
    description: (details.descriptionservice || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      || `Factura ${invoice.invoicecode || invoice.id}`,
    type: isCorrective ? "R1" : "F1",
    isCorrective,
    correctedInvoices: (r.correctedInvoices || []).map((c) => ({
      number: c.invoicecode,
      issuedDate: c.invoicedate ? madridDate(c.invoicedate) : issuedDate,
    })),
    issuer: { nif: normalizeFiscalId(entity && entity.vatnumber) },
    recipient,
    net,
    vat,
    total: net + (vat.amount != null ? vat.amount : net * (rate / 100)),
  };
}

/** Load every row toOpsInvoice needs, for one invoice. */
async function loadInvoiceRows(client, invoiceId) {
  const { rows } = await client.query(
    `SELECT
        i.id, i.invoicecode, i.invoiceyear, i.invoiceseq, i.iscorrective,
        i.sourceinvoiceid, i.projectid, i.entityid,
        d.amount, d.invoicedate, d.descriptionservice, d.vatid, d.vatamount,
        d.currency, d.busspartnertoinvoiceid, d.issued_at, d.verifactu_autosubmit,
        p.entityid       AS project_entityid,
        e.id             AS e_id,
        e.vatnumber      AS e_vatnumber,
        e.verifactu_enabled, e.verifactu_api_key, e.verifactu_environment, e.invoice_series,
        tc.taxcompanyname, tc.vatnumber AS tc_vatnumber, tc.fiscalidtype, tc.fiscalcountry,
        vt.percentage, vt.verifactu_vatoperation, vt.verifactu_vatkey, vt.verifactu_exemption_note
      FROM invoices i
      LEFT JOIN invoicesdetails d ON d.invoiceid = i.id
      LEFT JOIN projects p        ON p.id = i.projectid::bigint
      LEFT JOIN entity e          ON e.id = COALESCE(i.entityid, p.entityid::bigint)
      LEFT JOIN taxcompanies tc   ON tc.id = d.busspartnertoinvoiceid::bigint
      LEFT JOIN invoices_vattypes vt ON vt.id = d.vatid
     WHERE i.id = $1`,
    [invoiceId]
  );
  if (!rows.length) throw new IssueError(404, "not_found", "invoice not found");
  const x = rows[0];

  let correctedInvoices = [];
  if (x.iscorrective && x.sourceinvoiceid) {
    const src = await client.query(
      `SELECT i.invoicecode, d.invoicedate
         FROM invoices i LEFT JOIN invoicesdetails d ON d.invoiceid = i.id
        WHERE i.id = $1`,
      [x.sourceinvoiceid]
    );
    correctedInvoices = src.rows;
  }

  return {
    invoice: { id: x.id, invoicecode: x.invoicecode, invoiceyear: x.invoiceyear, invoiceseq: x.invoiceseq,
      iscorrective: x.iscorrective, sourceinvoiceid: x.sourceinvoiceid, projectid: x.projectid,
      entityid: x.entityid || x.project_entityid },
    details: x.amount == null && x.invoicedate == null && x.vatid == null ? null : {
      amount: x.amount, invoicedate: x.invoicedate, descriptionservice: x.descriptionservice,
      vatid: x.vatid, vatamount: x.vatamount, currency: x.currency,
      busspartnertoinvoiceid: x.busspartnertoinvoiceid, issued_at: x.issued_at,
      verifactu_autosubmit: x.verifactu_autosubmit },
    entity: x.e_id ? { id: x.e_id, vatnumber: x.e_vatnumber, verifactu_enabled: x.verifactu_enabled,
      verifactu_api_key: x.verifactu_api_key, verifactu_environment: x.verifactu_environment,
      invoice_series: x.invoice_series } : null,
    taxCompany: x.taxcompanyname != null || x.tc_vatnumber != null ? {
      taxcompanyname: x.taxcompanyname, vatnumber: x.tc_vatnumber,
      fiscalidtype: x.fiscalidtype, fiscalcountry: x.fiscalcountry } : null,
    vatType: x.percentage != null ? {
      percentage: x.percentage, verifactu_vatoperation: x.verifactu_vatoperation,
      verifactu_vatkey: x.verifactu_vatkey, verifactu_exemption_note: x.verifactu_exemption_note } : null,
    correctedInvoices,
    _issuedAt: x.issued_at,
    _autosubmitStored: x.verifactu_autosubmit,
  };
}

/**
 * Next gap-free fiscal number for an entity.
 *   with a series prefix set:  HITT-2026-014   (scoped to the entity)
 *   without one (legacy):      2026-014        (pooled — unchanged behaviour)
 * Correctives get an extra 'R' before the year.
 */
async function nextInvoiceNumber(client, { entityId, year, isCorrective, series }) {
  const r = isCorrective ? "R" : "";
  let seq;
  if (series && entityId != null) {
    const q = await client.query(
      `SELECT COALESCE(MAX(invoiceseq), 0) + 1 AS next
         FROM invoices
        WHERE entityid = $1 AND invoiceyear = $2 AND COALESCE(iscorrective, false) = $3
          AND invoicecode LIKE $4`,
      [entityId, year, !!isCorrective, `${series}-%`]
    );
    seq = Number(q.rows[0].next);
    return { seq, year, code: `${series}-${r}${year}-${String(seq).padStart(3, "0")}` };
  }
  const q = await client.query(
    `SELECT COALESCE(MAX(invoiceseq), 0) + 1 AS next
       FROM invoices
      WHERE invoiceyear = $1 AND COALESCE(iscorrective, false) = $2`,
    [year, !!isCorrective]
  );
  seq = Number(q.rows[0].next);
  return { seq, year, code: `${r}${year}-${String(seq).padStart(3, "0")}` };
}

async function insertRecord(client, invoiceId, { environment, kind = "alta", employeeId }, datos, err) {
  const state = err ? (err.retryable ? "pending" : "error") : (datos ? "sent" : "pending");
  const { rows } = await client.query(
    `INSERT INTO verifactu_records
       (invoiceid, kind, provider, environment, queue_id, request_id, aeat_state,
        error_code, error_text, qr_png, verify_url, chain_hash, record_xml,
        submit_attempts, submitted_at, submitted_by)
     VALUES ($1,$2,'bold',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,now(),$13)
     RETURNING id, aeat_state, queue_id, verify_url, error_text, error_code`,
    [
      invoiceId, kind, environment,
      datos ? String(datos.queueId ?? "") || null : null,
      (datos && datos.requestId) || (err && err.requestId) || null,
      state,
      err ? err.code : null,
      err ? err.message : null,
      datos ? datos.qrcode || null : null,
      datos ? datos.verifactuUrl || null : null,
      datos && datos.chainInfo ? datos.chainInfo.hash || null : null,
      datos ? datos.verifactuXml || null : null,
      employeeId || null,
    ]
  );
  return rows[0];
}

/**
 * Issue invoice `invoiceId`.
 * @param {object} opts { employeeId, autosubmit?: boolean, req? }
 * @returns {Promise<object>} { issued, invoicecode, verifactu?: {state,message,queueId} }
 */
async function issueInvoice(invoiceId, opts = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialise concurrent "issue" calls on the same invoice.
    await client.query(`SELECT 1 FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);
    const r = await loadInvoiceRows(client, invoiceId);
    if (r._issuedAt) throw new IssueError(409, "already_issued", "this invoice has already been issued");

    // Local validation first — a bad invoice stays a draft, no number burned.
    const ops = toOpsInvoice(r);
    // dry run with the provisional number to surface data problems early
    buildAltaPayload(ops);

    const cfg = r.entity ? configForEntity(r.entity) : { enabled: false, reason: "no entity" };

    // Optional AEAT recipient pre-check (Settings → Veri*Factu). Runs before
    // a number is assigned, so a bad recipient leaves the invoice a draft.
    if (cfg.enabled && (await idCheckEnabled())) {
      await runRecipientCheck(ops, cfg);
    }

    const year = Number(ops.issuedDate.slice(0, 4));
    const series = r.entity && r.entity.invoice_series ? r.entity.invoice_series : null;
    // Serialise fiscal-number assignment for this entity (+ the legacy pool
    // when there is no entity) so two invoices can't take the same seq.
    await client.query(`SELECT pg_advisory_xact_lock(812345678, $1)`, [Number(r.invoice.entityid) || 0]);
    const { seq, code } = await nextInvoiceNumber(client, {
      entityId: r.invoice.entityid, year, isCorrective: r.invoice.iscorrective, series,
    });

    const autosubmit = opts.autosubmit === undefined
      ? (r._autosubmitStored == null ? true : !!r._autosubmitStored)
      : !!opts.autosubmit;

    await client.query(
      `UPDATE invoices SET invoicecode = $1, invoiceseq = $2, invoiceyear = $3, entityid = $4 WHERE id = $5`,
      [code, seq, year, r.invoice.entityid || null, invoiceId]
    );
    await client.query(
      `UPDATE invoicesdetails SET issued_at = now(), issued_by = $1, verifactu_autosubmit = $2 WHERE invoiceid = $3`,
      [opts.employeeId || null, autosubmit, invoiceId]
    );
    await client.query("COMMIT");

    const result = { issued: true, invoicecode: code };
    if (opts.req) {
      logAudit(opts.req, { kind: "invoice.issue", desc: `Issued invoice ${code}`, level: 1 });
    }

    // Register — outside the number-assignment transaction (network call).
    if (autosubmit && cfg.enabled) {
      ops.number = code;
      const payload = buildAltaPayload(ops);
      const rec = await registerNow(invoiceId, payload, cfg, opts.employeeId);
      result.verifactu = rec;
      if (opts.req) {
        logAudit(opts.req, {
          kind: rec.state === "error" ? "verifactu.error" : "verifactu.register",
          desc: `Veri*Factu ${rec.state} for ${code}` + (rec.message ? ` — ${rec.message}` : ""),
          level: rec.state === "error" ? 2 : 1,
        });
      }
    } else if (autosubmit && featureEnabled()) {
      result.verifactu = { state: "skipped", message: cfg.reason };
    }
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Call the provider and persist one verifactu_records row. Never throws for a
 *  retryable (unavailable) error — the invoice is already issued. */
async function registerNow(invoiceId, payload, cfg, employeeId, { isFix = false } = {}) {
  let datos = null;
  let vErr = null;
  try {
    datos = await cfg.provider.register(payload, { apiKey: cfg.apiKey, issuerNif: cfg.issuerNif, isFix });
  } catch (e) {
    if (!(e instanceof VerifactuError)) throw e;
    vErr = e;
  }
  const client = await pool.connect();
  try {
    const row = await insertRecord(client, invoiceId, { environment: cfg.environment, employeeId }, datos, vErr);
    return {
      recordId: row.id,
      state: row.aeat_state,
      queueId: row.queue_id || null,
      verifyUrl: row.verify_url || null,
      message: row.error_text || null,
    };
  } finally {
    client.release();
  }
}

// Codes BOLD returns when the invoice is, in effect, already cancelled at
// the AEAT (the queueId was already anulled, or is itself an anulación).
const ALREADY_CANCELLED_CODES = new Set(["000102", "000103"]);

/** Call BOLD's cancel and persist one 'anulacion' verifactu_records row. */
async function sendCancel(invoiceId, queueId, cfg, employeeId) {
  let datos = null;
  let vErr = null;
  try {
    datos = await cfg.provider.cancel(queueId, { apiKey: cfg.apiKey, issuerNif: cfg.issuerNif });
  } catch (e) {
    if (!(e instanceof VerifactuError)) throw e;
    vErr = e;
  }
  const client = await pool.connect();
  try {
    const row = await insertRecord(client, invoiceId, { environment: cfg.environment, kind: "anulacion", employeeId }, datos, vErr);
    return {
      recordId: row.id,
      state: row.aeat_state,
      code: row.error_code || null,
      queueId: row.queue_id || null,
      message: row.error_text || null,
    };
  } finally {
    client.release();
  }
}

/**
 * Cancel (anular) an issued invoice.
 *   - status → 6 (cancelled), always (local)
 *   - when Veri*Factu is on and the invoice has a registered queueId, an
 *     anulación is sent to the AEAT; an outage queues it (retry later), a
 *     hard rejection (other than "already cancelled") leaves the invoice
 *     NOT cancelled and surfaces the error.
 * @param {object} opts { employeeId, req? }
 * @returns {Promise<object>} { cancelled, invoicecode, verifactu?: {...} }
 */
async function cancelInvoice(invoiceId, opts = {}) {
  const client = await pool.connect();
  let r;
  try {
    await client.query("BEGIN");
    await client.query(`SELECT 1 FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);
    r = await loadInvoiceRows(client, invoiceId);
    if (!r._issuedAt) throw new IssueError(409, "not_issued", "only an issued invoice can be cancelled");

    const prior = await client.query(
      `SELECT aeat_state FROM verifactu_records
        WHERE invoiceid = $1 AND kind = 'anulacion'
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [invoiceId]
    );
    if (prior.rows[0] && prior.rows[0].aeat_state === "sent") {
      throw new IssueError(409, "already_cancelled", "this invoice has already been cancelled");
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    throw err;
  }
  client.release();

  const cfg = r.entity ? configForEntity(r.entity) : { enabled: false, reason: "no entity" };

  let queueId = null;
  if (cfg.enabled) {
    const c2 = await pool.connect();
    try {
      const alta = await c2.query(
        `SELECT queue_id FROM verifactu_records
          WHERE invoiceid = $1 AND kind = 'alta' AND queue_id IS NOT NULL
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [invoiceId]
      );
      queueId = alta.rows[0] ? alta.rows[0].queue_id : null;
    } finally {
      c2.release();
    }
  }

  let vfRec = null;
  if (cfg.enabled && queueId) {
    vfRec = await sendCancel(invoiceId, queueId, cfg, opts.employeeId);
    // A genuine hard rejection (not "already cancelled") blocks the cancel.
    if (vfRec.state === "error" && !ALREADY_CANCELLED_CODES.has(vfRec.code)) {
      return { cancelled: false, invoicecode: r.invoice.invoicecode, verifactu: vfRec };
    }
  } else if (featureEnabled() && cfg.enabled) {
    vfRec = { state: "skipped", message: "no AEAT registration to cancel" };
  }

  await pool.query(`UPDATE invoices SET invoicestatusid = 6 WHERE id = $1`, [invoiceId]);

  if (opts.req) {
    logAudit(opts.req, { kind: "invoice.cancel", desc: `Cancelled invoice ${r.invoice.invoicecode}`, level: 2 });
    if (vfRec && vfRec.state && vfRec.state !== "skipped") {
      logAudit(opts.req, {
        kind: vfRec.state === "error" ? "verifactu.error" : "verifactu.cancel",
        desc: `Veri*Factu cancel ${vfRec.state} for ${r.invoice.invoicecode}` + (vfRec.message ? ` — ${vfRec.message}` : ""),
        level: vfRec.state === "error" ? 2 : 1,
      });
    }
  }
  return { cancelled: true, invoicecode: r.invoice.invoicecode, verifactu: vfRec || undefined };
}

/**
 * Register / resend an issued invoice with the AEAT:
 *   - never registered yet (auto-submit was off, or the entity wasn't
 *     enabled at issue time) → a fresh alta, no isFix
 *   - a `pending` / `error` alta → resend with isFix
 *   - a `pending` / `error` anulación → resend the cancellation
 */
async function retryRecord(invoiceId, opts = {}) {
  const client = await pool.connect();
  let r;
  let latest;
  let hasAlta;
  try {
    r = await loadInvoiceRows(client, invoiceId);
    const q = await client.query(
      `SELECT kind FROM verifactu_records
        WHERE invoiceid = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [invoiceId]
    );
    latest = q.rows[0] || null;
    const a = await client.query(
      `SELECT 1 FROM verifactu_records WHERE invoiceid = $1 AND kind = 'alta' LIMIT 1`,
      [invoiceId]
    );
    hasAlta = a.rows.length > 0;
  } finally {
    client.release();
  }
  if (!r._issuedAt) throw new IssueError(409, "not_issued", "invoice is still a draft");
  const cfg = r.entity ? configForEntity(r.entity) : { enabled: false, reason: "no entity" };
  if (!cfg.enabled) throw new IssueError(422, "verifactu_disabled", cfg.reason || "Veri*Factu is not enabled for this entity");

  let rec;
  if (latest && latest.kind === "anulacion") {
    const alta = await pool.query(
      `SELECT queue_id FROM verifactu_records
        WHERE invoiceid = $1 AND kind = 'alta' AND queue_id IS NOT NULL
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [invoiceId]
    );
    const queueId = alta.rows[0] ? alta.rows[0].queue_id : null;
    if (!queueId) throw new IssueError(422, "nothing_to_retry", "no registered invoice to cancel");
    rec = await sendCancel(invoiceId, queueId, cfg, opts.employeeId);
  } else {
    const ops = toOpsInvoice(r);
    ops.number = r.invoice.invoicecode;
    const payload = buildAltaPayload(ops);
    rec = await registerNow(invoiceId, payload, cfg, opts.employeeId, { isFix: hasAlta });
  }

  if (opts.req) {
    logAudit(opts.req, {
      kind: rec.state === "error" ? "verifactu.error" : "verifactu.register",
      desc: `Veri*Factu retry ${rec.state} for ${r.invoice.invoicecode}` + (rec.message ? ` — ${rec.message}` : ""),
      level: rec.state === "error" ? 2 : 1,
    });
  }
  return rec;
}

/**
 * Manually contrast an invoice's recipient with the AEAT (the "Check
 * recipient" button). Never throws for a mismatch — returns { valid, message }.
 */
async function checkRecipient(invoiceId) {
  const client = await pool.connect();
  let r;
  try {
    r = await loadInvoiceRows(client, invoiceId);
  } finally {
    client.release();
  }
  const cfg = r.entity ? configForEntity(r.entity) : { enabled: false, reason: "no entity" };
  if (!cfg.enabled) return { valid: null, message: cfg.reason || "Veri*Factu is not enabled for this entity" };

  const ops = toOpsInvoice(r);
  const rec = ops.recipient;
  if (!rec) return { valid: null, message: "This invoice has no recipient tax company." };
  if (rec.fiscalIdType && rec.fiscalIdType !== "nif") {
    return { valid: null, message: "The recipient is identified by a non-Spanish document — the AEAT NIF check doesn't apply." };
  }
  try {
    await runRecipientCheck(ops, cfg);
    return { valid: true, message: `The AEAT confirmed "${rec.name}".` };
  } catch (err) {
    if (err instanceof IssueError) return { valid: false, message: err.message };
    throw err;
  }
}

module.exports = {
  issueInvoice,
  cancelInvoice,
  retryRecord,
  checkRecipient,
  toOpsInvoice,
  nextInvoiceNumber,
  madridDate,
  featureEnabled,
  IssueError,
};
