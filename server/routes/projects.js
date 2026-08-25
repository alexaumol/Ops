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

// GET /api/projects/:id — single project detail (general info only for now;
// deliverables/quotations/expenses/notes get their own routes later).
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.projectnumber AS code, p.projectname AS name,
              p.projectstatusid AS stage, COALESCE(pp.progress, 0) AS progress,
              p.entrydate, p.entityid, p.biospectrumid, p.projecttypeid,
              p.busspartnerid, p.busspartnertoinvoiceid, p.bprunningname,
              p.notinvoiceable, p.lastupdated, p.lastupdatedby
       FROM projects p
       ${LATEST_PROGRESS_SUBQUERY}
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

// PATCH /api/projects/:id — general edit from the project modal (status +
// progress today; extend with more fields as the modal grows real tabs).
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const { stage, progress, employeeId } = req.body || {};

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

module.exports = router;
