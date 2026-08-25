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
 * Nothing here queries the "_dump" tables — those are Access-side caches
 * refreshed FROM these live tables, not the other way round.
 * ---------------------------------------------------------------------------
 */
const express = require("express");
const { pool } = require("../config/db");

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

// GET /api/projects — full portfolio list for the kanban board.
router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.id,
             p.projectnumber AS code,
             p.projectname   AS name,
             p.projectstatusid AS stage,
             COALESCE(pp.progress, 0) AS progress,
             p.lastupdated,
             p.lastupdatedby
      FROM projects p
      ${LATEST_PROGRESS_SUBQUERY}
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
              NULLIF(TRIM(CONCAT(upd.employeefirstname, ' ', upd.employeelastname)), '') AS "lastUpdatedByName"
       FROM projects p
       ${LATEST_PROGRESS_SUBQUERY}
       LEFT JOIN entity ent ON ent.id = p.entityid::bigint
       LEFT JOIN biotechspectrums bs ON bs.id = p.biospectrumid::bigint
       LEFT JOIN projecttypes pt ON pt.id = p.projecttypeid::bigint
       LEFT JOIN businesspartners bp ON bp.id = p.busspartnerid::bigint
       LEFT JOIN taxcompanies tc ON tc.id = p.busspartnertoinvoiceid::bigint
       LEFT JOIN employees upd ON upd.id = p.lastupdatedby::bigint
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
router.post("/", async (req, res) => {
  const { code, name, stage, progress, entityId, employeeId } = req.body || {};
  if (!name || stage === undefined) {
    return res.status(400).json({ error: "validation_error", message: "name and stage are required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO projects (projectnumber, projectname, projectstatusid, entityid,
                              projectyear, entrydate, lastupdated, lastupdatedby)
       VALUES ($1, $2, $3, $4, EXTRACT(YEAR FROM now()), now(), now(), $5)
       RETURNING id, projectnumber AS code, projectname AS name, projectstatusid AS stage`,
      [code || null, name, stage, entityId || null, employeeId || null]
    );
    const project = rows[0];

    if (progress !== undefined) {
      await client.query(
        `INSERT INTO projectportfolioprogress (projectid, progress, updatedby, updatedat, datadate)
         VALUES ($1, $2, $3, now(), now())`,
        [project.id, progress, employeeId || null]
      );
    }

    await client.query("COMMIT");
    res.status(201).json({ ...project, progress: progress || 0 });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[POST /api/projects] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/projects/:id/stage — drag-and-drop move between kanban columns.
router.patch("/:id/stage", async (req, res) => {
  const { id } = req.params;
  const { stage, employeeId } = req.body || {};
  if (stage === undefined) {
    return res.status(400).json({ error: "validation_error", message: "stage is required" });
  }
  try {
    await pool.query(
      `UPDATE projects SET projectstatusid = $1, lastupdated = now(), lastupdatedby = $2 WHERE id = $3`,
      [stage, employeeId || null, id]
    );
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
  try {
    await pool.query(
      `UPDATE projects SET busspartnerid = $1, lastupdated = now(), lastupdatedby = $2 WHERE id = $3`,
      [businessPartnerId, employeeId || null, id]
    );
    res.status(204).end();
  } catch (err) {
    console.error("[PATCH /api/projects/:id/business-partner] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// PATCH /api/projects/:id — general edit from the project modal (status,
// progress, and the General-tab fields mirrored from the Access
// EditProject form: entity, biotech spectrum, project type, BP running
// name, not-invoiceable). Invoicing business partner (tax company) is
// still read-only here — that needs the tax-companies workflow.
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const {
    stage, progress, employeeId,
    entityId, biospectrumId, projectTypeId, bpRunningName, notInvoiceable,
  } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (stage !== undefined) {
      await client.query(
        `UPDATE projects SET projectstatusid = $1, lastupdated = now(), lastupdatedby = $2 WHERE id = $3`,
        [stage, employeeId || null, id]
      );
    }
    if (progress !== undefined) {
      await client.query(
        `INSERT INTO projectportfolioprogress (projectid, progress, updatedby, updatedat, datadate)
         VALUES ($1, $2, $3, now(), now())`,
        [id, progress, employeeId || null]
      );
    }
    if (entityId !== undefined || biospectrumId !== undefined || projectTypeId !== undefined
        || bpRunningName !== undefined || notInvoiceable !== undefined) {
      await client.query(
        `UPDATE projects SET
           entityid = COALESCE($1, entityid),
           biospectrumid = COALESCE($2, biospectrumid),
           projecttypeid = COALESCE($3, projecttypeid),
           bprunningname = COALESCE($4, bprunningname),
           notinvoiceable = COALESCE($5, notinvoiceable),
           lastupdated = now(), lastupdatedby = $6
         WHERE id = $7`,
        [
          entityId ?? null, biospectrumId ?? null, projectTypeId ?? null,
          bpRunningName ?? null, notInvoiceable ?? null, employeeId || null, id,
        ]
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

// GET /api/projects/:id/quotations — read-only; quotations are entered
// through the finance workflow, not this modal.
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

module.exports = router;
