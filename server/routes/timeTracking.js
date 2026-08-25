/**
 * /api/time-tracking
 * ---------------------------------------------------------------------------
 * Project time tracking — logging hours against projects for a given week.
 * Mirrors Access's "Project Time Tracking.frm" + "Time tracking.frm"
 * subform. Real schema (confirmed 2026-08-25):
 *
 *   projectstimetracking   id, projectid, projtimetrackweek,
 *                          projtimetrackdate (Monday of that week),
 *                          projtimetrackhours, projtimetrackts, projexpenses,
 *                          islead, lockforedit, po_res ("PO" or "RES"),
 *                          userid
 *
 * Scope note: this is deliberately just the project-hours grid. The
 * separate personal daily-hours log (timeallocationlog — "how many hours
 * did you work today, period") and the time-off request workflow
 * (timeoffrequests) are different tables/forms in Access and are NOT
 * covered here — see INTERNAL.md.
 * ---------------------------------------------------------------------------
 */
const express = require("express");
const { pool } = require("../config/db");

const router = express.Router();

// GET /api/time-tracking?userId=X&weekStart=YYYY-MM-DD
router.get("/", async (req, res) => {
  const { userId, weekStart } = req.query;
  if (!userId || !weekStart) {
    return res.status(400).json({ error: "validation_error", message: "userId and weekStart are required" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.projectid, p.projectnumber AS code, p.projectname AS name,
              ps.projectstatusdesc AS "statusLabel",
              t.projtimetrackhours AS hours, t.po_res AS "poRes", t.projtimetrackts AS "lastUpdated"
       FROM projectstimetracking t
       LEFT JOIN projects p ON p.id = t.projectid::bigint
       LEFT JOIN projectstatus ps ON ps.id = p.projectstatusid::bigint
       WHERE t.userid = $1 AND t.projtimetrackdate = $2::date
       ORDER BY p.projectnumber DESC`,
      [userId, weekStart]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/time-tracking] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// POST /api/time-tracking — upsert one project's hours for a week.
router.post("/", async (req, res) => {
  const { userId, projectId, week, weekStart, hours, poRes } = req.body || {};
  if (!userId || !projectId || !week || !weekStart || hours === undefined) {
    return res.status(400).json({ error: "validation_error", message: "userId, projectId, week, weekStart and hours are required" });
  }
  try {
    const existing = await pool.query(
      `SELECT id FROM projectstimetracking WHERE userid = $1 AND projectid = $2 AND projtimetrackdate = $3::date`,
      [userId, projectId, weekStart]
    );
    let row;
    if (existing.rows.length) {
      const { rows } = await pool.query(
        `UPDATE projectstimetracking SET projtimetrackhours = $1, po_res = $2, projtimetrackts = now()
         WHERE id = $3
         RETURNING id, projtimetrackhours AS hours, po_res AS "poRes", projtimetrackts AS "lastUpdated"`,
        [hours, poRes || null, existing.rows[0].id]
      );
      row = rows[0];
    } else {
      const { rows } = await pool.query(
        `INSERT INTO projectstimetracking
           (userid, projectid, projtimetrackweek, projtimetrackdate, projtimetrackhours, po_res, projtimetrackts)
         VALUES ($1, $2, $3, $4::date, $5, $6, now())
         RETURNING id, projtimetrackhours AS hours, po_res AS "poRes", projtimetrackts AS "lastUpdated"`,
        [userId, projectId, week, weekStart, hours, poRes || null]
      );
      row = rows[0];
    }
    res.status(200).json(row);
  } catch (err) {
    console.error("[POST /api/time-tracking] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// DELETE /api/time-tracking/:id — remove a project row from the week.
router.delete("/:id", async (req, res) => {
  try {
    await pool.query(`DELETE FROM projectstimetracking WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error("[DELETE /api/time-tracking/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

module.exports = router;
