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
const { requireModuleAccess } = require("../lib/permissions");
const { logAudit } = require("../lib/audit");

const router = express.Router();

// Small helper so audit summaries name the project rather than just its id.
async function projectLabel(projectId) {
  try {
    const { rows } = await pool.query(`SELECT projectnumber FROM projects WHERE id = $1::bigint`, [projectId]);
    return rows[0]?.projectnumber ? `project ${rows[0].projectnumber}` : `project #${projectId}`;
  } catch {
    return `project #${projectId}`;
  }
}

// GET /api/time-tracking?userId=X&weekStart=YYYY-MM-DD
router.get("/", requireModuleAccess("time-allocation"), async (req, res) => {
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

// GET /api/time-tracking/summary?userId=X — hours logged per week, for the
// side panel. Current + previous calendar year only. Each row is one
// tracked week (its Monday), tagged with the month that Monday falls in,
// split into PO (project-owner) and RES (resource) hours. The frontend
// rolls these up year -> month -> week.
router.get("/summary", requireModuleAccess("time-allocation"), async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "validation_error", message: "userId is required" });
  try {
    const { rows } = await pool.query(
      `SELECT EXTRACT(YEAR FROM t.projtimetrackdate)::int AS year,
              EXTRACT(MONTH FROM t.projtimetrackdate)::int AS month,
              TO_CHAR(t.projtimetrackdate, 'YYYY-MM-DD') AS "weekStart",
              COALESCE(SUM(t.projtimetrackhours) FILTER (WHERE t.po_res = 'PO'), 0) AS "poHours",
              COALESCE(SUM(t.projtimetrackhours) FILTER (WHERE t.po_res = 'RES'), 0) AS "resHours"
       FROM projectstimetracking t
       WHERE t.userid = $1
         AND t.projtimetrackdate IS NOT NULL
         AND EXTRACT(YEAR FROM t.projtimetrackdate) >= EXTRACT(YEAR FROM CURRENT_DATE) - 1
       GROUP BY 1, 2, 3
       ORDER BY 1 DESC, 2 DESC, 3 DESC`,
      [userId]
    );
    res.json(rows.map((r) => ({
      year: r.year,
      month: r.month,
      weekStart: r.weekStart,
      poHours: Number(r.poHours),
      resHours: Number(r.resHours),
    })));
  } catch (err) {
    console.error("[GET /api/time-tracking/summary] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// POST /api/time-tracking — upsert one project's hours for a week.
router.post("/", requireModuleAccess("time-allocation"), async (req, res) => {
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
    let wasUpdate;
    if (existing.rows.length) {
      wasUpdate = true;
      const { rows } = await pool.query(
        `UPDATE projectstimetracking SET projtimetrackhours = $1, po_res = $2, projtimetrackts = now()
         WHERE id = $3
         RETURNING id, projtimetrackhours AS hours, po_res AS "poRes", projtimetrackts AS "lastUpdated"`,
        [hours, poRes || null, existing.rows[0].id]
      );
      row = rows[0];
    } else {
      wasUpdate = false;
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

    projectLabel(projectId).then((label) =>
      logAudit(req, {
        kind: wasUpdate ? "timetracking.update" : "timetracking.insert",
        desc: `${wasUpdate ? "Updated" : "Logged"} ${hours}h (${poRes || "—"}) on ${label}, week of ${weekStart}`,
      })
    );
  } catch (err) {
    console.error("[POST /api/time-tracking] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// DELETE /api/time-tracking/:id — remove a project row from the week.
router.delete("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM projectstimetracking WHERE id = $1
       RETURNING projectid, projtimetrackhours AS hours, projtimetrackdate AS "weekStart"`,
      [req.params.id]
    );
    res.status(204).end();

    if (rows.length) {
      const r = rows[0];
      projectLabel(r.projectid).then((label) =>
        logAudit(req, {
          kind: "timetracking.delete",
          desc: `Deleted time tracking (${r.hours ?? "—"}h) on ${label}`,
        })
      );
    }
  } catch (err) {
    console.error("[DELETE /api/time-tracking/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

module.exports = router;
