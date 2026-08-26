/**
 * Permissions layer
 * ---------------------------------------------------------------------------
 * Access's old model (Auth.bas) hardcoded specific usernames directly in
 * VBA code per permission type ("mbuxade" for time-off approval, etc.) plus
 * a global-admin override for "aaumedes"/"osola" — no database table at
 * all. Replaced here with three small tables instead:
 *
 *   admins              employeeid — allow-list. Presence = Admin role,
 *                        absence = User (the default). No separate "User"
 *                        rows needed since it's the fallback.
 *   modulerestrictions   employeeid, modulekey — BLOCK-list. Presence =
 *                        blocked from that module. Default (no row) = has
 *                        access. Confirmed with Alex: open-by-default,
 *                        restrict-as-needed, so nothing broke for anyone
 *                        the moment this shipped.
 *   timeoffapprovers     employeeid — allow-list. Presence = can
 *                        approve/reject ANYONE's time-off requests.
 *
 * Admins bypass every module restriction and always count as a time-off
 * approver — mirrors Access's "global admins, regardless of environment".
 *
 * `employees.deactivated` (pre-existing column, already used to filter
 * lookups) is enforced here too: a deactivated employee is denied by every
 * gate below regardless of admin/approver/module-access state — this is
 * the one case that fails CLOSED rather than open, since it's a known
 * identity being explicitly cut off, not an unrecognized one.
 *
 * IMPORTANT — same caveat as everywhere else auth-related in this app: the
 * caller's identity comes from the client-supplied X-HITT-User header
 * (api.js), not a verified bearer token. This raises the bar over zero
 * enforcement but is NOT cryptographically secure — someone could still
 * forge the header directly against the API. Real security needs the
 * deferred server-side MSAL ID-token validation (see js/auth.js).
 *
 * MODULE_KEYS: 'projects' | 'business-partners' | 'time-allocation' |
 * 'invoicing'. 'time-allocation' covers both routes/timeTracking.js and
 * routes/timeOff.js — they're one module in the frontend menu.
 * ---------------------------------------------------------------------------
 */
const { pool } = require("../config/db");

const MODULE_KEYS = ["projects", "business-partners", "time-allocation", "invoicing"];

// Resolves the X-HITT-User header (a stub-mode short username OR a real
// MSAL UPN/email — this app supports both auth modes) to an employees row.
// Tries an exact username/email match, then the UPN's local-part against
// username, all case-insensitively. Returns null if nothing matches.
// Deliberately does NOT filter out deactivated employees here — attachHittUser
// needs to tell "unknown identity" (fails open, see canAccessModule) apart
// from "known but deactivated" (must fail CLOSED — see requireModuleAccess/
// requireAdmin/requireTimeOffApprover below), and can only do that if this
// still resolves deactivated employees instead of silently missing them.
async function resolveEmployee(usernameOrEmail) {
  if (!usernameOrEmail) return null;
  const { rows } = await pool.query(
    `SELECT id, deactivated FROM employees
     WHERE LOWER(username) = LOWER($1)
        OR LOWER(emailid) = LOWER($1)
        OR LOWER(username) = LOWER(split_part($1, '@', 1))
     LIMIT 1`,
    [usernameOrEmail]
  );
  return rows.length ? rows[0] : null;
}

async function isAdmin(employeeId) {
  if (!employeeId) return false;
  const { rows } = await pool.query(`SELECT 1 FROM admins WHERE employeeid = $1`, [employeeId]);
  return rows.length > 0;
}

async function isTimeOffApprover(employeeId) {
  if (!employeeId) return false;
  if (await isAdmin(employeeId)) return true;
  const { rows } = await pool.query(`SELECT 1 FROM timeoffapprovers WHERE employeeid = $1`, [employeeId]);
  return rows.length > 0;
}

async function canAccessModule(employeeId, moduleKey) {
  if (!employeeId) return true; // unresolved identity (e.g. stub auth typo) — fail open, matches open-by-default
  if (await isAdmin(employeeId)) return true;
  const { rows } = await pool.query(
    `SELECT 1 FROM modulerestrictions WHERE employeeid = $1 AND modulekey = $2`,
    [employeeId, moduleKey]
  );
  return rows.length === 0;
}

// Express middleware: resolves req.header('X-HITT-User') once per request
// into req.hittUser = { raw, employeeId, isAdmin, isDeactivated }. Never
// rejects by itself — individual routes decide what to do via
// requireModuleAccess/requireAdmin/requireTimeOffApprover below, all of
// which deny a deactivated employee regardless of their roles (mirrors
// Access's chkDeactivateUser: "won't be able to login ... until
// reactivation").
async function attachHittUser(req, res, next) {
  const raw = req.header("X-HITT-User") || null;
  try {
    const emp = await resolveEmployee(raw);
    const employeeId = emp?.id ?? null;
    const isDeactivated = emp?.deactivated ?? false;
    const admin = isDeactivated ? false : await isAdmin(employeeId);
    req.hittUser = { raw, employeeId, isAdmin: admin, isDeactivated };
  } catch (err) {
    console.error("[attachHittUser] DB error:", err.message);
    req.hittUser = { raw, employeeId: null, isAdmin: false, isDeactivated: false };
  }
  next();
}

function requireModuleAccess(moduleKey) {
  return async (req, res, next) => {
    if (req.hittUser?.isDeactivated) {
      return res.status(403).json({ error: "forbidden", message: "Your account has been deactivated." });
    }
    try {
      const allowed = await canAccessModule(req.hittUser?.employeeId, moduleKey);
      if (!allowed) {
        return res.status(403).json({ error: "forbidden", message: `You don't have access to the ${moduleKey} module.` });
      }
      next();
    } catch (err) {
      console.error("[requireModuleAccess] DB error:", err.message);
      res.status(502).json({ error: "database_unreachable", message: err.message });
    }
  };
}

function requireAdmin(req, res, next) {
  if (req.hittUser?.isDeactivated) {
    return res.status(403).json({ error: "forbidden", message: "Your account has been deactivated." });
  }
  if (!req.hittUser?.isAdmin) {
    return res.status(403).json({ error: "forbidden", message: "Admin role required." });
  }
  next();
}

function requireTimeOffApprover() {
  return async (req, res, next) => {
    if (req.hittUser?.isDeactivated) {
      return res.status(403).json({ error: "forbidden", message: "Your account has been deactivated." });
    }
    try {
      const ok = await isTimeOffApprover(req.hittUser?.employeeId);
      if (!ok) {
        return res.status(403).json({ error: "forbidden", message: "You're not a time-off approver." });
      }
      next();
    } catch (err) {
      console.error("[requireTimeOffApprover] DB error:", err.message);
      res.status(502).json({ error: "database_unreachable", message: err.message });
    }
  };
}

module.exports = {
  MODULE_KEYS,
  resolveEmployee,
  isAdmin,
  isTimeOffApprover,
  canAccessModule,
  attachHittUser,
  requireModuleAccess,
  requireAdmin,
  requireTimeOffApprover,
};
