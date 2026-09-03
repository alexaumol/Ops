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
 * Admins bypass every module restriction (mirrors Access's "global admins,
 * regardless of environment"), but do NOT automatically count as a
 * time-off approver — that's a fully independent flag, requested
 * explicitly after Settings' UI/copy implied otherwise. Someone who needs
 * both has to be granted both.
 *
 * `employees.deactivated` (pre-existing column, already used to filter
 * lookups) is enforced here too: a deactivated employee is denied by every
 * gate below regardless of admin/approver/module-access state — this is
 * the one case that fails CLOSED rather than open, since it's a known
 * identity being explicitly cut off, not an unrecognized one.
 *
 * IDENTITY — how the caller is identified, controlled by AUTH_MODE (env):
 *
 *   bearer  (default when AAD_TENANT_ID + AAD_CLIENT_ID are set)
 *           Every request must carry a valid, signature-verified Entra ID
 *           access token as `Authorization: Bearer <jwt>` (see
 *           lib/entraToken.js). The X-HITT-User header is ignored. A
 *           missing/invalid token is a 401 (see requireAuth).
 *   hybrid  A valid Bearer token wins. If none is present, fall back to
 *           trusting X-HITT-User (a warning is logged). A Bearer token
 *           that IS present but invalid is still a 401 — no silent
 *           downgrade. Use during rollout, then switch to bearer.
 *   header  (default when AAD is not configured) Legacy behaviour: trust
 *           the client-supplied X-HITT-User header. NOT cryptographically
 *           secure — anyone who can reach the API can forge it. Dev /
 *           offline / stub-login / rollback only.
 *
 * MODULE_KEYS: 'projects' | 'business-partners' | 'time-allocation' |
 * 'invoicing' | 'expenses' | 'reports' | 'chat'. 'time-allocation' covers
 * both routes/timeTracking.js and routes/timeOff.js — they're one module in
 * the frontend menu. 'chat' gates the Ops assistant (routes/chat.js).
 * ---------------------------------------------------------------------------
 */
const { pool } = require("../config/db");
const { entraConfigured, verifyEntraToken, identityFromClaims } = require("./entraToken");
const { oidcConfigured, verifyOidcToken, identityFromOidcClaims, looksLikeOidc } = require("./oidcToken");

const AUTH_MODE = (
  process.env.AUTH_MODE ||
  ((process.env.AAD_TENANT_ID && process.env.AAD_CLIENT_ID) || oidcConfigured() ? "bearer" : "header")
).toLowerCase();

if (!["bearer", "hybrid", "header"].includes(AUTH_MODE)) {
  console.error(`[permissions] invalid AUTH_MODE="${AUTH_MODE}" — falling back to "header". Valid: bearer | hybrid | header.`);
}
const RESOLVED_AUTH_MODE = ["bearer", "hybrid", "header"].includes(AUTH_MODE) ? AUTH_MODE : "header";

const MODULE_KEYS = ["projects", "business-partners", "time-allocation", "invoicing", "expenses", "reports", "presence", "chat"];

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
  const { rows } = await pool.query(`SELECT 1 FROM timeoffapprovers WHERE employeeid = $1`, [employeeId]);
  return rows.length > 0;
}

// Presence register (registro de jornada) — two access tiers on top of the
// employee's own register:
//   presence admin  — configure the register + act on an employee's behalf
//   presence viewer — read + export EVERY employee's register (worker legal
//                     representatives / Inspección de Trabajo), no edit
// Admins implicitly have both. Managed as allow-lists in Settings → Users.
async function isPresenceAdmin(employeeId) {
  if (!employeeId) return false;
  if (await isAdmin(employeeId)) return true;
  const { rows } = await pool.query(`SELECT 1 FROM presence_admins WHERE employee_id = $1`, [employeeId]);
  return rows.length > 0;
}

async function isPresenceViewer(employeeId) {
  if (!employeeId) return false;
  if (await isPresenceAdmin(employeeId)) return true;
  const { rows } = await pool.query(`SELECT 1 FROM presence_viewers WHERE employee_id = $1`, [employeeId]);
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

// Express middleware: establishes req.hittUser once per request:
//   { raw, employeeId, isAdmin, isDeactivated, authMethod, authError, claims }
// where authMethod is 'bearer' | 'header' | 'none' and authError is a
// string when a Bearer token was supplied but failed verification.
//
// This never rejects on its own — requireAuth (mounted globally in
// server.js) turns authError / a missing token in bearer mode into a 401,
// and the per-route gates below decide the rest. All the gates deny a
// deactivated employee regardless of their roles (mirrors Access's
// chkDeactivateUser: "won't be able to login ... until reactivation").
async function attachHittUser(req, res, next) {
  const rawHeader = req.header("X-HITT-User") || null;
  const authz = req.header("Authorization") || "";
  const bearer = authz.startsWith("Bearer ") ? authz.slice(7).trim() : null;

  let identity = null;
  let authMethod = "none";
  let authError = null;
  let claims = null;

  // 1. Try the Bearer token (unless AUTH_MODE forces legacy header-only).
  //    Route to whichever verifier the token's issuer matches — OIDC (the
  //    shared broker / a customer IdP) and Entra can both be live during a
  //    cutover. Try OIDC first; fall back to Entra for anything that isn't
  //    a JWT from the OIDC issuer.
  if (bearer && RESOLVED_AUTH_MODE !== "header") {
    const useOidc = oidcConfigured() && (looksLikeOidc(bearer) || !entraConfigured());
    try {
      if (useOidc) {
        claims = await verifyOidcToken(bearer);
        identity = identityFromOidcClaims(claims);
        authMethod = "bearer";
      } else if (entraConfigured()) {
        claims = await verifyEntraToken(bearer);
        identity = identityFromClaims(claims);
        authMethod = "bearer";
      }
    } catch (err) {
      authError = err.message || "token verification failed";
      console.warn(`[attachHittUser] Bearer token rejected (${useOidc ? "oidc" : "entra"}): ${authError}`);
    }
  }

  // 2. Fall back to the X-HITT-User header — but only in header/hybrid mode,
  //    and only when no Bearer token was offered at all (a present-but-bad
  //    token must not silently downgrade to a forgeable header).
  if (!identity && !authError && RESOLVED_AUTH_MODE !== "bearer") {
    identity = rawHeader;
    if (identity) authMethod = "header";
  }

  try {
    const emp = identity ? await resolveEmployee(identity) : null;
    const employeeId = emp?.id ?? null;
    const isDeactivated = emp?.deactivated ?? false;
    const admin = isDeactivated ? false : await isAdmin(employeeId);
    req.hittUser = { raw: identity, employeeId, isAdmin: admin, isDeactivated, authMethod, authError, claims };
  } catch (err) {
    console.error("[attachHittUser] DB error:", err.message);
    req.hittUser = { raw: identity, employeeId: null, isAdmin: false, isDeactivated: false, authMethod, authError, claims };
  }
  next();
}

// Global gate (server.js mounts it right after attachHittUser): rejects a
// request whose Bearer token failed verification, and — in bearer mode —
// any request that isn't carrying a verified token at all. Everything
// downstream can then assume identity is either trustworthy or absent by
// choice (header/hybrid dev modes), never forged past a broken token.
function requireAuth(req, res, next) {
  if (req.hittUser?.authError) {
    return res.status(401).json({
      error: "invalid_token",
      message: "Your session token is invalid or has expired. Please sign in again.",
    });
  }
  if (RESOLVED_AUTH_MODE === "bearer" && req.hittUser?.authMethod !== "bearer") {
    return res.status(401).json({
      error: "auth_required",
      message: "Authentication required. Please sign in again.",
    });
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

function requirePresenceRole(check, label) {
  return async (req, res, next) => {
    if (req.hittUser?.isDeactivated) {
      return res.status(403).json({ error: "forbidden", message: "Your account has been deactivated." });
    }
    try {
      if (!(await check(req.hittUser?.employeeId))) {
        return res.status(403).json({ error: "forbidden", message: label });
      }
      next();
    } catch (err) {
      console.error("[requirePresenceRole] DB error:", err.message);
      res.status(502).json({ error: "database_unreachable", message: err.message });
    }
  };
}
const requirePresenceAdmin = () => requirePresenceRole(isPresenceAdmin, "Presence admin role required.");
const requirePresenceViewer = () => requirePresenceRole(isPresenceViewer, "You don't have access to other employees' registers.");

module.exports = {
  MODULE_KEYS,
  AUTH_MODE: RESOLVED_AUTH_MODE,
  resolveEmployee,
  isAdmin,
  isTimeOffApprover,
  isPresenceAdmin,
  isPresenceViewer,
  canAccessModule,
  attachHittUser,
  requireAuth,
  requireModuleAccess,
  requireAdmin,
  requireTimeOffApprover,
  requirePresenceAdmin,
  requirePresenceViewer,
};
