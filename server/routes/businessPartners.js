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

const router = express.Router();

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
router.get("/", async (req, res) => {
  const q = (req.query.q || "").trim();
  try {
    const { rows } = await pool.query(
      `SELECT bp.id, bp.bpname AS name, bp.webpage,
              ent.entitydesc AS "entityLabel", ct.companytypedesc AS "companyTypeLabel",
              c.countrydesc AS "countryLabel"
       FROM businesspartners bp
       LEFT JOIN entity ent ON ent.id = bp.entityid::bigint
       LEFT JOIN companytypes ct ON ct.id = bp.companytypeid
       LEFT JOIN addresses a ON a.businesspartnerid = bp.id
       LEFT JOIN countries c ON c.id = a.countryid::bigint
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
              a.id AS "addressId", a.streetname, a.city, a.state, a.zipcode,
              a.phonenumber, a.phonenumber2, a.countryid,
              country.countrydesc AS "countryLabel"
       FROM businesspartners bp
       LEFT JOIN entity ent ON ent.id = bp.entityid::bigint
       LEFT JOIN companytypes ct ON ct.id = bp.companytypeid
       LEFT JOIN languages lang ON lang.id = bp.languageid
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
router.post("/", async (req, res) => {
  const { name, entityId, companyTypeId, languageId, webpage, address } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "validation_error", message: "name is required" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO businesspartners (bpname, entityid, companytypeid, languageid, webpage)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, bpname AS name`,
      [name.trim(), entityId || null, companyTypeId || null, languageId || null, webpage || null]
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
    await client.query("COMMIT");
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
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const { name, entityId, companyTypeId, languageId, webpage, address } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE businesspartners SET
         bpname = COALESCE($1, bpname),
         entityid = COALESCE($2, entityid),
         companytypeid = COALESCE($3, companytypeid),
         languageid = COALESCE($4, languageid),
         webpage = COALESCE($5, webpage)
       WHERE id = $6`,
      [name || null, entityId ?? null, companyTypeId ?? null, languageId ?? null, webpage ?? null, id]
    );

    if (address) {
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

    await client.query("COMMIT");
    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[PATCH /api/business-partners/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
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
  const { contactname, position, emailaddress, phonenumber } = req.body || {};
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
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("[POST /api/business-partners/:id/contacts] DB error:", err.message);
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
  } catch (err) {
    console.error("[POST /api/business-partners/:id/notes] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/business-partners/:id/tax-companies — read-only.
router.get("/:id/tax-companies", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tc.id, tc.taxcompanyname, tc.vatnumber, tc.emailinvoicing,
              tca.streetname, tca.city, tca.state, tca.zipcode,
              country.countrydesc AS "countryLabel"
       FROM taxcompanies tc
       LEFT JOIN taxcompaniesaddresses tca ON tca.taxcompanyid = tc.id
       LEFT JOIN countries country ON country.id = tca.countryid::bigint
       WHERE tc.businesspartnerid = $1
       ORDER BY tc.taxcompanyname`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/business-partners/:id/tax-companies] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

module.exports = router;
