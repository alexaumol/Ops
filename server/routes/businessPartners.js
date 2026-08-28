/**
 * /api/business-partners
 * ---------------------------------------------------------------------------
 * Mirrors the Access "BusinessPartner-New_Edit" form + its Contacts/Notes/
 * TaxCompanies subforms. Real schema (confirmed 2026-08-25):
 *
 *   businesspartners   id, bpname, finsitcode, entityid, webpage,
 *                      importid, companytypeid, languageid
 *   addresses          id, businesspartnerid, streetname, city, state,
 *                      zipcode, phonenumber, phonenumber2, countryid
 *                      (one primary address per BP, mirrors the single
 *                      address block on the Access form's General tab)
 *   contacts           id, contactname, position, emailaddress,
 *                      phonenumber, businesspartnerid
 *   businesspartnersnotes  id, notes, employeeid, commentsts, bpid
 *   taxcompanies       id, vatnumber, emailinvoicing, taxcompanyname,
 *                      businesspartnerid
 *   taxcompaniesaddresses  id, taxcompanyid, streetname, city, state,
 *                      zipcode, phonenumber, phonenumber2, countryid,
 *                      sameaddress
 *
 * companytypes/countries/languages are small reference tables (see
 * /lookups). Tax companies are read-only here — Access lets you add one
 * via its own address subform, which is more workflow than this first
 * pass needs; the finance team can still manage those in Access/DB
 * directly until that's worth building.
 * ---------------------------------------------------------------------------
 */
const express = require("express");
const { pool } = require("../config/db");
const { requireModuleAccess } = require("../lib/permissions");
const { logAudit } = require("../lib/audit");

const router = express.Router();

// Resolves a business partner's name for an audit description.
async function bpAuditLabel(id) {
  try {
    const { rows } = await pool.query(`SELECT bpname FROM businesspartners WHERE id = $1`, [id]);
    return rows[0]?.bpname || `#${id}`;
  } catch {
    return `#${id}`;
  }
}

// GET /api/business-partners/lookups
router.get("/lookups", async (req, res) => {
  try {
    const [entities, companyTypes, countries, languages] = await Promise.all([
      pool.query(`SELECT id, entitydesc AS label FROM entity ORDER BY entitydesc`),
      pool.query(`SELECT id, companytypedesc AS label FROM companytypes ORDER BY companytypedesc`),
      pool.query(`SELECT id, countrydesc AS label, topofthelist FROM countries ORDER BY topofthelist DESC, countrydesc`),
      pool.query(`SELECT id, languagedesc AS label FROM languages ORDER BY languagedesc`),
    ]);
    res.json({
      entities: entities.rows,
      companyTypes: companyTypes.rows,
      countries: countries.rows,
      languages: languages.rows,
    });
  } catch (err) {
    console.error("[GET /api/business-partners/lookups] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/business-partners?q=search — list for the search/browse table.
// projectsAlive/projectsDead/projectsTotal power the "Number of projects"
// column (N/M(T) — alive/dead(total)) — "dead" mirrors the Reports/
// stale-projects convention: projectstatus IN ('Closed','Cancelled').
router.get("/", requireModuleAccess("business-partners"), async (req, res) => {
  const q = (req.query.q || "").trim();
  try {
    const { rows } = await pool.query(
      `SELECT bp.id, bp.bpname AS name, bp.webpage,
              ent.entitydesc AS "entityLabel", ct.companytypedesc AS "companyTypeLabel",
              c.countrydesc AS "countryLabel",
              COALESCE(proj.alive, 0) AS "projectsAlive",
              COALESCE(proj.dead, 0) AS "projectsDead",
              COALESCE(proj.total, 0) AS "projectsTotal"
       FROM businesspartners bp
       LEFT JOIN entity ent ON ent.id = bp.entityid::bigint
       LEFT JOIN companytypes ct ON ct.id = bp.companytypeid
       LEFT JOIN addresses a ON a.businesspartnerid = bp.id
       LEFT JOIN countries c ON c.id = a.countryid::bigint
       LEFT JOIN LATERAL (
         SELECT
           COUNT(*) FILTER (WHERE ps.projectstatusdesc NOT IN ('Closed', 'Cancelled')) AS alive,
           COUNT(*) FILTER (WHERE ps.projectstatusdesc IN ('Closed', 'Cancelled')) AS dead,
           COUNT(*) AS total
         FROM projects p
         LEFT JOIN projectstatus ps ON ps.id = p.projectstatusid::bigint
         WHERE p.busspartnerid::bigint = bp.id
       ) proj ON true
       WHERE $1 = '' OR bp.bpname ILIKE '%' || $1 || '%'
       ORDER BY bp.bpname
       LIMIT 500`,
      [q]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/business-partners] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/business-partners/:id — full detail incl. primary address.
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT bp.id, bp.bpname AS name, bp.webpage, bp.finsitcode,
              bp.entityid, ent.entitydesc AS "entityLabel",
              bp.companytypeid, ct.companytypedesc AS "companyTypeLabel",
              bp.languageid, lang.languagedesc AS "languageLabel",
              bp.lastupdated, bp.lastupdatedby,
              NULLIF(TRIM(CONCAT(emp.employeefirstname, ' ', emp.employeelastname)), '') AS "lastUpdatedByName",
              a.id AS "addressId", a.streetname, a.city, a.state, a.zipcode,
              a.phonenumber, a.phonenumber2, a.countryid,
              country.countrydesc AS "countryLabel"
       FROM businesspartners bp
       LEFT JOIN entity ent ON ent.id = bp.entityid::bigint
       LEFT JOIN companytypes ct ON ct.id = bp.companytypeid
       LEFT JOIN languages lang ON lang.id = bp.languageid
       LEFT JOIN employees emp ON emp.id = bp.lastupdatedby
       LEFT JOIN addresses a ON a.businesspartnerid = bp.id
       LEFT JOIN countries country ON country.id = a.countryid::bigint
       WHERE bp.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("[GET /api/business-partners/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// POST /api/business-partners — create (+ optional initial address).
router.post("/", requireModuleAccess("business-partners"), async (req, res) => {
  const { name, entityId, companyTypeId, languageId, webpage, address, employeeId } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "validation_error", message: "name is required" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO businesspartners (bpname, entityid, companytypeid, languageid, webpage, lastupdated, lastupdatedby)
       VALUES ($1, $2, $3, $4, $5, now(), $6)
       RETURNING id, bpname AS name`,
      [name.trim(), entityId || null, companyTypeId || null, languageId || null, webpage || null, employeeId || null]
    );
    const bp = rows[0];
    if (address && (address.streetname || address.city || address.countryid)) {
      await client.query(
        `INSERT INTO addresses (businesspartnerid, streetname, city, state, zipcode, phonenumber, phonenumber2, countryid)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [bp.id, address.streetname || null, address.city || null, address.state || null,
         address.zipcode || null, address.phonenumber || null, address.phonenumber2 || null, address.countryid || null]
      );
    }
    await client.query(
      `INSERT INTO businesspartnerchangelog (businesspartnerid, changedat, changedby, summary) VALUES ($1, now(), $2, $3)`,
      [bp.id, employeeId || null, "Business partner created"]
    );
    await client.query("COMMIT");
    logAudit(req, { kind: "bp.insert", desc: `Created business partner "${bp.name}"` });
    res.status(201).json(bp);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[POST /api/business-partners] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/business-partners/:id — update core fields + upsert address.
// Logs a human-readable summary per changed field to businesspartnerchangelog
// (address fields are collapsed into one "Address updated" entry rather than
// one line per street/city/zip/etc.) — see GET /:id/history, same pattern as
// projects.js's PATCH /:id.
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const { name, entityId, companyTypeId, languageId, webpage, address, employeeId } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: curRows } = await client.query(
      `SELECT bp.bpname, bp.companytypeid, ct.companytypedesc AS "companyTypeLabel",
              bp.languageid, lang.languagedesc AS "languageLabel", bp.webpage,
              a.streetname, a.city, a.state, a.zipcode, a.phonenumber, a.phonenumber2, a.countryid
       FROM businesspartners bp
       LEFT JOIN companytypes ct ON ct.id = bp.companytypeid
       LEFT JOIN languages lang ON lang.id = bp.languageid
       LEFT JOIN addresses a ON a.businesspartnerid = bp.id
       WHERE bp.id = $1
       FOR UPDATE OF bp`,
      [id]
    );
    const cur = curRows[0] || {};
    const changes = [];

    let newCompanyTypeLabel = null, newLanguageLabel = null;
    if (companyTypeId != null && String(companyTypeId) !== String(cur.companytypeid)) {
      const r = await client.query(`SELECT companytypedesc AS label FROM companytypes WHERE id = $1`, [companyTypeId]);
      newCompanyTypeLabel = r.rows[0]?.label ?? null;
    }
    if (languageId != null && String(languageId) !== String(cur.languageid)) {
      const r = await client.query(`SELECT languagedesc AS label FROM languages WHERE id = $1`, [languageId]);
      newLanguageLabel = r.rows[0]?.label ?? null;
    }

    await client.query(
      `UPDATE businesspartners SET
         bpname = COALESCE($1, bpname),
         entityid = COALESCE($2, entityid),
         companytypeid = COALESCE($3, companytypeid),
         languageid = COALESCE($4, languageid),
         webpage = COALESCE($5, webpage),
         lastupdated = now(), lastupdatedby = $6
       WHERE id = $7`,
      [name || null, entityId ?? null, companyTypeId ?? null, languageId ?? null, webpage ?? null, employeeId || null, id]
    );

    if (name !== undefined && name !== cur.bpname) {
      changes.push(`Name changed from "${cur.bpname || ""}" to "${name}"`);
    }
    if (newCompanyTypeLabel !== null) changes.push(`Type of company changed from ${cur.companyTypeLabel || "—"} to ${newCompanyTypeLabel}`);
    if (newLanguageLabel !== null) changes.push(`Language changed from ${cur.languageLabel || "—"} to ${newLanguageLabel}`);
    if (webpage !== undefined && (webpage || null) !== (cur.webpage || null)) {
      changes.push(`Webpage changed from "${cur.webpage || ""}" to "${webpage || ""}"`);
    }

    if (address) {
      const addressChanged =
        (address.streetname || null) !== (cur.streetname || null) ||
        (address.city || null) !== (cur.city || null) ||
        (address.state || null) !== (cur.state || null) ||
        (address.zipcode || null) !== (cur.zipcode || null) ||
        (address.phonenumber || null) !== (cur.phonenumber || null) ||
        (address.phonenumber2 || null) !== (cur.phonenumber2 || null) ||
        String(address.countryid ?? null) !== String(cur.countryid ?? null);
      if (addressChanged) changes.push("Address updated");

      const existing = await client.query(
        `SELECT id FROM addresses WHERE businesspartnerid = $1 LIMIT 1`, [id]
      );
      if (existing.rows.length) {
        await client.query(
          `UPDATE addresses SET
             streetname = $1, city = $2, state = $3, zipcode = $4,
             phonenumber = $5, phonenumber2 = $6, countryid = $7
           WHERE id = $8`,
          [address.streetname || null, address.city || null, address.state || null,
           address.zipcode || null, address.phonenumber || null, address.phonenumber2 || null,
           address.countryid || null, existing.rows[0].id]
        );
      } else {
        await client.query(
          `INSERT INTO addresses (businesspartnerid, streetname, city, state, zipcode, phonenumber, phonenumber2, countryid)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, address.streetname || null, address.city || null, address.state || null,
           address.zipcode || null, address.phonenumber || null, address.phonenumber2 || null, address.countryid || null]
        );
      }
    }

    // Keep every tax-company address that mirrors the BP address in sync
    // with the change (sameaddress = true rows hold a copy — see
    // writeTaxCompanyAddress below and the invoice-PDF join).
    if (address) {
      await client.query(
        `UPDATE taxcompaniesaddresses tca SET
           streetname = $1, city = $2, state = $3, zipcode = $4,
           phonenumber = $5, phonenumber2 = $6, countryid = $7
         FROM taxcompanies tc
         WHERE tc.id = tca.taxcompanyid::bigint
           AND tc.businesspartnerid = $8::double precision
           AND tca.sameaddress IS TRUE`,
        [address.streetname || null, address.city || null, address.state || null,
         address.zipcode || null, address.phonenumber || null, address.phonenumber2 || null,
         address.countryid || null, id]
      );
    }

    for (const summary of changes) {
      await client.query(
        `INSERT INTO businesspartnerchangelog (businesspartnerid, changedat, changedby, summary) VALUES ($1, now(), $2, $3)`,
        [id, employeeId || null, summary]
      );
    }

    await client.query("COMMIT");
    logAudit(req, {
      kind: "bp.update",
      desc: `Updated business partner "${name || cur.bpname || `#${id}`}"` +
        (changes.length ? `: ${changes.join("; ")}` : " (no field changes)"),
    });
    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[PATCH /api/business-partners/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// GET /api/business-partners/:id/history — every logged field change,
// newest first. Powers the edit modal's collapsible History side panel —
// same design/pattern as GET /api/projects/:id/history.
router.get("/:id/history", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.summary, c.changedat AS "changedAt", c.changedby AS "changedBy",
              NULLIF(TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)), '') AS "changedByName"
       FROM businesspartnerchangelog c
       LEFT JOIN employees e ON e.id = c.changedby
       WHERE c.businesspartnerid = $1
       ORDER BY c.changedat DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/business-partners/:id/history] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/business-partners/:id/projects — every project with this BP as
// its contracting business partner. Powers the "Projects" column's
// drill-down button on the main list.
router.get("/:id/projects", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.projectnumber AS code, p.projectname AS name,
              ps.projectstatusdesc AS "statusLabel"
       FROM projects p
       LEFT JOIN projectstatus ps ON ps.id = p.projectstatusid::bigint
       WHERE p.busspartnerid::bigint = $1
       ORDER BY p.projectnumber DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/business-partners/:id/projects] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Contacts / Notes / Tax companies subforms.
// ---------------------------------------------------------------------------

router.get("/:id/contacts", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, contactname, position, emailaddress, phonenumber
       FROM contacts WHERE businesspartnerid = $1 ORDER BY contactname`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/business-partners/:id/contacts] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

router.post("/:id/contacts", async (req, res) => {
  const { contactname, position, emailaddress, phonenumber, employeeId } = req.body || {};
  if (!contactname || !contactname.trim()) {
    return res.status(400).json({ error: "validation_error", message: "contactname is required" });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO contacts (businesspartnerid, contactname, position, emailaddress, phonenumber)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, contactname, position, emailaddress, phonenumber`,
      [req.params.id, contactname.trim(), position || null, emailaddress || null, phonenumber || null]
    );
    await pool.query(
      `INSERT INTO businesspartnerchangelog (businesspartnerid, changedat, changedby, summary) VALUES ($1, now(), $2, $3)`,
      [req.params.id, employeeId || null, `Contact added: ${contactname.trim()}`]
    );
    res.status(201).json(rows[0]);
    bpAuditLabel(req.params.id).then((bp) =>
      logAudit(req, { kind: "bp.contact.add", desc: `BP "${bp}": contact added "${contactname.trim()}"` }));
  } catch (err) {
    console.error("[POST /api/business-partners/:id/contacts] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// PATCH /api/business-partners/:id/contacts/:contactId — edit an existing
// contact (name/position/email/phone). Logs to businesspartnerchangelog.
router.patch("/:id/contacts/:contactId", async (req, res) => {
  const { contactname, position, emailaddress, phonenumber, employeeId } = req.body || {};
  if (!contactname || !contactname.trim()) {
    return res.status(400).json({ error: "validation_error", message: "contactname is required" });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE contacts
       SET contactname = $1, position = $2, emailaddress = $3, phonenumber = $4
       WHERE id = $5 AND businesspartnerid = $6
       RETURNING id, contactname, position, emailaddress, phonenumber`,
      [contactname.trim(), position || null, emailaddress || null, phonenumber || null,
       req.params.contactId, req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: "not_found", message: "Contact not found on this business partner" });
    }
    await pool.query(
      `INSERT INTO businesspartnerchangelog (businesspartnerid, changedat, changedby, summary) VALUES ($1, now(), $2, $3)`,
      [req.params.id, employeeId || null, `Contact updated: ${contactname.trim()}`]
    );
    res.json(rows[0]);
    bpAuditLabel(req.params.id).then((bp) =>
      logAudit(req, { kind: "bp.contact.update", desc: `BP "${bp}": contact updated "${contactname.trim()}"` }));
  } catch (err) {
    console.error("[PATCH /api/business-partners/:id/contacts/:contactId] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// DELETE /api/business-partners/:id/contacts/:contactId
router.delete("/:id/contacts/:contactId", async (req, res) => {
  const { employeeId } = req.body || {};
  try {
    const { rows } = await pool.query(
      `DELETE FROM contacts WHERE id = $1 AND businesspartnerid = $2 RETURNING contactname`,
      [req.params.contactId, req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: "not_found", message: "Contact not found on this business partner" });
    }
    await pool.query(
      `INSERT INTO businesspartnerchangelog (businesspartnerid, changedat, changedby, summary) VALUES ($1, now(), $2, $3)`,
      [req.params.id, employeeId || null, `Contact removed: ${rows[0].contactname || "—"}`]
    );
    res.status(204).end();
    bpAuditLabel(req.params.id).then((bp) =>
      logAudit(req, { kind: "bp.contact.delete", desc: `BP "${bp}": contact removed "${rows[0].contactname || "—"}"` }));
  } catch (err) {
    console.error("[DELETE /api/business-partners/:id/contacts/:contactId] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

router.get("/:id/notes", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT n.id, n.notes, n.commentsts, n.employeeid,
              NULLIF(TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)), '') AS "authorName"
       FROM businesspartnersnotes n
       LEFT JOIN employees e ON e.id = n.employeeid::bigint
       WHERE n.bpid = $1
       ORDER BY n.commentsts DESC NULLS LAST, n.id DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/business-partners/:id/notes] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

router.post("/:id/notes", async (req, res) => {
  const { notes, employeeId } = req.body || {};
  if (!notes || !notes.trim()) {
    return res.status(400).json({ error: "validation_error", message: "notes text is required" });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO businesspartnersnotes (bpid, notes, employeeid, commentsts)
       VALUES ($1, $2, $3, now())
       RETURNING id, notes, commentsts, employeeid`,
      [req.params.id, notes.trim(), employeeId || null]
    );
    res.status(201).json(rows[0]);
    const preview = notes.trim().length > 80 ? `${notes.trim().slice(0, 80)}…` : notes.trim();
    bpAuditLabel(req.params.id).then((bp) =>
      logAudit(req, { kind: "bp.note.add", desc: `BP "${bp}": note added — "${preview}"` }));
  } catch (err) {
    console.error("[POST /api/business-partners/:id/notes] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// Upserts a tax company's single address row. `sameAddress` true → copy the
// BP's current address and flag sameaddress=true (kept in sync by the BP
// PATCH handler, and read directly by the invoice-PDF query). false → store
// the address the user entered. Runs on the caller's transaction client.
async function writeTaxCompanyAddress(client, tcId, bpId, sameAddress, address) {
  let addr = address || {};
  if (sameAddress) {
    const { rows } = await client.query(
      `SELECT streetname, city, state, zipcode, phonenumber, phonenumber2, countryid
       FROM addresses WHERE businesspartnerid = $1::double precision LIMIT 1`,
      [bpId]
    );
    addr = rows[0] || {};
  }
  const vals = [
    addr.streetname || null, addr.city || null, addr.state || null, addr.zipcode || null,
    addr.phonenumber || null, addr.phonenumber2 || null, addr.countryid || null, !!sameAddress,
  ];
  const existing = await client.query(
    `SELECT id FROM taxcompaniesaddresses WHERE taxcompanyid = $1::double precision ORDER BY id LIMIT 1`,
    [tcId]
  );
  if (existing.rows.length) {
    await client.query(
      `UPDATE taxcompaniesaddresses SET
         streetname=$1, city=$2, state=$3, zipcode=$4,
         phonenumber=$5, phonenumber2=$6, countryid=$7, sameaddress=$8
       WHERE id = $9`,
      [...vals, existing.rows[0].id]
    );
  } else {
    await client.query(
      `INSERT INTO taxcompaniesaddresses
         (taxcompanyid, streetname, city, state, zipcode, phonenumber, phonenumber2, countryid, sameaddress)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [tcId, ...vals]
    );
  }
}

// GET /api/business-partners/:id/tax-companies
router.get("/:id/tax-companies", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tc.id, tc.taxcompanyname, tc.vatnumber, tc.emailinvoicing,
              tca.id AS "addressId", COALESCE(tca.sameaddress, true) AS "sameAddress",
              tca.streetname, tca.city, tca.state, tca.zipcode,
              tca.phonenumber, tca.phonenumber2, tca.countryid,
              country.countrydesc AS "countryLabel"
       FROM taxcompanies tc
       LEFT JOIN LATERAL (
         SELECT * FROM taxcompaniesaddresses
         WHERE taxcompanyid = tc.id::double precision ORDER BY id LIMIT 1
       ) tca ON true
       LEFT JOIN countries country ON country.id = tca.countryid::bigint
       WHERE tc.businesspartnerid = $1::double precision
       ORDER BY tc.taxcompanyname`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/business-partners/:id/tax-companies] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// POST /api/business-partners/:id/tax-companies — add an invoicing entity
// for this business partner (mirrors TaxCompanies_BP.frm).
router.post("/:id/tax-companies", async (req, res) => {
  const { taxcompanyname, vatnumber, emailinvoicing, sameAddress, address } = req.body || {};
  if (!taxcompanyname || !taxcompanyname.trim()) {
    return res.status(400).json({ error: "validation_error", message: "taxcompanyname is required" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO taxcompanies (businesspartnerid, taxcompanyname, vatnumber, emailinvoicing)
       VALUES ($1, $2, $3, $4)
       RETURNING id, taxcompanyname, vatnumber, emailinvoicing`,
      [req.params.id, taxcompanyname.trim(), vatnumber || null, emailinvoicing || null]
    );
    const taxCompany = rows[0];
    await writeTaxCompanyAddress(client, taxCompany.id, req.params.id, sameAddress, address);
    await client.query("COMMIT");
    res.status(201).json(taxCompany);
    bpAuditLabel(req.params.id).then((bp) =>
      logAudit(req, { kind: "bp.taxcompany.add", desc: `BP "${bp}": tax company added "${taxCompany.taxcompanyname}"` }));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[POST /api/business-partners/:id/tax-companies] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/business-partners/:id/tax-companies/:tcId — edit name/VAT/email
// and the address (same-as-BP toggle + fields).
router.patch("/:id/tax-companies/:tcId", async (req, res) => {
  const { taxcompanyname, vatnumber, emailinvoicing, sameAddress, address } = req.body || {};
  if (!taxcompanyname || !taxcompanyname.trim()) {
    return res.status(400).json({ error: "validation_error", message: "taxcompanyname is required" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      `UPDATE taxcompanies SET taxcompanyname = $1, vatnumber = $2, emailinvoicing = $3
       WHERE id = $4 AND businesspartnerid = $5::double precision`,
      [taxcompanyname.trim(), vatnumber || null, emailinvoicing || null, req.params.tcId, req.params.id]
    );
    if (!rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_found", message: "Tax company not found on this business partner" });
    }
    await writeTaxCompanyAddress(client, req.params.tcId, req.params.id, sameAddress, address);
    await client.query("COMMIT");
    res.status(204).end();
    bpAuditLabel(req.params.id).then((bp) =>
      logAudit(req, { kind: "bp.taxcompany.update", desc: `BP "${bp}": tax company updated "${taxcompanyname.trim()}"` }));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[PATCH /api/business-partners/:id/tax-companies/:tcId] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/business-partners/:id/tax-companies/:tcId — blocked while the
// tax company is assigned to a project or referenced by an invoice.
router.delete("/:id/tax-companies/:tcId", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inUse = await client.query(
      `SELECT
         EXISTS(SELECT 1 FROM projects WHERE busspartnertoinvoiceid::bigint = $1::bigint) AS "inProjects",
         EXISTS(SELECT 1 FROM invoicesdetails WHERE busspartnertoinvoiceid::bigint = $1::bigint) AS "inInvoices"`,
      [req.params.tcId]
    );
    if (inUse.rows[0].inProjects || inUse.rows[0].inInvoices) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "conflict",
        message: "This tax company is used by a project or an invoice and can't be deleted.",
      });
    }
    await client.query(`DELETE FROM taxcompaniesaddresses WHERE taxcompanyid = $1::double precision`, [req.params.tcId]);
    const { rows } = await client.query(
      `DELETE FROM taxcompanies WHERE id = $1 AND businesspartnerid = $2::double precision RETURNING taxcompanyname`,
      [req.params.tcId, req.params.id]
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_found", message: "Tax company not found on this business partner" });
    }
    await client.query("COMMIT");
    res.status(204).end();
    bpAuditLabel(req.params.id).then((bp) =>
      logAudit(req, { kind: "bp.taxcompany.delete", desc: `BP "${bp}": tax company removed "${rows[0].taxcompanyname || "—"}"` }));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[DELETE /api/business-partners/:id/tax-companies/:tcId] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
