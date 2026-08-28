/**
 * /api/projects
 * ---------------------------------------------------------------------------
 * Wired to the REAL PostgreSQL schema (confirmed 2026-08-22 from
 * information_schema.columns):
 *
 *   projects                 id, projectnumber, projectname, entrydate,
 *                             entityid, biospectrumid, projecttypeid,
 *                             busspartnerid, projectstatusid, projectyear,
 *                             busspartnertoinvoiceid, lastupdated,
 *                             lastupdatedby, bprunningname, notinvoiceable
 *
 *   projectstatus             id, projectstatusdesc, ordinal
 *                             (this is the lookup table behind the kanban
 *                             stage columns — Lead/Oferta/Guanyat/WIP/
 *                             Delivered/Closed/Cancelled — see /statuses)
 *
 *   projectportfolioprogress  id, projectid, progress, updatedby,
 *                             updatedat, datadate
 *                             (a history table: one row per progress
 *                             snapshot, not one row per project — we take
 *                             the most recent row per project)
 *
 *   projectstatushistory      id, projectid, oldstatusid, newstatusid,
 *                             changedat, changedby (new table, no Access
 *                             precedent — added for the Reports "Project
 *                             timeline"). Written by logStatusChangeAndUpdate()
 *                             below and inline in PATCH /:id, only when
 *                             the status actually changes. Project
 *                             creation (POST /) does NOT write an initial
 *                             row — there's no "old status" for a create,
 *                             and it isn't a change.
 *
 * Nothing here queries the "_dump" tables — those are Access-side caches
 * refreshed FROM these live tables, not the other way round.
 * ---------------------------------------------------------------------------
 */
const express = require("express");
const { pool } = require("../config/db");
const { requireModuleAccess } = require("../lib/permissions");
const { graphConfigured, createProjectFolder } = require("../lib/graph");

const router = express.Router();

const LATEST_PROGRESS_SUBQUERY = `
  LEFT JOIN LATERAL (
    SELECT progress
    FROM projectportfolioprogress
    WHERE projectid = p.id
    ORDER BY datadate DESC NULLS LAST, id DESC
    LIMIT 1
  ) pp ON true
`;

// Shared by both places a project's status can change (drag-and-drop
// /:id/stage and the edit modal's /:id). Reads the current status first so
// a projectstatushistory row only gets written when it actually changed —
// backs the Reports "Project timeline" (see routes/reports.js). Runs
// inside the caller's existing try/catch, so DB errors just propagate.
async function logStatusChangeAndUpdate(projectId, newStatus, employeeId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT projectstatusid FROM projects WHERE id = $1 FOR UPDATE`, [projectId]);
    const oldStatus = rows[0]?.projectstatusid ?? null;
    await client.query(
      `UPDATE projects SET projectstatusid = $1, lastupdated = now(), lastupdatedby = $2 WHERE id = $3`,
      [newStatus, employeeId || null, projectId]
    );
    if (oldStatus !== null && String(oldStatus) !== String(newStatus)) {
      await client.query(
        `INSERT INTO projectstatushistory (projectid, oldstatusid, newstatusid, changedat, changedby)
         VALUES ($1, $2, $3, now(), $4)`,
        [projectId, oldStatus, newStatus, employeeId || null]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// GET /api/projects — full portfolio list for the kanban board. Includes
// three booleans purely for the card badges (not invoiceable, missing
// budget, missing business partner) — "budget" mirrors the Reports
// "Projects by status" chart's definition: the latest projectquotations
// row's finalquotation, per project. ownerId/ownerName power the kanban
// card's initials badge and the Filters panel's owner select — projectowners
// technically allows multiple rows per project, but this app treats it as
// a single owner (see PATCH /:id), so LIMIT 1 by id DESC picks the most
// recently assigned if more than one ever exists.
router.get("/", requireModuleAccess("projects"), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.id,
             p.projectnumber AS code,
             p.projectname   AS name,
             p.projectstatusid AS stage,
             COALESCE(pp.progress, 0) AS progress,
             p.lastupdated,
             p.lastupdatedby,
             COALESCE(p.notinvoiceable, false) AS "notInvoiceable",
             (p.busspartnerid IS NOT NULL) AS "hasBusinessPartner",
             (latestq.finalquotation IS NOT NULL) AS "hasBudget",
             owner."ownerId", owner."ownerName"
      FROM projects p
      ${LATEST_PROGRESS_SUBQUERY}
      LEFT JOIN LATERAL (
        SELECT finalquotation
        FROM projectquotations q
        WHERE q.projectid = p.id
        ORDER BY q.quotationdate DESC NULLS LAST, q.id DESC
        LIMIT 1
      ) latestq ON true
      LEFT JOIN LATERAL (
        SELECT e.id AS "ownerId", TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)) AS "ownerName"
        FROM projectowners po
        JOIN employees e ON e.id = po.projectownerid::bigint
        WHERE po.projectid = p.id
        ORDER BY po.id DESC
        LIMIT 1
      ) owner ON true
      ORDER BY p.projectnumber DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/projects] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/projects/statuses — canonical stage labels + display order,
// so the frontend doesn't have to hardcode PrjStatusId numbers.
router.get("/statuses", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, projectstatusdesc AS label, ordinal
       FROM projectstatus
       ORDER BY ordinal NULLS LAST, id`
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/projects/statuses] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/projects/lookups — small reference lists for the project edit
// modal (entity, biotech spectrum, project type). Mirrors /statuses.
router.get("/lookups", async (req, res) => {
  try {
    const [entities, biotechSpectrums, projectTypes] = await Promise.all([
      pool.query(`SELECT id, entitydesc AS label FROM entity ORDER BY entitydesc`),
      pool.query(`SELECT id, spectrumdesc AS label FROM biotechspectrums ORDER BY spectrumdesc`),
      pool.query(`SELECT id, projecttypedesc AS label FROM projecttypes ORDER BY projecttypedesc`),
    ]);
    res.json({
      entities: entities.rows,
      biotechSpectrums: biotechSpectrums.rows,
      projectTypes: projectTypes.rows,
    });
  } catch (err) {
    console.error("[GET /api/projects/lookups] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/projects/attention — two watch-lists for the kanban side panel:
//   readyToClose  Delivered projects whose invoiced-to-date total has
//                 reached (or passed) the latest quotation's finalquotation.
//   stale         Lead/Oferta/Guanyat projects opened more than 3 months
//                 ago whose most recent status change (or, if none logged,
//                 their entry date) is more than 2 weeks old.
// Must be declared before GET /:id so "attention" isn't taken as an id.
router.get("/attention", requireModuleAccess("projects"), async (req, res) => {
  try {
    const [readyToClose, stale] = await Promise.all([
      pool.query(`
        SELECT p.id, p.projectnumber AS code, p.projectname AS name,
               q.finalquotation AS budget,
               COALESCE(inv.total, 0) AS "invoicedTotal"
        FROM projects p
        JOIN projectstatus ps ON ps.id = p.projectstatusid::bigint
        LEFT JOIN LATERAL (
          SELECT finalquotation FROM projectquotations
          WHERE projectid = p.id ORDER BY quotationdate DESC NULLS LAST, id DESC LIMIT 1
        ) q ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(d.amount), 0) AS total
          FROM invoices i
          LEFT JOIN invoicesdetails d ON d.invoiceid = i.id
          WHERE i.projectid = p.id::double precision AND i.invoicestatusid IS DISTINCT FROM 6
        ) inv ON true
        WHERE LOWER(ps.projectstatusdesc) = 'delivered'
          AND q.finalquotation IS NOT NULL AND q.finalquotation > 0
          AND COALESCE(inv.total, 0) >= q.finalquotation
        ORDER BY p.projectnumber DESC
      `),
      pool.query(`
        SELECT p.id, p.projectnumber AS code, p.projectname AS name,
               ps.projectstatusdesc AS "statusLabel",
               p.entrydate AS "entryDate",
               lsc.changedat AS "lastStatusChangeAt"
        FROM projects p
        JOIN projectstatus ps ON ps.id = p.projectstatusid::bigint
        LEFT JOIN LATERAL (
          SELECT MAX(changedat) AS changedat FROM projectstatushistory h WHERE h.projectid = p.id
        ) lsc ON true
        WHERE LOWER(ps.projectstatusdesc) IN ('lead', 'oferta', 'guanyat')
          AND p.entrydate IS NOT NULL
          AND p.entrydate < now() - INTERVAL '3 months'
          AND COALESCE(lsc.changedat, p.entrydate) < now() - INTERVAL '2 weeks'
        ORDER BY COALESCE(lsc.changedat, p.entrydate) ASC
      `),
    ]);
    res.json({ readyToClose: readyToClose.rows, stale: stale.rows });
  } catch (err) {
    console.error("[GET /api/projects/attention] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/projects/:id — single project detail, including the fields
// shown on the Access "EditProject" form's General tab (entity, biotech
// spectrum, project type, contracting business partner, invoicing business
// partner) resolved to human-readable labels via their lookup tables.
// Deliverables/quotations/expenses/notes get their own routes later.
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.projectnumber AS code, p.projectname AS name,
              p.projectstatusid AS stage, COALESCE(pp.progress, 0) AS progress,
              p.entrydate, p.entityid, ent.entitydesc AS "entityLabel",
              p.biospectrumid, bs.spectrumdesc AS "biospectrumLabel",
              p.projecttypeid, pt.projecttypedesc AS "projectTypeLabel",
              p.busspartnerid, bp.bpname AS "businessPartnerLabel",
              p.busspartnertoinvoiceid, tc.taxcompanyname AS "invoicingPartnerLabel",
              p.bprunningname, p.notinvoiceable,
              p.lastupdated, p.lastupdatedby,
              NULLIF(TRIM(CONCAT(upd.employeefirstname, ' ', upd.employeelastname)), '') AS "lastUpdatedByName",
              owner."ownerId", owner."ownerName"
       FROM projects p
       ${LATEST_PROGRESS_SUBQUERY}
       LEFT JOIN entity ent ON ent.id = p.entityid::bigint
       LEFT JOIN biotechspectrums bs ON bs.id = p.biospectrumid::bigint
       LEFT JOIN projecttypes pt ON pt.id = p.projecttypeid::bigint
       LEFT JOIN businesspartners bp ON bp.id = p.busspartnerid::bigint
       LEFT JOIN taxcompanies tc ON tc.id = p.busspartnertoinvoiceid::bigint
       LEFT JOIN employees upd ON upd.id = p.lastupdatedby::bigint
       LEFT JOIN LATERAL (
         SELECT e.id AS "ownerId", TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)) AS "ownerName"
         FROM projectowners po
         JOIN employees e ON e.id = po.projectownerid::bigint
         WHERE po.projectid = p.id
         ORDER BY po.id DESC
         LIMIT 1
       ) owner ON true
       WHERE p.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("[GET /api/projects/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// POST /api/projects — create a project (+ optional initial progress row).
router.post("/", requireModuleAccess("projects"), async (req, res) => {
  const { code, name, stage, progress, entityId, biospectrumId, projectTypeId, ownerId, employeeId } = req.body || {};
  if (!name || stage === undefined) {
    return res.status(400).json({ error: "validation_error", message: "name and stage are required" });
  }

  let project;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO projects (projectnumber, projectname, projectstatusid, entityid,
                              biospectrumid, projecttypeid,
                              projectyear, entrydate, lastupdated, lastupdatedby)
       VALUES ($1, $2, $3, $4, $5, $6, EXTRACT(YEAR FROM now()), now(), now(), $7)
       RETURNING id, projectnumber AS code, projectname AS name, projectstatusid AS stage`,
      [code || null, name, stage, entityId || null, biospectrumId || null, projectTypeId || null, employeeId || null]
    );
    project = rows[0];

    if (progress !== undefined) {
      await client.query(
        `INSERT INTO projectportfolioprogress (projectid, progress, updatedby, updatedat, datadate)
         VALUES ($1, $2, $3, now(), now())`,
        [project.id, progress, employeeId || null]
      );
    }

    if (ownerId) {
      await client.query(
        `INSERT INTO projectowners (projectid, projectownerid) VALUES ($1, $2)`,
        [project.id, ownerId]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[POST /api/projects] DB error:", err.message);
    client.release();
    return res.status(502).json({ error: "database_unreachable", message: err.message });
  }
  client.release();

  // Best-effort OneDrive folder creation (see lib/graph.js) — never lets a
  // Graph hiccup roll back or fail project creation, which has already
  // committed by this point. Needs entityId (folder naming: "code_entity
  // name") and the GRAPH_* env vars to actually be set; skipped silently
  // otherwise. The frontend surfaces oneDriveFolder in its toast so a
  // failure here isn't silent to the person creating the project.
  let oneDriveFolder = null;
  if (entityId && graphConfigured()) {
    const folderName = `${project.code}_${String(entityId).padStart(3, "0")} ${project.name}`;
    try {
      const created = await createProjectFolder(folderName);
      oneDriveFolder = { created: true, name: created.name, webUrl: created.webUrl };
    } catch (err) {
      console.error("[POST /api/projects] OneDrive folder creation failed:", err.message);
      oneDriveFolder = { created: false, error: err.message };
    }
  }

  res.status(201).json({ ...project, progress: progress || 0, oneDriveFolder });
});

// PATCH /api/projects/:id/stage — drag-and-drop move between kanban columns.
router.patch("/:id/stage", async (req, res) => {
  const { id } = req.params;
  const { stage, employeeId } = req.body || {};
  if (stage === undefined) {
    return res.status(400).json({ error: "validation_error", message: "stage is required" });
  }
  try {
    await logStatusChangeAndUpdate(id, stage, employeeId);
    res.status(204).end();
  } catch (err) {
    console.error("[PATCH /api/projects/:id/stage] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// PATCH /api/projects/:id/business-partner — assign the Contracting
// Business Partner, from the picker modal (mirrors Access's
// SearchBusinessPartners.frm "double-click to assign" flow). Applies
// immediately, same convention as /:id/stage.
router.patch("/:id/business-partner", async (req, res) => {
  const { id } = req.params;
  const { businessPartnerId, employeeId } = req.body || {};
  if (!businessPartnerId) {
    return res.status(400).json({ error: "validation_error", message: "businessPartnerId is required" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT p.busspartnerid, bp.bpname AS "businessPartnerLabel"
       FROM projects p LEFT JOIN businesspartners bp ON bp.id = p.busspartnerid::bigint
       WHERE p.id = $1 FOR UPDATE OF p`,
      [id]
    );
    const cur = rows[0] || {};
    const { rows: newBpRows } = await client.query(`SELECT bpname AS label FROM businesspartners WHERE id = $1`, [businessPartnerId]);
    const newLabel = newBpRows[0]?.label ?? null;

    await client.query(
      `UPDATE projects SET busspartnerid = $1, lastupdated = now(), lastupdatedby = $2 WHERE id = $3`,
      [businessPartnerId, employeeId || null, id]
    );
    if (String(businessPartnerId) !== String(cur.busspartnerid)) {
      const summary = cur.busspartnerid
        ? `Business partner changed from ${cur.businessPartnerLabel || "—"} to ${newLabel || "—"}`
        : `Business partner assigned: ${newLabel || "—"}`;
      await client.query(
        `INSERT INTO projectchangelog (projectid, changedat, changedby, summary) VALUES ($1, now(), $2, $3)`,
        [id, employeeId || null, summary]
      );
    }
    await client.query("COMMIT");
    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[PATCH /api/projects/:id/business-partner] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/projects/:id/invoicing-partner — set which of the
// contracting business partner's tax companies to invoice (Access's
// cmbTaxCompanies combo, scoped to the assigned BP). Applies
// immediately, same convention as /:id/business-partner.
router.patch("/:id/invoicing-partner", async (req, res) => {
  const { id } = req.params;
  const { taxCompanyId, employeeId } = req.body || {};
  if (!taxCompanyId) {
    return res.status(400).json({ error: "validation_error", message: "taxCompanyId is required" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT p.busspartnertoinvoiceid, tc.taxcompanyname AS "taxCompanyLabel"
       FROM projects p LEFT JOIN taxcompanies tc ON tc.id = p.busspartnertoinvoiceid::bigint
       WHERE p.id = $1 FOR UPDATE OF p`,
      [id]
    );
    const cur = rows[0] || {};
    const { rows: newTcRows } = await client.query(`SELECT taxcompanyname AS label FROM taxcompanies WHERE id = $1`, [taxCompanyId]);
    const newLabel = newTcRows[0]?.label ?? null;

    await client.query(
      `UPDATE projects SET busspartnertoinvoiceid = $1, lastupdated = now(), lastupdatedby = $2 WHERE id = $3`,
      [taxCompanyId, employeeId || null, id]
    );
    if (String(taxCompanyId) !== String(cur.busspartnertoinvoiceid)) {
      const summary = cur.busspartnertoinvoiceid
        ? `Invoicing partner changed from ${cur.taxCompanyLabel || "—"} to ${newLabel || "—"}`
        : `Invoicing partner assigned: ${newLabel || "—"}`;
      await client.query(
        `INSERT INTO projectchangelog (projectid, changedat, changedby, summary) VALUES ($1, now(), $2, $3)`,
        [id, employeeId || null, summary]
      );
    }
    await client.query("COMMIT");
    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[PATCH /api/projects/:id/invoicing-partner] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/projects/:id — general edit from the project modal (status,
// progress, and the General-tab fields mirrored from the Access
// EditProject form: entity, biotech spectrum, project type, BP running
// name, not-invoiceable).
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const {
    stage, progress, employeeId,
    name, entityId, biospectrumId, projectTypeId, bpRunningName, notInvoiceable, ownerId,
  } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Read the current row (+ resolved labels, + latest progress) once,
    // locked, before any updates — both for the existing stage-history
    // logging AND to build human-readable projectchangelog summaries for
    // everything else this endpoint can change. See GET /:id/history,
    // which merges projectstatushistory (stage only) with this new table.
    const { rows: curRows } = await client.query(
      `SELECT p.projectstatusid, p.projectname, p.entityid, ent.entitydesc AS "entityLabel",
              p.biospectrumid, bs.spectrumdesc AS "biospectrumLabel",
              p.projecttypeid, pt.projecttypedesc AS "projectTypeLabel",
              p.bprunningname, p.notinvoiceable,
              pp.progress AS "currentProgress"
       FROM projects p
       LEFT JOIN entity ent ON ent.id = p.entityid::bigint
       LEFT JOIN biotechspectrums bs ON bs.id = p.biospectrumid::bigint
       LEFT JOIN projecttypes pt ON pt.id = p.projecttypeid::bigint
       LEFT JOIN LATERAL (
         SELECT progress FROM projectportfolioprogress
         WHERE projectid = p.id ORDER BY datadate DESC NULLS LAST, id DESC LIMIT 1
       ) pp ON true
       WHERE p.id = $1
       FOR UPDATE OF p`,
      [id]
    );
    const cur = curRows[0] || {};
    const changes = []; // human-readable summaries -> projectchangelog

    if (stage !== undefined) {
      // Same history-logging as /:id/stage.
      const oldStatus = cur.projectstatusid ?? null;
      await client.query(
        `UPDATE projects SET projectstatusid = $1, lastupdated = now(), lastupdatedby = $2 WHERE id = $3`,
        [stage, employeeId || null, id]
      );
      if (oldStatus !== null && String(oldStatus) !== String(stage)) {
        await client.query(
          `INSERT INTO projectstatushistory (projectid, oldstatusid, newstatusid, changedat, changedby)
           VALUES ($1, $2, $3, now(), $4)`,
          [id, oldStatus, stage, employeeId || null]
        );
      }
    }
    if (progress !== undefined) {
      // Only write a new progress snapshot (and a history line) when the
      // value actually changed. A project with no progress row yet is
      // treated as 0% — otherwise saving the modal with progress left at 0
      // logged a bogus "Progress changed from 0% to 0%" every time.
      const prevProgress = cur.currentProgress != null ? Number(cur.currentProgress) : 0;
      if (prevProgress !== Number(progress)) {
        await client.query(
          `INSERT INTO projectportfolioprogress (projectid, progress, updatedby, updatedat, datadate)
           VALUES ($1, $2, $3, now(), now())`,
          [id, progress, employeeId || null]
        );
        changes.push(`Progress changed from ${prevProgress}% to ${progress}%`);
      }
    }
    if (name !== undefined && !name.trim()) {
      await client.query("ROLLBACK");
      client.release();
      return res.status(400).json({ error: "validation_error", message: "name cannot be empty" });
    }

    // Resolve NEW labels only for whichever of entity/biospectrum/type
    // actually changed, so an unrelated save (e.g. just progress) doesn't
    // do pointless extra lookups.
    let newEntityLabel = null, newBiospectrumLabel = null, newProjectTypeLabel = null;
    if (entityId != null && String(entityId) !== String(cur.entityid)) {
      const r = await client.query(`SELECT entitydesc AS label FROM entity WHERE id = $1`, [entityId]);
      newEntityLabel = r.rows[0]?.label ?? null;
    }
    if (biospectrumId != null && String(biospectrumId) !== String(cur.biospectrumid)) {
      const r = await client.query(`SELECT spectrumdesc AS label FROM biotechspectrums WHERE id = $1`, [biospectrumId]);
      newBiospectrumLabel = r.rows[0]?.label ?? null;
    }
    if (projectTypeId != null && String(projectTypeId) !== String(cur.projecttypeid)) {
      const r = await client.query(`SELECT projecttypedesc AS label FROM projecttypes WHERE id = $1`, [projectTypeId]);
      newProjectTypeLabel = r.rows[0]?.label ?? null;
    }

    if (name !== undefined || entityId !== undefined || biospectrumId !== undefined || projectTypeId !== undefined
        || bpRunningName !== undefined || notInvoiceable !== undefined) {
      await client.query(
        `UPDATE projects SET
           projectname = COALESCE($1, projectname),
           entityid = COALESCE($2, entityid),
           biospectrumid = COALESCE($3, biospectrumid),
           projecttypeid = COALESCE($4, projecttypeid),
           bprunningname = COALESCE($5, bprunningname),
           notinvoiceable = COALESCE($6, notinvoiceable),
           lastupdated = now(), lastupdatedby = $7
         WHERE id = $8`,
        [
          name?.trim() || null, entityId ?? null, biospectrumId ?? null, projectTypeId ?? null,
          bpRunningName ?? null, notInvoiceable ?? null, employeeId || null, id,
        ]
      );

      if (name !== undefined && name.trim() !== cur.projectname) {
        changes.push(`Name changed from "${cur.projectname || ""}" to "${name.trim()}"`);
      }
      if (newEntityLabel !== null) changes.push(`Entity changed from ${cur.entityLabel || "—"} to ${newEntityLabel}`);
      if (newBiospectrumLabel !== null) changes.push(`Biotech spectrum changed from ${cur.biospectrumLabel || "—"} to ${newBiospectrumLabel}`);
      if (newProjectTypeLabel !== null) changes.push(`Project type changed from ${cur.projectTypeLabel || "—"} to ${newProjectTypeLabel}`);
      if (bpRunningName !== undefined && (bpRunningName || null) !== (cur.bprunningname || null)) {
        changes.push(`BP running name changed from "${cur.bprunningname || ""}" to "${bpRunningName || ""}"`);
      }
      if (notInvoiceable !== undefined && !!notInvoiceable !== !!cur.notinvoiceable) {
        changes.push(notInvoiceable ? "Marked as not invoiceable" : "Marked as invoiceable");
      }
    }

    // Owner — a separate table (projectowners), not a projects column, so
    // it's handled as its own read-then-write rather than folded into the
    // COALESCE UPDATE above. Treated as a single owner even though the
    // table technically allows multiple rows per project (see GET /,
    // GET /:id) — this always fully replaces whatever's there.
    if (ownerId !== undefined) {
      const { rows: curOwnerRows } = await client.query(
        `SELECT po.projectownerid, TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)) AS "ownerName"
         FROM projectowners po
         LEFT JOIN employees e ON e.id = po.projectownerid::bigint
         WHERE po.projectid = $1
         ORDER BY po.id DESC LIMIT 1`,
        [id]
      );
      const curOwner = curOwnerRows[0] || {};
      if (String(ownerId || "") !== String(curOwner.projectownerid || "")) {
        await client.query(`DELETE FROM projectowners WHERE projectid = $1`, [id]);
        let newOwnerName = null;
        if (ownerId) {
          await client.query(`INSERT INTO projectowners (projectid, projectownerid) VALUES ($1, $2)`, [id, ownerId]);
          const r = await client.query(
            `SELECT TRIM(CONCAT(employeefirstname, ' ', employeelastname)) AS name FROM employees WHERE id = $1`,
            [ownerId]
          );
          newOwnerName = r.rows[0]?.name ?? null;
        }
        if (curOwner.projectownerid && ownerId) {
          changes.push(`Owner changed from ${curOwner.ownerName || "—"} to ${newOwnerName || "—"}`);
        } else if (ownerId) {
          changes.push(`Owner assigned: ${newOwnerName || "—"}`);
        } else if (curOwner.projectownerid) {
          changes.push(`Owner removed (was ${curOwner.ownerName || "—"})`);
        }
      }
    }

    for (const summary of changes) {
      await client.query(
        `INSERT INTO projectchangelog (projectid, changedat, changedby, summary) VALUES ($1, now(), $2, $3)`,
        [id, employeeId || null, summary]
      );
    }

    await client.query("COMMIT");
    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[PATCH /api/projects/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// GET /api/projects/:id/history — every logged change for this one
// project, newest first: status transitions (projectstatushistory, as
// before) UNIONed with everything else (projectchangelog — name, entity,
// biotech spectrum, project type, BP running name, not-invoiceable,
// progress, business/invoicing partner assignment; see the PATCH handlers
// above). Powers the project modal's collapsible History side panel.
// Deliberately a separate route from GET /api/reports/project-timeline
// (which only covers status changes and requires the Reports module) —
// seeing a project's history you can already view and edit shouldn't also
// require Reports access.
router.get("/:id/history", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT 'status' AS type, h.id, h.oldstatusid AS "oldStatusId", os.projectstatusdesc AS "oldStatusLabel",
              h.newstatusid AS "newStatusId", ns.projectstatusdesc AS "newStatusLabel",
              NULL::text AS summary,
              h.changedat AS "changedAt", h.changedby AS "changedBy",
              NULLIF(TRIM(CONCAT(e1.employeefirstname, ' ', e1.employeelastname)), '') AS "changedByName"
       FROM projectstatushistory h
       LEFT JOIN projectstatus os ON os.id = h.oldstatusid
       LEFT JOIN projectstatus ns ON ns.id = h.newstatusid
       LEFT JOIN employees e1 ON e1.id = h.changedby
       WHERE h.projectid = $1

       UNION ALL

       SELECT 'change' AS type, c.id, NULL::bigint AS "oldStatusId", NULL::text AS "oldStatusLabel",
              NULL::bigint AS "newStatusId", NULL::text AS "newStatusLabel",
              c.summary,
              c.changedat AS "changedAt", c.changedby AS "changedBy",
              NULLIF(TRIM(CONCAT(e2.employeefirstname, ' ', e2.employeelastname)), '') AS "changedByName"
       FROM projectchangelog c
       LEFT JOIN employees e2 ON e2.id = c.changedby
       WHERE c.projectid = $1

       ORDER BY "changedAt" DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/projects/:id/history] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Resources tab — projectresources (id, projectid, resourceid, amount).
// "amount" is workload % (default 50, matches the "not deactivated
// employees only" + "% of work load" ask). Every write is logged to
// projectchangelog same as everything else on this modal.
// ---------------------------------------------------------------------------

// GET /api/projects/:id/resources
router.get("/:id/resources", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.resourceid AS "employeeId", r.amount,
              TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)) AS "employeeName"
       FROM projectresources r
       JOIN employees e ON e.id = r.resourceid::bigint
       WHERE r.projectid = $1
       ORDER BY e.employeefirstname, e.employeelastname`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/projects/:id/resources] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// POST /api/projects/:id/resources — assign an employee (defaults to 50%
// workload if not specified).
router.post("/:id/resources", async (req, res) => {
  const { resourceId, amount, employeeId } = req.body || {};
  if (!resourceId) {
    return res.status(400).json({ error: "validation_error", message: "resourceId is required" });
  }
  try {
    const workload = amount ?? 50;
    const { rows } = await pool.query(
      `INSERT INTO projectresources (projectid, resourceid, amount)
       VALUES ($1, $2, $3)
       RETURNING id, resourceid AS "employeeId", amount`,
      [req.params.id, resourceId, workload]
    );
    const { rows: empRows } = await pool.query(
      `SELECT TRIM(CONCAT(employeefirstname, ' ', employeelastname)) AS name FROM employees WHERE id = $1`,
      [resourceId]
    );
    const empName = empRows[0]?.name ?? "—";
    await pool.query(
      `INSERT INTO projectchangelog (projectid, changedat, changedby, summary) VALUES ($1, now(), $2, $3)`,
      [req.params.id, employeeId || null, `Resource added: ${empName} (${workload}%)`]
    );
    res.status(201).json({ ...rows[0], employeeName: empName });
  } catch (err) {
    console.error("[POST /api/projects/:id/resources] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// PATCH /api/projects/:id/resources/:resourceRowId — change workload %.
router.patch("/:id/resources/:resourceRowId", async (req, res) => {
  const { amount, employeeId } = req.body || {};
  if (amount == null) {
    return res.status(400).json({ error: "validation_error", message: "amount is required" });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE projectresources SET amount = $1
       WHERE id = $2 AND projectid = $3
       RETURNING id, resourceid AS "employeeId", amount`,
      [amount, req.params.resourceRowId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    const { rows: empRows } = await pool.query(
      `SELECT TRIM(CONCAT(employeefirstname, ' ', employeelastname)) AS name FROM employees WHERE id = $1`,
      [rows[0].employeeId]
    );
    const empName = empRows[0]?.name ?? "—";
    await pool.query(
      `INSERT INTO projectchangelog (projectid, changedat, changedby, summary) VALUES ($1, now(), $2, $3)`,
      [req.params.id, employeeId || null, `Resource workload changed: ${empName} → ${amount}%`]
    );
    res.json({ ...rows[0], employeeName: empName });
  } catch (err) {
    console.error("[PATCH /api/projects/:id/resources/:resourceRowId] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// DELETE /api/projects/:id/resources/:resourceRowId
router.delete("/:id/resources/:resourceRowId", async (req, res) => {
  const { employeeId } = req.body || {};
  try {
    const { rows } = await pool.query(
      `DELETE FROM projectresources WHERE id = $1 AND projectid = $2
       RETURNING resourceid AS "employeeId"`,
      [req.params.resourceRowId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    const { rows: empRows } = await pool.query(
      `SELECT TRIM(CONCAT(employeefirstname, ' ', employeelastname)) AS name FROM employees WHERE id = $1`,
      [rows[0].employeeId]
    );
    const empName = empRows[0]?.name ?? "—";
    await pool.query(
      `INSERT INTO projectchangelog (projectid, changedat, changedby, summary) VALUES ($1, now(), $2, $3)`,
      [req.params.id, employeeId || null, `Resource removed: ${empName}`]
    );
    res.status(204).end();
  } catch (err) {
    console.error("[DELETE /api/projects/:id/resources/:resourceRowId] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Project modal sub-tabs: deliverables, notes, quotations. Mirrors the
// Access "EditProject" form's subforms of the same name.
// ---------------------------------------------------------------------------

// GET /api/projects/:id/deliverables
router.get("/:id/deliverables", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, deliverablename, deliverydate, effectivedd
       FROM projectdeliverables
       WHERE projectid = $1
       ORDER BY deliverydate NULLS LAST, id`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/projects/:id/deliverables] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// POST /api/projects/:id/deliverables — add a new deliverable row.
router.post("/:id/deliverables", async (req, res) => {
  const { deliverablename, deliverydate, effectivedd } = req.body || {};
  if (!deliverablename) {
    return res.status(400).json({ error: "validation_error", message: "deliverablename is required" });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO projectdeliverables (projectid, deliverablename, deliverydate, effectivedd)
       VALUES ($1, $2, $3, $4)
       RETURNING id, deliverablename, deliverydate, effectivedd`,
      [req.params.id, deliverablename, deliverydate || null, effectivedd || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("[POST /api/projects/:id/deliverables] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// PATCH /api/projects/:id/deliverables/:deliverableId — edit name/dates.
router.patch("/:id/deliverables/:deliverableId", async (req, res) => {
  const { deliverablename, deliverydate, effectivedd } = req.body || {};
  if (!deliverablename) {
    return res.status(400).json({ error: "validation_error", message: "deliverablename is required" });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE projectdeliverables
       SET deliverablename = $1, deliverydate = $2, effectivedd = $3
       WHERE id = $4 AND projectid = $5
       RETURNING id, deliverablename, deliverydate, effectivedd`,
      [deliverablename, deliverydate || null, effectivedd || null, req.params.deliverableId, req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: "not_found", message: "Deliverable not found on this project" });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error("[PATCH /api/projects/:id/deliverables/:deliverableId] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// DELETE /api/projects/:id/deliverables/:deliverableId
router.delete("/:id/deliverables/:deliverableId", async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM projectdeliverables WHERE id = $1 AND projectid = $2`,
      [req.params.deliverableId, req.params.id]
    );
    if (!rowCount) {
      return res.status(404).json({ error: "not_found", message: "Deliverable not found on this project" });
    }
    res.status(204).end();
  } catch (err) {
    console.error("[DELETE /api/projects/:id/deliverables/:deliverableId] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/projects/:id/notes — newest first, author resolved via employees.
router.get("/:id/notes", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT n.id, n.notes, n.commentsts, n.employeeid,
              NULLIF(TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)), '') AS "authorName"
       FROM projectnotes n
       LEFT JOIN employees e ON e.id = n.employeeid::bigint
       WHERE n.projectid = $1
       ORDER BY n.commentsts DESC NULLS LAST, n.id DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/projects/:id/notes] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// POST /api/projects/:id/notes — add a note.
router.post("/:id/notes", async (req, res) => {
  const { notes, employeeId } = req.body || {};
  if (!notes || !notes.trim()) {
    return res.status(400).json({ error: "validation_error", message: "notes text is required" });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO projectnotes (projectid, notes, employeeid, commentsts)
       VALUES ($1, $2, $3, now())
       RETURNING id, notes, commentsts, employeeid`,
      [req.params.id, notes.trim(), employeeId || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("[POST /api/projects/:id/notes] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/projects/:id/quotations
router.get("/:id/quotations", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, amountquoted, expenses, discountnegotiation, finalquotation,
              quotationdate, details
       FROM projectquotations
       WHERE projectid = $1
       ORDER BY quotationdate DESC NULLS LAST, id DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/projects/:id/quotations] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// POST /api/projects/:id/quotations — add a new quotation row. Logs a
// projectchangelog entry (see GET /:id/history) — this is real money data,
// worth tracking who added what and when same as any other project edit.
router.post("/:id/quotations", async (req, res) => {
  const { quotationdate, amountquoted, discountnegotiation, expenses, finalquotation, details, employeeId } = req.body || {};
  try {
    const { rows } = await pool.query(
      `INSERT INTO projectquotations
         (projectid, quotationdate, amountquoted, discountnegotiation, expenses, finalquotation, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, amountquoted, expenses, discountnegotiation, finalquotation, quotationdate, details`,
      [
        req.params.id, quotationdate || null, amountquoted ?? null, discountnegotiation ?? null,
        expenses ?? null, finalquotation ?? null, details || null,
      ]
    );
    const q = rows[0];
    const amount = q.finalquotation ?? q.amountquoted;
    const summary = `Quotation added: ${amount != null ? `€${Number(amount).toLocaleString()}` : "(no amount)"}` +
      (q.quotationdate ? ` dated ${new Date(q.quotationdate).toLocaleDateString()}` : "");
    await pool.query(
      `INSERT INTO projectchangelog (projectid, changedat, changedby, summary) VALUES ($1, now(), $2, $3)`,
      [req.params.id, employeeId || null, summary]
    );
    res.status(201).json(q);
  } catch (err) {
    console.error("[POST /api/projects/:id/quotations] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

module.exports = router;
