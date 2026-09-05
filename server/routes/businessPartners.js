/**
 * /api/customers-partners
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
 *
 * CRM Phase C1 (see docs/customers-crm-roadmap.md, docs/customers-crm-
 * alignment.md) added, on top of the schema above:
 *
 *   businesspartners       + roles (text[]), category, lifecycle_stage,
 *                           temperature, owner_employeeid, lead_source,
 *                           geo_scope, archived_at
 *   businesspartner_stage_history  one row per lifecycle_stage transition
 *                           (from/to/reason), mirrors businesspartnerchangelog
 *   contact_org_roles      the person↔organization relationship: position,
 *                           is_primary, decision_role, influence, stance,
 *                           reports_to_contactid. contacts.businesspartnerid
 *                           stays as the legacy "primary org" pointer the
 *                           routes below still read/write for name/email/
 *                           phone; contact_org_roles is the source of truth
 *                           for the relationship fields layered on top.
 *
 * CRM Phase C2 added crm_activities + crm_activity_participants — the
 * communication timeline (/:id/activities below). Tasks are a *separate*,
 * platform-wide module (see routes/tasks.js, mounted at /api/tasks) —
 * deliberately not nested here, since a task can attach to a project or
 * (later) a Programme Operations cohort too, not just a customer/partner.
 *
 * CRM Phase C3 added crm_opportunities + crm_opportunity_stage_history —
 * the pre-project funnel (/:id/opportunities below), plus
 * projects.estimated_value/currencyid. "Convert to project" is the one
 * action that matters: past that point the opportunity is read-only and
 * the project (Lead/Oferta/Guanyat board) is the record of truth — see
 * docs/customers-crm-alignment.md §3.5.
 *
 * CRM Phase C4 (first slice) added crm_tags + crm_partner_tags — free,
 * many-per-partner tags layered on top of the single `category` from
 * Phase C1 (/tags and /:id/tags below). The rest of Phase C4 (saved
 * segments, bulk actions, merge-duplicates, CSV import) is not built yet.
 *
 * Mounted at /api/customers-partners (canonical) and /api/business-partners
 * (kept working, server.js) — the module is "Customers & partners" now
 * (roadmap §4); this file and its internal table/column names weren't
 * renamed, since nothing outside this comment reads the file name and the
 * schema names are a much larger, separate exercise.
 * ---------------------------------------------------------------------------
 */
const express = require("express");
const { pool } = require("../config/db");
const { requireModuleAccess, requireAdmin } = require("../lib/permissions");
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

// One line in the edit modal's History panel (GET /:id/history). `changedby`
// is the authenticated user (req.hittUser), not a body param.
async function logBpChange(runner, bpId, req, summary) {
  await runner.query(
    `INSERT INTO businesspartnerchangelog (businesspartnerid, changedat, changedby, summary) VALUES ($1, now(), $2, $3)`,
    [bpId, req.hittUser?.employeeId || null, summary]
  );
}

// Records a lifecycle_stage transition (businesspartner_stage_history) and
// mirrors it into the plain-text change log so it shows up in the same
// History panel as everything else.
async function logStageChange(runner, bpId, req, fromStage, toStage, reason) {
  await runner.query(
    `INSERT INTO businesspartner_stage_history (businesspartnerid, from_stage, to_stage, changedat, changedby, reason)
     VALUES ($1, $2, $3, now(), $4, $5)`,
    [bpId, fromStage || null, toStage, req.hittUser?.employeeId || null, reason || null]
  );
  await logBpChange(runner, bpId, req, `Stage changed from ${fromStage || "—"} to ${toStage}` + (reason ? ` — ${reason}` : ""));
}

// appconfig "crm.visibility_all" (Settings, see routes/settings.js
// CONFIG_KEYS) — off (default) restricts the list/detail to a caller's own
// business partners (owner_employeeid) plus unowned ones, on shows everyone
// to everyone. Same "on"/"off" convention as every other boolean appconfig
// key (see lib/externalSync.js getSyncConfig). Table-missing / DB hiccup
// fails to the safer, more restrictive default.
async function crmVisibilityAll() {
  try {
    const { rows } = await pool.query(`SELECT configvalue FROM appconfig WHERE configkey = 'crm.visibility_all'`);
    return rows[0]?.configvalue === "on";
  } catch {
    return false;
  }
}

// Loads a partner's owner + archived state and 403s/404s if the caller
// shouldn't see it under the current visibility setting. Admins and the
// owner always pass; an unowned partner is visible to anyone (so it can be
// claimed). Returns the row (owner_employeeid, archived_at) on success, or
// null after already sending a response.
async function loadVisiblePartner(req, res, bpId) {
  const { rows } = await pool.query(
    `SELECT id, owner_employeeid AS "ownerEmployeeId", archived_at AS "archivedAt" FROM businesspartners WHERE id = $1`,
    [bpId]
  );
  if (!rows.length) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  const bp = rows[0];
  if (req.hittUser?.isAdmin) return bp;
  const callerId = req.hittUser?.employeeId || null;
  // No resolved identity (stub/header auth typo) fails open here too, same
  // as canAccessModule() — an unrecognized caller isn't "someone else",
  // there's just nothing to restrict against yet.
  if (callerId && bp.ownerEmployeeId && String(bp.ownerEmployeeId) !== String(callerId) && !(await crmVisibilityAll())) {
    res.status(403).json({ error: "forbidden", message: "This customer/partner is owned by someone else." });
    return null;
  }
  return bp;
}

// GET /api/customers-partners/lookups
router.get("/lookups", async (req, res) => {
  try {
    const [entities, companyTypes, countries, languages, currencies] = await Promise.all([
      pool.query(`SELECT id, entitydesc AS label FROM entity ORDER BY entitydesc`),
      pool.query(`SELECT id, companytypedesc AS label FROM companytypes ORDER BY companytypedesc`),
      pool.query(`SELECT id, countrydesc AS label, topofthelist FROM countries ORDER BY topofthelist DESC, countrydesc`),
      pool.query(`SELECT id, languagedesc AS label FROM languages ORDER BY languagedesc`),
      // CRM Phase C3 — the opportunity form's currency picker, same table
      // invoicing already uses (server/routes/invoicing.js GET /lookups).
      pool.query(`SELECT id, code, symbol, label FROM invoicecurrencies ORDER BY sortorder, (code = 'EUR') DESC, code`),
    ]);
    res.json({
      entities: entities.rows,
      companyTypes: companyTypes.rows,
      countries: countries.rows,
      languages: languages.rows,
      currencies: currencies.rows,
    });
  } catch (err) {
    console.error("[GET /api/customers-partners/lookups] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Tags — CRM Phase C4 (first slice). Free, many-per-partner, global list —
// registered here (before /:id below) so Express matches "/tags" literally
// instead of capturing it as an :id. businesspartners.category (Phase C1)
// stays the single primary category; tags are the flexible layer on top —
// see docs/customers-crm-alignment.md §3.2.
// ---------------------------------------------------------------------------

// GET /api/customers-partners/tags — every tag in use, for the picker.
router.get("/tags", async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, label, color FROM crm_tags ORDER BY label`);
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/customers-partners/tags] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// DELETE /api/customers-partners/tags/:tagId — removes the tag everywhere
// (crm_partner_tags rows cascade). Admin-only: this affects every partner
// that has the tag, not just one.
router.delete("/tags/:tagId", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`DELETE FROM crm_tags WHERE id = $1 RETURNING label`, [req.params.tagId]);
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    res.status(204).end();
    logAudit(req, { kind: "bp.tag.delete", desc: `Tag removed everywhere: "${rows[0].label}"` });
  } catch (err) {
    console.error("[DELETE /api/customers-partners/tags/:tagId] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

router.get("/:id/tags", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.label, t.color
       FROM crm_partner_tags pt JOIN crm_tags t ON t.id = pt.tagid
       WHERE pt.businesspartnerid = $1 ORDER BY t.label`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/customers-partners/:id/tags] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// POST /api/customers-partners/:id/tags — find-or-create by label, then
// attach. Keeps the tag picker to one call instead of "create tag" + "attach
// tag" as two round trips.
router.post("/:id/tags", async (req, res) => {
  const label = (req.body?.label || "").trim();
  if (!label) return res.status(400).json({ error: "validation_error", message: "label is required" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: tagRows } = await client.query(
      `INSERT INTO crm_tags (label) VALUES ($1)
       ON CONFLICT (label) DO UPDATE SET label = EXCLUDED.label
       RETURNING id, label, color`,
      [label]
    );
    const tag = tagRows[0];
    await client.query(
      `INSERT INTO crm_partner_tags (businesspartnerid, tagid) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.id, tag.id]
    );
    await client.query("COMMIT");
    res.status(201).json(tag);
    bpAuditLabel(req.params.id).then((bp) =>
      logAudit(req, { kind: "bp.tag.add", desc: `Customer/partner "${bp}": tagged "${tag.label}"` }));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[POST /api/customers-partners/:id/tags] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

router.delete("/:id/tags/:tagId", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM crm_partner_tags WHERE businesspartnerid = $1 AND tagid = $2
       RETURNING (SELECT label FROM crm_tags WHERE id = $2) AS label`,
      [req.params.id, req.params.tagId]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    res.status(204).end();
    bpAuditLabel(req.params.id).then((bp) =>
      logAudit(req, { kind: "bp.tag.remove", desc: `Customer/partner "${bp}": untagged "${rows[0].label}"` }));
  } catch (err) {
    console.error("[DELETE /api/customers-partners/:id/tags/:tagId] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/customers-partners?q=search — list for the search/browse table.
// projectsAlive/projectsDead/projectsTotal power the "Number of projects"
// column (N/M(T) — alive/dead(total)) — "dead" mirrors the Reports/
// stale-projects convention: projectstatus IN ('Closed','Cancelled').
//
// CRM Phase C1/C4 filters (all optional):
//   stage=<lifecycle_stage>  category=<category>  role=<one roles[] value>
//   tag=<one tag label>  owner=me | <employeeId> | none
//   includeArchived=true (default excludes)
// Per-owner visibility (appconfig "crm.visibility_all", see
// crmVisibilityAll() above) narrows the result set for non-admins unless
// the instance has switched to "everyone sees everyone".
router.get("/", requireModuleAccess("customers-partners"), async (req, res) => {
  const q = (req.query.q || "").trim();
  const stage = (req.query.stage || "").trim();
  const category = (req.query.category || "").trim();
  const role = (req.query.role || "").trim();
  const tag = (req.query.tag || "").trim();
  const ownerParam = (req.query.owner || "").trim();
  const includeArchived = req.query.includeArchived === "true";
  try {
    const callerId = req.hittUser?.employeeId || null;
    const isAdmin = !!req.hittUser?.isAdmin;
    const visibilityAll = await crmVisibilityAll();

    const conditions = [
      `($1 = '' OR bp.bpname ILIKE '%' || $1 || '%' OR EXISTS (
         SELECT 1 FROM taxcompanies t
         WHERE t.businesspartnerid::bigint = bp.id AND t.taxcompanyname ILIKE '%' || $1 || '%'
       ))`,
    ];
    const params = [q];

    if (!includeArchived) conditions.push(`bp.archived_at IS NULL`);
    if (stage) { params.push(stage); conditions.push(`bp.lifecycle_stage = $${params.length}`); }
    if (category) { params.push(category); conditions.push(`bp.category = $${params.length}`); }
    if (role) { params.push(role); conditions.push(`$${params.length} = ANY(bp.roles)`); }
    if (tag) {
      params.push(tag);
      conditions.push(`EXISTS (
        SELECT 1 FROM crm_partner_tags pt JOIN crm_tags t ON t.id = pt.tagid
        WHERE pt.businesspartnerid = bp.id AND t.label = $${params.length}
      )`);
    }

    if (ownerParam === "me" && callerId) {
      params.push(callerId);
      conditions.push(`bp.owner_employeeid = $${params.length}`);
    } else if (ownerParam === "none") {
      conditions.push(`bp.owner_employeeid IS NULL`);
    } else if (ownerParam) {
      params.push(ownerParam);
      conditions.push(`bp.owner_employeeid = $${params.length}`);
    }

    if (!isAdmin && !visibilityAll && callerId) {
      params.push(callerId);
      conditions.push(`(bp.owner_employeeid IS NULL OR bp.owner_employeeid = $${params.length})`);
    }

    const { rows } = await pool.query(
      `SELECT bp.id, bp.bpname AS name, bp.webpage,
              ent.entitydesc AS "entityLabel", ct.companytypedesc AS "companyTypeLabel",
              c.countrydesc AS "countryLabel",
              bp.roles, bp.category, bp.lifecycle_stage AS "lifecycleStage", bp.temperature,
              bp.owner_employeeid AS "ownerEmployeeId",
              NULLIF(TRIM(CONCAT(owner.employeefirstname, ' ', owner.employeelastname)), '') AS "ownerName",
              bp.lead_source AS "leadSource", bp.geo_scope AS "geoScope",
              bp.archived_at AS "archivedAt",
              COALESCE(proj.alive, 0) AS "projectsAlive",
              COALESCE(proj.dead, 0) AS "projectsDead",
              COALESCE(proj.total, 0) AS "projectsTotal",
              COALESCE(tc.n, 0)::int AS "taxCompanyCount",
              tc.names AS "taxCompanyNames",
              COALESCE(tags.labels, '{}') AS "tags"
       FROM businesspartners bp
       LEFT JOIN entity ent ON ent.id = bp.entityid::bigint
       LEFT JOIN companytypes ct ON ct.id = bp.companytypeid
       LEFT JOIN addresses a ON a.businesspartnerid = bp.id
       LEFT JOIN countries c ON c.id = a.countryid::bigint
       LEFT JOIN employees owner ON owner.id = bp.owner_employeeid
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS n,
                string_agg(NULLIF(TRIM(taxcompanyname), ''), ' · ' ORDER BY taxcompanyname) AS names
         FROM taxcompanies WHERE businesspartnerid::bigint = bp.id
       ) tc ON true
       LEFT JOIN LATERAL (
         SELECT ARRAY_AGG(t.label ORDER BY t.label) AS labels
         FROM crm_partner_tags pt JOIN crm_tags t ON t.id = pt.tagid
         WHERE pt.businesspartnerid = bp.id
       ) tags ON true
       LEFT JOIN LATERAL (
         SELECT
           COUNT(*) FILTER (WHERE ps.projectstatusdesc NOT IN ('Closed', 'Cancelled')) AS alive,
           COUNT(*) FILTER (WHERE ps.projectstatusdesc IN ('Closed', 'Cancelled')) AS dead,
           COUNT(*) AS total
         FROM projects p
         LEFT JOIN projectstatus ps ON ps.id = p.projectstatusid::bigint
         WHERE p.busspartnerid::bigint = bp.id
       ) proj ON true
       WHERE ${conditions.join(" AND ")}
       ORDER BY bp.bpname
       LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/customers-partners] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/customers-partners/:id — full detail incl. primary address.
router.get("/:id", async (req, res) => {
  try {
    if (!(await loadVisiblePartner(req, res, req.params.id))) return;
    const { rows } = await pool.query(
      `SELECT bp.id, bp.bpname AS name, bp.webpage, bp.finsitcode,
              bp.entityid, ent.entitydesc AS "entityLabel",
              bp.companytypeid, ct.companytypedesc AS "companyTypeLabel",
              bp.languageid, lang.languagedesc AS "languageLabel",
              bp.lastupdated, bp.lastupdatedby,
              NULLIF(TRIM(CONCAT(emp.employeefirstname, ' ', emp.employeelastname)), '') AS "lastUpdatedByName",
              a.id AS "addressId", a.streetname, a.city, a.state, a.zipcode,
              a.phonenumber, a.phonenumber2, a.countryid,
              country.countrydesc AS "countryLabel",
              bp.roles, bp.category, bp.lifecycle_stage AS "lifecycleStage", bp.temperature,
              bp.owner_employeeid AS "ownerEmployeeId",
              NULLIF(TRIM(CONCAT(owner.employeefirstname, ' ', owner.employeelastname)), '') AS "ownerName",
              bp.lead_source AS "leadSource", bp.geo_scope AS "geoScope",
              bp.archived_at AS "archivedAt",
              primary_contact.id AS "primaryContactId", primary_contact.contactname AS "primaryContactName",
              primary_contact.emailaddress AS "primaryContactEmail", primary_contact.phonenumber AS "primaryContactPhone"
       FROM businesspartners bp
       LEFT JOIN entity ent ON ent.id = bp.entityid::bigint
       LEFT JOIN companytypes ct ON ct.id = bp.companytypeid
       LEFT JOIN languages lang ON lang.id = bp.languageid
       LEFT JOIN employees emp ON emp.id = bp.lastupdatedby
       LEFT JOIN employees owner ON owner.id = bp.owner_employeeid
       LEFT JOIN addresses a ON a.businesspartnerid = bp.id
       LEFT JOIN countries country ON country.id = a.countryid::bigint
       LEFT JOIN LATERAL (
         SELECT c.id, c.contactname, c.emailaddress, c.phonenumber
         FROM contact_org_roles cor
         JOIN contacts c ON c.id = cor.contactid
         WHERE cor.businesspartnerid = bp.id AND cor.is_primary AND cor.ended_at IS NULL
         LIMIT 1
       ) primary_contact ON true
       WHERE bp.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("[GET /api/customers-partners/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// POST /api/customers-partners — create (+ optional initial address).
router.post("/", requireModuleAccess("customers-partners"), async (req, res) => {
  const {
    name, entityId, companyTypeId, languageId, webpage, address, employeeId,
    roles, category, lifecycleStage, temperature, ownerEmployeeId, leadSource, geoScope,
  } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "validation_error", message: "name is required" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO businesspartners
         (bpname, entityid, companytypeid, languageid, webpage, lastupdated, lastupdatedby,
          roles, category, lifecycle_stage, temperature, owner_employeeid, lead_source, geo_scope)
       VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, bpname AS name`,
      [name.trim(), entityId || null, companyTypeId || null, languageId || null, webpage || null, employeeId || null,
       Array.isArray(roles) ? roles : [], category || null, lifecycleStage || "new", temperature || null,
       ownerEmployeeId || null, leadSource || null, geoScope || null]
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
      [bp.id, employeeId || null, "Customer/partner created"]
    );
    await client.query("COMMIT");
    logAudit(req, { kind: "bp.insert", desc: `Created customer/partner "${bp.name}"` });
    res.status(201).json(bp);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[POST /api/customers-partners] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/customers-partners/:id — update core fields + upsert address.
// Logs a human-readable summary per changed field to businesspartnerchangelog
// (address fields are collapsed into one "Address updated" entry rather than
// one line per street/city/zip/etc.) — see GET /:id/history, same pattern as
// projects.js's PATCH /:id.
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const {
    name, entityId, companyTypeId, languageId, webpage, address, employeeId,
    roles, category, lifecycleStage, stageReason, temperature, ownerEmployeeId, leadSource, geoScope,
  } = req.body || {};
  if (!(await loadVisiblePartner(req, res, id))) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: curRows } = await client.query(
      `SELECT bp.bpname, bp.companytypeid, ct.companytypedesc AS "companyTypeLabel",
              bp.languageid, lang.languagedesc AS "languageLabel", bp.webpage,
              a.streetname, a.city, a.state, a.zipcode, a.phonenumber, a.phonenumber2, a.countryid,
              bp.roles, bp.category, bp.lifecycle_stage, bp.temperature,
              bp.owner_employeeid, bp.lead_source, bp.geo_scope,
              NULLIF(TRIM(CONCAT(owner.employeefirstname, ' ', owner.employeelastname)), '') AS "ownerName"
       FROM businesspartners bp
       LEFT JOIN companytypes ct ON ct.id = bp.companytypeid
       LEFT JOIN languages lang ON lang.id = bp.languageid
       LEFT JOIN addresses a ON a.businesspartnerid = bp.id
       LEFT JOIN employees owner ON owner.id = bp.owner_employeeid
       WHERE bp.id = $1
       FOR UPDATE OF bp`,
      [id]
    );
    const cur = curRows[0] || {};
    const changes = [];

    let newCompanyTypeLabel = null, newLanguageLabel = null, newOwnerName = null;
    if (ownerEmployeeId !== undefined && String(ownerEmployeeId ?? "") !== String(cur.owner_employeeid ?? "")) {
      if (ownerEmployeeId) {
        const r = await client.query(
          `SELECT TRIM(CONCAT(employeefirstname, ' ', employeelastname)) AS name FROM employees WHERE id = $1`,
          [ownerEmployeeId]
        );
        newOwnerName = r.rows[0]?.name || `#${ownerEmployeeId}`;
      } else {
        newOwnerName = "—";
      }
    }
    if (companyTypeId != null && String(companyTypeId) !== String(cur.companytypeid)) {
      const r = await client.query(`SELECT companytypedesc AS label FROM companytypes WHERE id = $1`, [companyTypeId]);
      newCompanyTypeLabel = r.rows[0]?.label ?? null;
    }
    if (languageId != null && String(languageId) !== String(cur.languageid)) {
      const r = await client.query(`SELECT languagedesc AS label FROM languages WHERE id = $1`, [languageId]);
      newLanguageLabel = r.rows[0]?.label ?? null;
    }

    const nextStage = lifecycleStage !== undefined && lifecycleStage !== cur.lifecycle_stage ? lifecycleStage : null;

    await client.query(
      `UPDATE businesspartners SET
         bpname = COALESCE($1, bpname),
         entityid = COALESCE($2, entityid),
         companytypeid = COALESCE($3, companytypeid),
         languageid = COALESCE($4, languageid),
         webpage = COALESCE($5, webpage),
         lastupdated = now(), lastupdatedby = $6,
         roles = COALESCE($7::text[], roles),
         category = COALESCE($8, category),
         lifecycle_stage = COALESCE($9, lifecycle_stage),
         temperature = CASE WHEN $10 THEN $11 ELSE temperature END,
         owner_employeeid = CASE WHEN $12 THEN $13 ELSE owner_employeeid END,
         lead_source = COALESCE($14, lead_source),
         geo_scope = COALESCE($15, geo_scope)
       WHERE id = $16`,
      [name || null, entityId ?? null, companyTypeId ?? null, languageId ?? null, webpage ?? null, employeeId || null,
       Array.isArray(roles) ? roles : null, category ?? null, nextStage,
       temperature !== undefined, temperature || null,
       ownerEmployeeId !== undefined, ownerEmployeeId || null,
       leadSource ?? null, geoScope ?? null, id]
    );

    if (name !== undefined && name !== cur.bpname) {
      changes.push(`Name changed from "${cur.bpname || ""}" to "${name}"`);
    }
    if (newCompanyTypeLabel !== null) changes.push(`Type of company changed from ${cur.companyTypeLabel || "—"} to ${newCompanyTypeLabel}`);
    if (newLanguageLabel !== null) changes.push(`Language changed from ${cur.languageLabel || "—"} to ${newLanguageLabel}`);
    if (webpage !== undefined && (webpage || null) !== (cur.webpage || null)) {
      changes.push(`Webpage changed from "${cur.webpage || ""}" to "${webpage || ""}"`);
    }
    if (Array.isArray(roles) && roles.join(",") !== (cur.roles || []).join(",")) {
      changes.push(`Roles changed from ${(cur.roles || []).join(", ") || "—"} to ${roles.join(", ") || "—"}`);
    }
    if (category !== undefined && (category || null) !== (cur.category || null)) {
      changes.push(`Category changed from ${cur.category || "—"} to ${category || "—"}`);
    }
    if (temperature !== undefined && (temperature || null) !== (cur.temperature || null)) {
      changes.push(`Temperature changed from ${cur.temperature || "—"} to ${temperature || "—"}`);
    }
    if (newOwnerName !== null) {
      changes.push(`Owner changed from ${cur.ownerName || "—"} to ${newOwnerName}`);
    }
    if (leadSource !== undefined && (leadSource || null) !== (cur.lead_source || null)) {
      changes.push(`Lead source changed from ${cur.lead_source || "—"} to ${leadSource || "—"}`);
    }
    if (geoScope !== undefined && (geoScope || null) !== (cur.geo_scope || null)) {
      changes.push(`Geographic scope changed from ${cur.geo_scope || "—"} to ${geoScope || "—"}`);
    }
    if (nextStage) {
      await logStageChange(client, id, req, cur.lifecycle_stage, nextStage, stageReason);
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
      desc: `Updated customer/partner "${name || cur.bpname || `#${id}`}"` +
        (changes.length ? `: ${changes.join("; ")}` : " (no field changes)"),
    });
    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[PATCH /api/customers-partners/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// POST /api/customers-partners/:id/archive — archive/deactivate instead of a
// hard delete (mirrors the tax-company delete guard: keep the record, hide
// it from the default list). archived_at is deliberately its own action
// rather than a PATCH field, so it always gets its own audited changelog
// line with an optional reason.
router.post("/:id/archive", async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body || {};
  try {
    if (!(await loadVisiblePartner(req, res, id))) return;
    const { rows } = await pool.query(
      `UPDATE businesspartners SET archived_at = now() WHERE id = $1 AND archived_at IS NULL RETURNING bpname AS name`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found", message: "Not found, or already archived" });
    await logBpChange(pool, id, req, `Archived` + (reason ? ` — ${reason}` : ""));
    res.status(204).end();
    logAudit(req, { kind: "bp.archive", desc: `Archived customer/partner "${rows[0].name}"` + (reason ? `: ${reason}` : "") });
  } catch (err) {
    console.error("[POST /api/customers-partners/:id/archive] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

router.post("/:id/unarchive", async (req, res) => {
  const { id } = req.params;
  try {
    if (!(await loadVisiblePartner(req, res, id))) return;
    const { rows } = await pool.query(
      `UPDATE businesspartners SET archived_at = NULL WHERE id = $1 AND archived_at IS NOT NULL RETURNING bpname AS name`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found", message: "Not found, or not archived" });
    await logBpChange(pool, id, req, `Unarchived`);
    res.status(204).end();
    logAudit(req, { kind: "bp.unarchive", desc: `Unarchived customer/partner "${rows[0].name}"` });
  } catch (err) {
    console.error("[POST /api/customers-partners/:id/unarchive] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/customers-partners/:id/history — every logged field change,
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
    console.error("[GET /api/customers-partners/:id/history] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/customers-partners/:id/projects — every project with this BP as
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
    console.error("[GET /api/customers-partners/:id/projects] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Contacts / Notes / Tax companies subforms.
// ---------------------------------------------------------------------------

// Upserts the contact_org_roles row for (contactId, bpId) — the relationship
// fields layered on top of the base `contacts` row (see the header comment
// and docs/customers-crm-alignment.md §4.1). Clears any other active primary
// contact on the same partner first when isPrimary is set, so the partial
// unique index (contact_org_roles_one_primary_uq) never trips. Runs on the
// caller's client/pool — takes either since most contact writes here aren't
// otherwise transactional.
async function upsertContactOrgRole(runner, contactId, bpId, body) {
  const position = body?.position ?? null;
  const isPrimary = !!body?.isPrimary;
  const decisionRole = body?.decisionRole || null;
  const influence = body?.influence || null;
  const stance = body?.stance || null;
  const reportsToContactId = body?.reportsToContactId || null;

  if (isPrimary) {
    await runner.query(
      `UPDATE contact_org_roles SET is_primary = false
       WHERE businesspartnerid = $1 AND is_primary AND ended_at IS NULL AND contactid <> $2`,
      [bpId, contactId]
    );
  }
  const existing = await runner.query(
    `SELECT id FROM contact_org_roles WHERE contactid = $1 AND businesspartnerid = $2 AND ended_at IS NULL LIMIT 1`,
    [contactId, bpId]
  );
  if (existing.rows.length) {
    await runner.query(
      `UPDATE contact_org_roles SET
         "position" = $1, is_primary = $2, decision_role = $3,
         influence = $4, stance = $5, reports_to_contactid = $6
       WHERE id = $7`,
      [position, isPrimary, decisionRole, influence, stance, reportsToContactId, existing.rows[0].id]
    );
  } else {
    await runner.query(
      `INSERT INTO contact_org_roles
         (contactid, businesspartnerid, "position", is_primary, decision_role, influence, stance, reports_to_contactid, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_DATE)`,
      [contactId, bpId, position, isPrimary, decisionRole, influence, stance, reportsToContactId]
    );
  }
}

const CONTACT_SELECT = `
  SELECT c.id, c.contactname, c.emailaddress, c.phonenumber,
         c.linkedin_url AS "linkedinUrl", c.do_not_contact AS "doNotContact", c.languageid AS "languageId",
         cor."position", cor.is_primary AS "isPrimary", cor.decision_role AS "decisionRole",
         cor.influence, cor.stance, cor.reports_to_contactid AS "reportsToContactId",
         reports_to.contactname AS "reportsToName"
  FROM contacts c
  LEFT JOIN contact_org_roles cor
    ON cor.contactid = c.id AND cor.businesspartnerid = $1::bigint AND cor.ended_at IS NULL
  LEFT JOIN contacts reports_to ON reports_to.id = cor.reports_to_contactid
`;

router.get("/:id/contacts", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${CONTACT_SELECT} WHERE c.businesspartnerid = $1 ORDER BY c.contactname`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/customers-partners/:id/contacts] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

router.post("/:id/contacts", async (req, res) => {
  const { contactname, position, emailaddress, phonenumber, employeeId, linkedinUrl, doNotContact, languageId } = req.body || {};
  if (!contactname || !contactname.trim()) {
    return res.status(400).json({ error: "validation_error", message: "contactname is required" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO contacts (businesspartnerid, contactname, position, emailaddress, phonenumber, linkedin_url, do_not_contact, languageid)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [req.params.id, contactname.trim(), position || null, emailaddress || null, phonenumber || null,
       linkedinUrl || null, !!doNotContact, languageId || null]
    );
    const contactId = rows[0].id;
    await upsertContactOrgRole(client, contactId, req.params.id, req.body);
    await client.query(
      `INSERT INTO businesspartnerchangelog (businesspartnerid, changedat, changedby, summary) VALUES ($1, now(), $2, $3)`,
      [req.params.id, employeeId || null, `Contact added: ${contactname.trim()}`]
    );
    await client.query("COMMIT");
    const { rows: full } = await pool.query(`${CONTACT_SELECT} WHERE c.id = $2`, [req.params.id, contactId]);
    res.status(201).json(full[0]);
    bpAuditLabel(req.params.id).then((bp) =>
      logAudit(req, { kind: "bp.contact.add", desc: `Customer/partner "${bp}": contact added "${contactname.trim()}"` }));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[POST /api/customers-partners/:id/contacts] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/customers-partners/:id/contacts/:contactId — edit an existing
// contact (name/position/email/phone + the contact_org_roles relationship
// fields). Logs to businesspartnerchangelog.
router.patch("/:id/contacts/:contactId", async (req, res) => {
  const { contactname, position, emailaddress, phonenumber, employeeId, linkedinUrl, doNotContact, languageId } = req.body || {};
  if (!contactname || !contactname.trim()) {
    return res.status(400).json({ error: "validation_error", message: "contactname is required" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE contacts
       SET contactname = $1, position = $2, emailaddress = $3, phonenumber = $4,
           linkedin_url = $5, do_not_contact = $6, languageid = $7
       WHERE id = $8 AND businesspartnerid = $9
       RETURNING id`,
      [contactname.trim(), position || null, emailaddress || null, phonenumber || null,
       linkedinUrl || null, !!doNotContact, languageId || null, req.params.contactId, req.params.id]
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_found", message: "Contact not found on this customer/partner" });
    }
    await upsertContactOrgRole(client, req.params.contactId, req.params.id, req.body);
    await client.query(
      `INSERT INTO businesspartnerchangelog (businesspartnerid, changedat, changedby, summary) VALUES ($1, now(), $2, $3)`,
      [req.params.id, employeeId || null, `Contact updated: ${contactname.trim()}`]
    );
    await client.query("COMMIT");
    const { rows: full } = await pool.query(`${CONTACT_SELECT} WHERE c.id = $2`, [req.params.id, req.params.contactId]);
    res.json(full[0]);
    bpAuditLabel(req.params.id).then((bp) =>
      logAudit(req, { kind: "bp.contact.update", desc: `Customer/partner "${bp}": contact updated "${contactname.trim()}"` }));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[PATCH /api/customers-partners/:id/contacts/:contactId] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/customers-partners/:id/contacts/:contactId
router.delete("/:id/contacts/:contactId", async (req, res) => {
  const { employeeId } = req.body || {};
  try {
    const { rows } = await pool.query(
      `DELETE FROM contacts WHERE id = $1 AND businesspartnerid = $2 RETURNING contactname`,
      [req.params.contactId, req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: "not_found", message: "Contact not found on this customer/partner" });
    }
    await pool.query(
      `INSERT INTO businesspartnerchangelog (businesspartnerid, changedat, changedby, summary) VALUES ($1, now(), $2, $3)`,
      [req.params.id, employeeId || null, `Contact removed: ${rows[0].contactname || "—"}`]
    );
    res.status(204).end();
    bpAuditLabel(req.params.id).then((bp) =>
      logAudit(req, { kind: "bp.contact.delete", desc: `Customer/partner "${bp}": contact removed "${rows[0].contactname || "—"}"` }));
  } catch (err) {
    console.error("[DELETE /api/customers-partners/:id/contacts/:contactId] DB error:", err.message);
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
    console.error("[GET /api/customers-partners/:id/notes] DB error:", err.message);
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
      logAudit(req, { kind: "bp.note.add", desc: `Customer/partner "${bp}": note added — "${preview}"` }));
  } catch (err) {
    console.error("[POST /api/customers-partners/:id/notes] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// DELETE /api/customers-partners/:id/notes/:noteId — used by the modal's
// "discard changes" cleanup (revert notes added during this session).
router.delete("/:id/notes/:noteId", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM businesspartnersnotes WHERE id = $1 AND bpid = $2 RETURNING notes`,
      [req.params.noteId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found", message: "Note not found on this customer/partner" });
    res.status(204).end();
    const preview = (rows[0].notes || "").length > 80 ? `${rows[0].notes.slice(0, 80)}…` : rows[0].notes;
    bpAuditLabel(req.params.id).then((bp) =>
      logAudit(req, { kind: "bp.note.delete", desc: `Customer/partner "${bp}": note deleted — "${preview}"` }));
  } catch (err) {
    console.error("[DELETE /api/customers-partners/:id/notes/:noteId] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Activities — CRM Phase C2 communication timeline (crm_activities +
// crm_activity_participants). A logged interaction (call/meeting/email/
// note/site_visit/other), optionally tied to one contact and/or a set of
// participants (other contacts and/or employees who were on it).
// ---------------------------------------------------------------------------

const ACTIVITY_SELECT = `
  SELECT a.id, a.kind, a.occurred_at AS "occurredAt", a.summary, a.outcome,
         a.agreed_next_step AS "agreedNextStep",
         a.contactid AS "contactId", c.contactname AS "contactName",
         a.logged_by AS "loggedBy",
         NULLIF(TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)), '') AS "loggedByName",
         a.created_at AS "createdAt",
         COALESCE(ARRAY_AGG(DISTINCT pc.contactname) FILTER (WHERE pc.contactname IS NOT NULL), '{}')
           AS "participantContactNames",
         COALESCE(ARRAY_AGG(DISTINCT NULLIF(TRIM(CONCAT(pe.employeefirstname, ' ', pe.employeelastname)), ''))
           FILTER (WHERE pe.id IS NOT NULL), '{}') AS "participantEmployeeNames"
  FROM crm_activities a
  LEFT JOIN contacts c ON c.id = a.contactid
  LEFT JOIN employees e ON e.id = a.logged_by
  LEFT JOIN crm_activity_participants p ON p.activityid = a.id
  LEFT JOIN contacts pc ON pc.id = p.contactid
  LEFT JOIN employees pe ON pe.id = p.employeeid
`;
const ACTIVITY_GROUP_BY = `GROUP BY a.id, c.contactname, e.employeefirstname, e.employeelastname`;

router.get("/:id/activities", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${ACTIVITY_SELECT}
       WHERE a.businesspartnerid = $1
       ${ACTIVITY_GROUP_BY}
       ORDER BY a.occurred_at DESC, a.id DESC
       LIMIT 200`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/customers-partners/:id/activities] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

router.post("/:id/activities", async (req, res) => {
  const { kind, occurredAt, summary, outcome, agreedNextStep, contactId, participantContactIds, participantEmployeeIds } = req.body || {};
  if (!kind || !String(kind).trim()) {
    return res.status(400).json({ error: "validation_error", message: "kind is required" });
  }
  if (!summary || !summary.trim()) {
    return res.status(400).json({ error: "validation_error", message: "summary is required" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO crm_activities (businesspartnerid, contactid, kind, occurred_at, summary, outcome, agreed_next_step, logged_by)
       VALUES ($1, $2, $3, COALESCE($4, now()), $5, $6, $7, $8)
       RETURNING id`,
      [req.params.id, contactId || null, kind.trim(), occurredAt || null, summary.trim(),
       outcome || null, agreedNextStep || null, req.hittUser?.employeeId || null]
    );
    const activityId = rows[0].id;
    for (const cId of Array.isArray(participantContactIds) ? participantContactIds : []) {
      await client.query(`INSERT INTO crm_activity_participants (activityid, contactid) VALUES ($1, $2)`, [activityId, cId]);
    }
    for (const eId of Array.isArray(participantEmployeeIds) ? participantEmployeeIds : []) {
      await client.query(`INSERT INTO crm_activity_participants (activityid, employeeid) VALUES ($1, $2)`, [activityId, eId]);
    }
    await logBpChange(client, req.params.id, req, `Activity logged (${kind.trim()}): ${summary.trim().slice(0, 80)}`);
    await client.query("COMMIT");
    const { rows: full } = await pool.query(`${ACTIVITY_SELECT} WHERE a.id = $1 ${ACTIVITY_GROUP_BY}`, [activityId]);
    res.status(201).json(full[0]);
    bpAuditLabel(req.params.id).then((bp) =>
      logAudit(req, { kind: "bp.activity.add", desc: `Customer/partner "${bp}": activity logged (${kind.trim()})` }));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[POST /api/customers-partners/:id/activities] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/customers-partners/:id/activities/:activityId — participants
// cascade automatically (crm_activity_participants.activityid ON DELETE CASCADE).
router.delete("/:id/activities/:activityId", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM crm_activities WHERE id = $1 AND businesspartnerid = $2 RETURNING kind, summary`,
      [req.params.activityId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found", message: "Activity not found on this customer/partner" });
    res.status(204).end();
    bpAuditLabel(req.params.id).then((bp) =>
      logAudit(req, { kind: "bp.activity.delete", desc: `Customer/partner "${bp}": activity removed (${rows[0].kind})` }));
  } catch (err) {
    console.error("[DELETE /api/customers-partners/:id/activities/:activityId] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Opportunities — CRM Phase C3 pre-project funnel (crm_opportunities). A
// short, linear stage set (identified -> qualifying -> proposal_pending ->
// converted/lost) — not a configurable pipeline. "Convert to project" hands
// the deal to the existing Projects board (Lead/Oferta/Guanyat); a converted
// opportunity is read-only from then on. See
// docs/customers-crm-alignment.md §3.5 (revised) and §4.4 Q2.
// ---------------------------------------------------------------------------

const OPPORTUNITY_STAGES = ["identified", "qualifying", "proposal_pending", "converted", "lost"];

const OPPORTUNITY_SELECT = `
  SELECT o.id, o.name, o.stage, o.estimated_value AS "estimatedValue",
         o.currencyid AS "currencyId", cur.code AS "currencyCode",
         o.owner_employeeid AS "ownerEmployeeId",
         NULLIF(TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)), '') AS "ownerName",
         o.expected_close AS "expectedClose", o.source, o.lost_reason AS "lostReason",
         o.projectid AS "projectId", p.projectnumber AS "projectCode",
         o.created_at AS "createdAt", o.closed_at AS "closedAt"
  FROM crm_opportunities o
  LEFT JOIN employees e ON e.id = o.owner_employeeid
  LEFT JOIN invoicecurrencies cur ON cur.id = o.currencyid
  LEFT JOIN projects p ON p.id = o.projectid
`;

router.get("/:id/opportunities", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${OPPORTUNITY_SELECT}
       WHERE o.businesspartnerid = $1
       ORDER BY (o.stage IN ('converted', 'lost')), o.created_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/customers-partners/:id/opportunities] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

router.post("/:id/opportunities", async (req, res) => {
  const { name, estimatedValue, currencyId, ownerEmployeeId, expectedClose, source } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "validation_error", message: "name is required" });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO crm_opportunities
         (businesspartnerid, name, estimated_value, currencyid, owner_employeeid, expected_close, source, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [req.params.id, name.trim(), estimatedValue || null, currencyId || null, ownerEmployeeId || null,
       expectedClose || null, source || null, req.hittUser?.employeeId || null]
    );
    const oppId = rows[0].id;
    await logBpChange(pool, req.params.id, req, `Opportunity created: ${name.trim()}`);
    const { rows: full } = await pool.query(`${OPPORTUNITY_SELECT} WHERE o.id = $1`, [oppId]);
    res.status(201).json(full[0]);
    bpAuditLabel(req.params.id).then((bp) =>
      logAudit(req, { kind: "bp.opportunity.add", desc: `Customer/partner "${bp}": opportunity created "${name.trim()}"` }));
  } catch (err) {
    console.error("[POST /api/customers-partners/:id/opportunities] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// PATCH /api/customers-partners/:id/opportunities/:oppId — field edits and/or
// a stage move (logged to crm_opportunity_stage_history + the plain-text
// change log). Moving to 'lost' expects lostReason and stamps closed_at.
// A converted opportunity is read-only — use the project it points at.
router.patch("/:id/opportunities/:oppId", async (req, res) => {
  const { name, estimatedValue, currencyId, ownerEmployeeId, expectedClose, source, stage, lostReason, stageReason } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: curRows } = await client.query(
      `SELECT stage FROM crm_opportunities WHERE id = $1 AND businesspartnerid = $2 FOR UPDATE`,
      [req.params.oppId, req.params.id]
    );
    if (!curRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_found", message: "Opportunity not found on this customer/partner" });
    }
    const cur = curRows[0];
    if (cur.stage === "converted") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "conflict", message: "This opportunity has been converted to a project and is read-only." });
    }
    if (stage !== undefined && !OPPORTUNITY_STAGES.includes(stage)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "validation_error", message: "Invalid stage." });
    }

    const nextStage = stage !== undefined && stage !== cur.stage ? stage : null;

    await client.query(
      `UPDATE crm_opportunities SET
         name = COALESCE($1, name),
         estimated_value = CASE WHEN $2 THEN $3 ELSE estimated_value END,
         currencyid = CASE WHEN $4 THEN $5 ELSE currencyid END,
         owner_employeeid = CASE WHEN $6 THEN $7 ELSE owner_employeeid END,
         expected_close = CASE WHEN $8 THEN $9 ELSE expected_close END,
         source = CASE WHEN $10 THEN $11 ELSE source END,
         stage = COALESCE($12, stage),
         lost_reason = CASE WHEN $13 THEN $14 ELSE lost_reason END,
         closed_at = CASE WHEN $15 THEN now() ELSE closed_at END
       WHERE id = $16`,
      [name || null,
       estimatedValue !== undefined, estimatedValue || null,
       currencyId !== undefined, currencyId || null,
       ownerEmployeeId !== undefined, ownerEmployeeId || null,
       expectedClose !== undefined, expectedClose || null,
       source !== undefined, source || null,
       nextStage,
       nextStage === "lost", lostReason || null,
       nextStage === "lost",
       req.params.oppId]
    );

    if (nextStage) {
      await client.query(
        `INSERT INTO crm_opportunity_stage_history (opportunityid, from_stage, to_stage, changedat, changedby, reason)
         VALUES ($1, $2, $3, now(), $4, $5)`,
        [req.params.oppId, cur.stage, nextStage, req.hittUser?.employeeId || null, stageReason || lostReason || null]
      );
      await logBpChange(client, req.params.id, req,
        `Opportunity stage changed from ${cur.stage} to ${nextStage}` + (stageReason || lostReason ? ` — ${stageReason || lostReason}` : ""));
    }

    await client.query("COMMIT");
    const { rows: full } = await pool.query(`${OPPORTUNITY_SELECT} WHERE o.id = $1`, [req.params.oppId]);
    res.json(full[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[PATCH /api/customers-partners/:id/opportunities/:oppId] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

router.delete("/:id/opportunities/:oppId", async (req, res) => {
  try {
    const { rows: curRows } = await pool.query(
      `SELECT stage, name FROM crm_opportunities WHERE id = $1 AND businesspartnerid = $2`,
      [req.params.oppId, req.params.id]
    );
    if (!curRows.length) return res.status(404).json({ error: "not_found", message: "Opportunity not found on this customer/partner" });
    if (curRows[0].stage === "converted") {
      return res.status(409).json({ error: "conflict", message: "This opportunity has been converted to a project and can't be deleted." });
    }
    await pool.query(`DELETE FROM crm_opportunities WHERE id = $1`, [req.params.oppId]);
    await logBpChange(pool, req.params.id, req, `Opportunity removed: ${curRows[0].name}`);
    res.status(204).end();
    bpAuditLabel(req.params.id).then((bp) =>
      logAudit(req, { kind: "bp.opportunity.delete", desc: `Customer/partner "${bp}": opportunity removed "${curRows[0].name}"` }));
  } catch (err) {
    console.error("[DELETE /api/customers-partners/:id/opportunities/:oppId] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// POST /api/customers-partners/:id/opportunities/:oppId/convert — hands the
// deal to the Projects board. Creates a project at "Lead" (default) or
// "Oferta" (when a quote's already in hand), assigns this customer/partner
// as its contracting partner, and carries over the estimated value/currency.
// The project number is left unassigned (null), same as any other
// freshly-created Lead — see POST /api/projects.
router.post("/:id/opportunities/:oppId/convert", async (req, res) => {
  const targetStatus = req.body?.stageName === "Oferta" ? "Oferta" : "Lead";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: oppRows } = await client.query(
      `SELECT * FROM crm_opportunities WHERE id = $1 AND businesspartnerid = $2 FOR UPDATE`,
      [req.params.oppId, req.params.id]
    );
    if (!oppRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_found", message: "Opportunity not found on this customer/partner" });
    }
    const opp = oppRows[0];
    if (opp.stage === "converted") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "conflict", message: "This opportunity has already been converted." });
    }
    const { rows: statusRows } = await client.query(
      `SELECT id FROM projectstatus WHERE projectstatusdesc = $1 LIMIT 1`,
      [targetStatus]
    );
    if (!statusRows.length) {
      await client.query("ROLLBACK");
      return res.status(500).json({ error: "server_error", message: `Project status "${targetStatus}" not found.` });
    }
    const { rows: projRows } = await client.query(
      `INSERT INTO projects
         (projectname, projectstatusid, busspartnerid, estimated_value, currencyid,
          projectyear, entrydate, lastupdated, lastupdatedby)
       VALUES ($1, $2, $3, $4, $5, EXTRACT(YEAR FROM now()), now(), now(), $6)
       RETURNING id, projectnumber AS code, projectname AS name`,
      [opp.name, statusRows[0].id, req.params.id, opp.estimated_value, opp.currencyid, req.hittUser?.employeeId || null]
    );
    const project = projRows[0];
    await client.query(
      `UPDATE crm_opportunities SET stage = 'converted', projectid = $1, closed_at = now() WHERE id = $2`,
      [project.id, req.params.oppId]
    );
    await client.query(
      `INSERT INTO crm_opportunity_stage_history (opportunityid, from_stage, to_stage, changedat, changedby, reason)
       VALUES ($1, $2, 'converted', now(), $3, $4)`,
      [req.params.oppId, opp.stage, req.hittUser?.employeeId || null, `Converted to project ${project.code || "#" + project.id}`]
    );
    await logBpChange(client, req.params.id, req, `Opportunity "${opp.name}" converted to project ${project.code || "#" + project.id}`);
    await client.query("COMMIT");
    res.status(201).json({ opportunityId: Number(req.params.oppId), project });
    bpAuditLabel(req.params.id).then((bp) =>
      logAudit(req, { kind: "bp.opportunity.convert", desc: `Customer/partner "${bp}": opportunity "${opp.name}" converted to project ${project.code || "#" + project.id}` }));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[POST /api/customers-partners/:id/opportunities/:oppId/convert] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
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
    `SELECT id, streetname, city, state, zipcode, phonenumber, phonenumber2, countryid, sameaddress
       FROM taxcompaniesaddresses WHERE taxcompanyid = $1::double precision ORDER BY id LIMIT 1`,
    [tcId]
  );
  if (existing.rows.length) {
    const p = existing.rows[0];
    const changed =
      (vals[0] || null) !== (p.streetname || null) || (vals[1] || null) !== (p.city || null) ||
      (vals[2] || null) !== (p.state || null) || (vals[3] || null) !== (p.zipcode || null) ||
      (vals[4] || null) !== (p.phonenumber || null) || (vals[5] || null) !== (p.phonenumber2 || null) ||
      String(vals[6] ?? null) !== String(p.countryid ?? null) || vals[7] !== !!p.sameaddress;
    await client.query(
      `UPDATE taxcompaniesaddresses SET
         streetname=$1, city=$2, state=$3, zipcode=$4,
         phonenumber=$5, phonenumber2=$6, countryid=$7, sameaddress=$8
       WHERE id = $9`,
      [...vals, p.id]
    );
    return changed;
  }
  await client.query(
    `INSERT INTO taxcompaniesaddresses
       (taxcompanyid, streetname, city, state, zipcode, phonenumber, phonenumber2, countryid, sameaddress)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [tcId, ...vals]
  );
  return vals.slice(0, 7).some((v) => v != null);
}

// GET /api/customers-partners/:id/tax-companies
// Veri*Factu recipient identification (used only when the feature is on).
//   fiscalidtype  NULL/'nif' → Spanish NIF form; '02'..'07' → foreign / doc form
//   fiscalcountry ISO-3166-1 alpha-2 (required for a non-'nif' type)
const FISCAL_ID_TYPES = new Set(["nif", "02", "03", "04", "05", "06", "07"]);
function fiscalFields(body) {
  const b = body || {};
  let type = typeof b.fiscalIdType === "string" ? b.fiscalIdType.trim().toLowerCase() : null;
  if (type === "" || type === "nif") type = null;              // store NULL for the default
  if (type && !FISCAL_ID_TYPES.has(type)) type = null;
  let country = typeof b.fiscalCountry === "string" ? b.fiscalCountry.trim().toUpperCase() : null;
  if (country && !/^[A-Z]{2}$/.test(country)) country = null;
  return { fiscalidtype: type, fiscalcountry: country };
}

router.get("/:id/tax-companies", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tc.id, tc.taxcompanyname, tc.vatnumber, tc.emailinvoicing,
              tc.fiscalidtype, tc.fiscalcountry,
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
    console.error("[GET /api/customers-partners/:id/tax-companies] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// POST /api/customers-partners/:id/tax-companies — add an invoicing entity
// for this business partner (mirrors TaxCompanies_BP.frm).
router.post("/:id/tax-companies", async (req, res) => {
  const { taxcompanyname, vatnumber, emailinvoicing, sameAddress, address } = req.body || {};
  if (!taxcompanyname || !taxcompanyname.trim()) {
    return res.status(400).json({ error: "validation_error", message: "taxcompanyname is required" });
  }
  const fiscal = fiscalFields(req.body);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO taxcompanies (businesspartnerid, taxcompanyname, vatnumber, emailinvoicing, fiscalidtype, fiscalcountry)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, taxcompanyname, vatnumber, emailinvoicing, fiscalidtype, fiscalcountry`,
      [req.params.id, taxcompanyname.trim(), vatnumber || null, emailinvoicing || null, fiscal.fiscalidtype, fiscal.fiscalcountry]
    );
    const taxCompany = rows[0];
    await writeTaxCompanyAddress(client, taxCompany.id, req.params.id, sameAddress, address);
    await logBpChange(client, req.params.id, req, `Tax company added: ${taxCompany.taxcompanyname}`);
    await client.query("COMMIT");
    res.status(201).json(taxCompany);
    bpAuditLabel(req.params.id).then((bp) =>
      logAudit(req, { kind: "bp.taxcompany.add", desc: `Customer/partner "${bp}": tax company added "${taxCompany.taxcompanyname}"` }));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[POST /api/customers-partners/:id/tax-companies] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/customers-partners/:id/tax-companies/:tcId — edit name/VAT/email
// and the address (same-as-BP toggle + fields).
router.patch("/:id/tax-companies/:tcId", async (req, res) => {
  const { taxcompanyname, vatnumber, emailinvoicing, sameAddress, address } = req.body || {};
  if (!taxcompanyname || !taxcompanyname.trim()) {
    return res.status(400).json({ error: "validation_error", message: "taxcompanyname is required" });
  }
  const fiscal = fiscalFields(req.body);
  const nm = taxcompanyname.trim();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: prevRows } = await client.query(
      `SELECT taxcompanyname, vatnumber, emailinvoicing
         FROM taxcompanies WHERE id = $1 AND businesspartnerid = $2::double precision`,
      [req.params.tcId, req.params.id]
    );
    if (!prevRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_found", message: "Tax company not found on this customer/partner" });
    }
    const prev = prevRows[0];
    await client.query(
      `UPDATE taxcompanies SET taxcompanyname = $1, vatnumber = $2, emailinvoicing = $3,
              fiscalidtype = $6, fiscalcountry = $7
       WHERE id = $4 AND businesspartnerid = $5::double precision`,
      [nm, vatnumber || null, emailinvoicing || null, req.params.tcId, req.params.id,
       fiscal.fiscalidtype, fiscal.fiscalcountry]
    );
    const addrChanged = await writeTaxCompanyAddress(client, req.params.tcId, req.params.id, sameAddress, address);

    const changes = [];
    if (nm !== (prev.taxcompanyname || "")) changes.push(`Tax company renamed from "${prev.taxcompanyname || ""}" to "${nm}"`);
    if ((vatnumber || null) !== (prev.vatnumber || null)) changes.push(`Tax company "${nm}": VAT changed from "${prev.vatnumber || ""}" to "${vatnumber || ""}"`);
    if ((emailinvoicing || null) !== (prev.emailinvoicing || null)) changes.push(`Tax company "${nm}": invoicing email changed from "${prev.emailinvoicing || ""}" to "${emailinvoicing || ""}"`);
    if (addrChanged) changes.push(`Tax company "${nm}": address updated`);
    for (const s of changes) await logBpChange(client, req.params.id, req, s);

    await client.query("COMMIT");
    res.status(204).end();
    bpAuditLabel(req.params.id).then((bp) =>
      logAudit(req, { kind: "bp.taxcompany.update", desc: `Customer/partner "${bp}": tax company updated "${nm}"` }));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[PATCH /api/customers-partners/:id/tax-companies/:tcId] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/customers-partners/:id/tax-companies/:tcId — blocked while the
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
      return res.status(404).json({ error: "not_found", message: "Tax company not found on this customer/partner" });
    }
    await logBpChange(client, req.params.id, req, `Tax company removed: ${rows[0].taxcompanyname || "—"}`);
    await client.query("COMMIT");
    res.status(204).end();
    bpAuditLabel(req.params.id).then((bp) =>
      logAudit(req, { kind: "bp.taxcompany.delete", desc: `Customer/partner "${bp}": tax company removed "${rows[0].taxcompanyname || "—"}"` }));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[DELETE /api/customers-partners/:id/tax-companies/:tcId] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
