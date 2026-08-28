/**
 * Audit log
 * ---------------------------------------------------------------------------
 * Every security- and data-relevant action in the app is appended to
 * public.actionsaudit — the same table the old Access app used. Its
 * pre-existing columns:
 *
 *   actionuserid      bigint   — the acting employee
 *   actiondesc        text     — human-readable description of what happened
 *   actionts          timestamp
 *   actioncomputer    varchar  — client device (see the "computer name" note
 *                                below)
 *   actionenvironment varchar  — client user-agent (truncated to 255)
 *   loglevel          bigint   — 1 = normal activity, 2 = auth event
 *
 * Topped up at runtime (ALTER TABLE ... ADD COLUMN IF NOT EXISTS — mirrored
 * in server/db/schema-changes.sql) with:
 *
 *   actionusername    varchar  — the raw X-HITT-User value, so an entry is
 *                                still attributable when the identity didn't
 *                                resolve to an employees row
 *   actionkind        varchar  — a stable machine code ("project.create",
 *                                "bp.update", "login", …) for the UI's
 *                                category chip and future filtering
 *   actionip          varchar  — client IP (real caller, via trust proxy)
 *
 * logAudit() is best-effort: it never throws back to the caller, so an
 * audit-write failure can't break the action being audited.
 *
 * "Computer name" note: a browser cannot read the client's OS hostname, so
 * actioncomputer holds the best a web page can report — the platform string
 * from navigator.userAgentData / navigator.platform.
 * ---------------------------------------------------------------------------
 */
const { pool } = require("../config/db");

let ready = null;
function ensureAuditSchema() {
  if (!ready) {
    ready = (async () => {
      await pool.query(`ALTER TABLE public.actionsaudit ADD COLUMN IF NOT EXISTS actionusername varchar(255)`);
      await pool.query(`ALTER TABLE public.actionsaudit ADD COLUMN IF NOT EXISTS actionkind varchar(64)`);
      await pool.query(`ALTER TABLE public.actionsaudit ADD COLUMN IF NOT EXISTS actionip varchar(64)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS actionsaudit_actionts_idx ON public.actionsaudit (actionts DESC)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS actionsaudit_actionuserid_idx ON public.actionsaudit (actionuserid)`);
    })().catch((err) => {
      ready = null; // let a later call retry
      throw err;
    });
  }
  return ready;
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim() || null;
  return req.socket?.remoteAddress || req.ip || null;
}

/**
 * Best-effort audit write. Never throws.
 * @param {import('express').Request} req  for IP + the resolved req.hittUser
 * @param {object} entry { kind, desc, level?, computerName?, userAgent? }
 */
async function logAudit(req, entry) {
  try {
    await ensureAuditSchema();
    const u = (req && req.hittUser) || {};
    const { kind, desc, level = 1 } = entry || {};
    // Device info comes from headers the frontend sets on every request
    // (X-HITT-Client + the standard User-Agent); session-event passes them
    // explicitly, which takes precedence.
    const computerName = entry?.computerName || req?.headers?.["x-hitt-client"] || null;
    const userAgent = entry?.userAgent || req?.headers?.["user-agent"] || null;
    await pool.query(
      `INSERT INTO public.actionsaudit
         (actionuserid, actionusername, actionkind, actiondesc, actionts,
          actioncomputer, actionenvironment, actionip, loglevel)
       VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8)`,
      [
        u.employeeId || null,
        u.raw || null,
        kind || null,
        desc || null,
        computerName ? String(computerName).slice(0, 255) : null,
        userAgent ? String(userAgent).slice(0, 255) : null,
        req ? clientIp(req) : null,
        Number.isFinite(level) ? level : 1,
      ]
    );
  } catch (err) {
    console.error("[audit] failed to write audit entry:", err.message);
  }
}

module.exports = { logAudit, ensureAuditSchema };
