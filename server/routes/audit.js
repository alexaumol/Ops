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
// Whitelisted sort columns -> SQL expression. Anything else falls back to
// the timestamp. Every sort has actionts DESC as a stable tiebreak.
const AUDIT_SORT = {
  at: "a.actionts",
  user: "COALESCE(NULLIF(TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)), ''), a.actionusername)",
  action: "a.actionkind",
  details: "a.actiondesc",
  ip: "a.actionip",
  computer: "a.actioncomputer",
};

router.get("/logs", requireAdmin, async (req, res) => {
  try {
    await ensureAuditSchema();
    const { userId, startDate, endDate, search, kind } = req.query;
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const offset = (page - 1) * limit;

    const sortExpr = AUDIT_SORT[req.query.sort] || AUDIT_SORT.at;
    const dir = String(req.query.dir).toLowerCase() === "asc" ? "ASC" : "DESC";
    const orderBy = sortExpr === AUDIT_SORT.at
      ? `a.actionts ${dir} NULLS LAST`
      : `${sortExpr} ${dir} NULLS LAST, a.actionts DESC`;

    // `kind` filters exact machine code, OR a whole category via "cat:project"
    // (matches "project.%" plus the bare login/logout pair for "cat:session").
    let kindClause = "TRUE";
    const params = [userId || null, startDate || null, endDate || null, search || null];
    if (kind && kind.startsWith("cat:")) {
      const cat = kind.slice(4);
      if (cat === "session") { kindClause = `a.actionkind IN ('login', 'logout')`; }
      else { params.push(`${cat}.%`); kindClause = `a.actionkind LIKE $${params.length}`; }
    } else if (kind) {
      params.push(kind);
      kindClause = `a.actionkind = $${params.length}`;
    }
    params.push(limit, offset);

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
         AND ($4::text IS NULL OR a.actiondesc ILIKE '%' || $4 || '%')
         AND ${kindClause}
       ORDER BY ${orderBy}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const total = rows.length ? Number(rows[0].totalCount) : 0;
    res.json({ rows: rows.map(({ totalCount, ...r }) => r), total, page, limit });
  } catch (err) {
    console.error("[GET /api/audit/logs] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/audit/summary — the two counters for the Auditing side column.
//  - connectedUsers: users whose most recent session event in the last 18h
//    is a sign-in (not a sign-out) — a best-effort "currently signed in",
//    from the audit trail (there's no server-side session store).
//  - actionsToday: every audit row since local midnight.
router.get("/summary", requireAdmin, async (req, res) => {
  try {
    await ensureAuditSchema();
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM actionsaudit
          WHERE actionts >= date_trunc('day', now())) AS "actionsToday",
        (SELECT COUNT(*) FROM (
           SELECT DISTINCT ON (actionuserid) actionusername, actionkind
           FROM actionsaudit
           WHERE actionkind IN ('login', 'logout')
             AND actionuserid IS NOT NULL
             AND actionts >= now() - INTERVAL '18 hours'
           ORDER BY actionuserid, actionts DESC
         ) s WHERE actionkind = 'login') AS "connectedUsers"
    `);
    res.json({
      connectedUsers: Number(rows[0].connectedUsers) || 0,
      actionsToday: Number(rows[0].actionsToday) || 0,
    });
  } catch (err) {
    console.error("[GET /api/audit/summary] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/audit/kinds — distinct action codes present, for the filter.
router.get("/kinds", requireAdmin, async (req, res) => {
  try {
    await ensureAuditSchema();
    const { rows } = await pool.query(
      `SELECT DISTINCT actionkind AS kind FROM actionsaudit WHERE actionkind IS NOT NULL ORDER BY actionkind`
    );
    res.json(rows.map((r) => r.kind));
  } catch (err) {
    console.error("[GET /api/audit/kinds] DB error:", err.message);
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
