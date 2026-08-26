/**
 * /api/permissions — "what can the calling user do" for the frontend to
 * gate nav items/buttons on. Real enforcement still happens server-side
 * per module (see requireModuleAccess/requireAdmin in lib/permissions.js)
 * — this endpoint is for UI decisions, not the security boundary itself.
 */
const express = require("express");
const { pool } = require("../config/db");
const { MODULE_KEYS, isTimeOffApprover } = require("../lib/permissions");

const router = express.Router();

// GET /api/permissions/me
router.get("/me", async (req, res) => {
  const { employeeId, isAdmin, isDeactivated } = req.hittUser || {};
  if (!employeeId) {
    // Identity didn't resolve to a real employee (e.g. stub-mode typo, or a
    // header that doesn't match any employee record). Fail open on module
    // access (matches the open-by-default model) but report no elevated
    // roles.
    return res.json({ employeeId: null, name: null, firstName: null, isAdmin: false, isTimeOffApprover: false, isDeactivated: false, restrictedModules: [] });
  }
  try {
    // The frontend's session.displayName is only ever a guess derived from
    // the login username/email (see auth.js deriveDisplayName) — accurate
    // for real MSAL sign-in (Entra returns a real display name) but not for
    // stub-mode short usernames like "abellmunt" (nothing to derive "Alba"
    // from). This is the authoritative source: the employees row we already
    // resolved this identity to.
    const { rows: nameRows } = await pool.query(
      `SELECT employeefirstname AS "firstName",
              TRIM(CONCAT(employeefirstname, ' ', employeelastname)) AS name
       FROM employees WHERE id = $1`,
      [employeeId]
    );
    const firstName = nameRows[0]?.firstName || null;
    const name = nameRows[0]?.name || null;

    if (isDeactivated) {
      // Known employee, explicitly cut off — report everything restricted
      // so the frontend can show a clear "deactivated" state instead of
      // the normal module grid. Real enforcement is server-side (see
      // requireModuleAccess/requireAdmin/requireTimeOffApprover), this is
      // just what the UI renders.
      return res.json({ employeeId, name, firstName, isAdmin: false, isTimeOffApprover: false, isDeactivated: true, restrictedModules: MODULE_KEYS });
    }

    const approver = await isTimeOffApprover(employeeId);
    let restrictedModules = [];
    if (!isAdmin) {
      const { rows } = await pool.query(
        `SELECT modulekey FROM modulerestrictions WHERE employeeid = $1`,
        [employeeId]
      );
      restrictedModules = rows.map((r) => r.modulekey);
    }
    res.json({ employeeId, name, firstName, isAdmin: !!isAdmin, isTimeOffApprover: approver, isDeactivated: false, restrictedModules });
  } catch (err) {
    console.error("[GET /api/permissions/me] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/permissions/module-keys — the known module keys, so the
// Settings page doesn't need to hardcode them separately.
router.get("/module-keys", (req, res) => res.json(MODULE_KEYS));

module.exports = router;
