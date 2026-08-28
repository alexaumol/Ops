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
 * See server/lib/audit.js for the table and the best-effort logAudit()
 * helper used by the mutation routes (projects, time-tracking, business
 * partners).
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
    action: type,
    entityType: "session",
    summary: type === "login" ? "Signed in" : "Signed out",
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
      `SELECT a.id, a.at, a.employeeid AS "employeeId", a.username,
              NULLIF(TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)), '') AS "employeeName",
              a.action, a.entitytype AS "entityType", a.entityid AS "entityId",
              a.summary, a.ipaddress AS "ip", a.computername AS "computer", a.useragent AS "userAgent",
              COUNT(*) OVER() AS "totalCount"
       FROM auditlog a
       LEFT JOIN employees e ON e.id = a.employeeid
       WHERE ($1::bigint IS NULL OR a.employeeid = $1::bigint)
         AND ($2::date IS NULL OR a.at >= $2::date)
         AND ($3::date IS NULL OR a.at < ($3::date + INTERVAL '1 day'))
         AND ($4::text IS NULL OR a.summary ILIKE '%' || $4 || '%' OR a.action ILIKE '%' || $4 || '%'
              OR a.username ILIKE '%' || $4 || '%' OR a.ipaddress ILIKE '%' || $4 || '%'
              OR TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)) ILIKE '%' || $4 || '%')
       ORDER BY a.at DESC
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
      `SELECT DISTINCT a.employeeid AS id,
              COALESCE(NULLIF(TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)), ''), a.username) AS name
       FROM auditlog a
       LEFT JOIN employees e ON e.id = a.employeeid
       WHERE a.employeeid IS NOT NULL
       ORDER BY name`
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/audit/users] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

module.exports = router;
