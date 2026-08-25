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
  const { employeeId, isAdmin } = req.hittUser || {};
  if (!employeeId) {
    // Identity didn't resolve to a real employee (e.g. stub-mode typo, or
    // someone signed in whose employees row doesn't exist/is deactivated).
    // Fail open on module access (matches the open-by-default model) but
    // report no elevated roles.
    return res.json({ employeeId: null, isAdmin: false, isTimeOffApprover: false, restrictedModules: [] });
  }
  try {
    const approver = await isTimeOffApprover(employeeId);
    let restrictedModules = [];
    if (!isAdmin) {
      const { rows } = await pool.query(
        `SELECT modulekey FROM modulerestrictions WHERE employeeid = $1`,
        [employeeId]
      );
      restrictedModules = rows.map((r) => r.modulekey);
    }
    res.json({ employeeId, isAdmin: !!isAdmin, isTimeOffApprover: approver, restrictedModules });
  } catch (err) {
    console.error("[GET /api/permissions/me] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/permissions/module-keys — the known module keys, so the
// Settings page doesn't need to hardcode them separately.
router.get("/module-keys", (req, res) => res.json(MODULE_KEYS));

module.exports = router;
