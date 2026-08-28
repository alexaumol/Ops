/**
 * /api/audit
 * ---------------------------------------------------------------------------
 * - POST /session-event   any signed-in user logs their own sign in / out
 *                          (the frontend calls this from js/auth.js). Not
 *                          admin-gated — you can only ever record your own.
 * - GET  /logs            admin-only paginated audit-log reader, filterable
 *                          by user / date range / free text.
 * - GET  /users           admin-only: the distinct users present in the log,
 *                          for the filter dropdown.
 *
 * Reads public.actionsaudit. See server/lib/audit.js for the column layout
 * and the best-effort logAudit() helper the mutation routes call.
 * ---------------------------------------------------------------------------
 */
const express = require("express");
const { pool } = require("../config/db");
const { requireAdmin } = require("../lib/permissions");
const { logAudit, ensureAuditSchema } = require("../lib/audit");

const router = express.Router();

// POST /api/audit/session-event   { type: 'login' | 'logout', userAgent, platform }
router.post("/session-event", async (req, res) => {
  const { type, userAgent, platform } = req.body || {};
  if (type !== "login" && type !== "logout") {
    return res.status(400).json({ error: "bad_request", message: "type must be 'login' or 'logout'." });
  }
  await logAudit(req, {
    kind: type,
    desc: type === "login" ? "Signed in" : "Signed out",
    level: 2,
    computerName: platform || null,
    userAgent: userAgent || null,
  });
  res.status(204).end();
});

// GET /api/audit/logs?userId=&startDate=&endDate=&search=&page=&limit=
router.get("/logs", requireAdmin, async (req, res) => {
  try {
    await ensureAuditSchema();
    const { userId, startDate, endDate, search } = req.query;
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const offset = (page - 1) * limit;
    const { rows } = await pool.query(
      `SELECT a.id, a.actionts AS at, a.actionuserid AS "employeeId", a.actionusername AS username,
              NULLIF(TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)), '') AS "employeeName",
              a.actionkind AS action, a.actiondesc AS summary,
              a.actionip AS ip, a.actioncomputer AS computer, a.actionenvironment AS "userAgent",
              a.loglevel AS level,
              COUNT(*) OVER() AS "totalCount"
       FROM actionsaudit a
       LEFT JOIN employees e ON e.id = a.actionuserid
       WHERE ($1::bigint IS NULL OR a.actionuserid = $1::bigint)
         AND ($2::date IS NULL OR a.actionts >= $2::date)
         AND ($3::date IS NULL OR a.actionts < ($3::date + INTERVAL '1 day'))
         AND ($4::text IS NULL OR a.actiondesc ILIKE '%' || $4 || '%' OR a.actionkind ILIKE '%' || $4 || '%'
              OR a.actionusername ILIKE '%' || $4 || '%' OR a.actionip ILIKE '%' || $4 || '%'
              OR TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)) ILIKE '%' || $4 || '%')
       ORDER BY a.actionts DESC NULLS LAST
       LIMIT $5 OFFSET $6`,
      [userId || null, startDate || null, endDate || null, search || null, limit, offset]
    );
    const total = rows.length ? Number(rows[0].totalCount) : 0;
    res.json({ rows: rows.map(({ totalCount, ...r }) => r), total, page, limit });
  } catch (err) {
    console.error("[GET /api/audit/logs] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/audit/users — distinct users present in the log.
router.get("/users", requireAdmin, async (req, res) => {
  try {
    await ensureAuditSchema();
    const { rows } = await pool.query(
      `SELECT DISTINCT a.actionuserid AS id,
              COALESCE(NULLIF(TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)), ''),
                       a.actionusername, 'Employee #' || a.actionuserid) AS name
       FROM actionsaudit a
       LEFT JOIN employees e ON e.id = a.actionuserid
       WHERE a.actionuserid IS NOT NULL
       ORDER BY name`
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/audit/users] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

module.exports = router;
