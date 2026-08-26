/**
 * /api/settings — admin-only management of the permissions layer
 * (server/lib/permissions.js). Backs the Settings page: who's an admin,
 * who's a time-off approver, which modules each employee is restricted
 * from, and who's deactivated. Every route here requires requireAdmin.
 * ---------------------------------------------------------------------------
 */
const express = require("express");
const { pool } = require("../config/db");
const { MODULE_KEYS, requireAdmin } = require("../lib/permissions");

const router = express.Router();

router.use(requireAdmin);

// GET /api/settings/employees
// Full roster with current role/approver/module-restriction state, for the
// Settings page's employee table.
router.get("/employees", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.id, e.username, e.emailid, e.deactivated AS "isDeactivated",
              TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)) AS name,
              (a.employeeid IS NOT NULL) AS "isAdmin",
              (t.employeeid IS NOT NULL) AS "isTimeOffApprover",
              COALESCE(
                ARRAY_AGG(mr.modulekey) FILTER (WHERE mr.modulekey IS NOT NULL),
                '{}'
              ) AS "restrictedModules"
       FROM employees e
       LEFT JOIN admins a ON a.employeeid = e.id
       LEFT JOIN timeoffapprovers t ON t.employeeid = e.id
       LEFT JOIN modulerestrictions mr ON mr.employeeid = e.id
       GROUP BY e.id, e.username, e.emailid, e.deactivated, e.employeefirstname, e.employeelastname,
                a.employeeid, t.employeeid
       ORDER BY e.deactivated, e.employeefirstname, e.employeelastname`
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/settings/employees] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/settings/module-keys
router.get("/module-keys", (req, res) => res.json(MODULE_KEYS));

// PATCH /api/settings/employees/:id/role   { isAdmin: boolean }
router.patch("/employees/:id/role", async (req, res) => {
  const employeeId = Number(req.params.id);
  const { isAdmin } = req.body;
  if (!Number.isInteger(employeeId) || typeof isAdmin !== "boolean") {
    return res.status(400).json({ error: "bad_request", message: "isAdmin (boolean) is required." });
  }
  try {
    if (isAdmin) {
      await pool.query(
        `INSERT INTO admins (employeeid, grantedby) VALUES ($1, $2)
         ON CONFLICT (employeeid) DO NOTHING`,
        [employeeId, req.hittUser.employeeId]
      );
    } else {
      await pool.query(`DELETE FROM admins WHERE employeeid = $1`, [employeeId]);
    }
    res.json({ employeeId, isAdmin });
  } catch (err) {
    console.error("[PATCH /employees/:id/role] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// PATCH /api/settings/employees/:id/timeoff-approver   { isTimeOffApprover: boolean }
router.patch("/employees/:id/timeoff-approver", async (req, res) => {
  const employeeId = Number(req.params.id);
  const { isTimeOffApprover } = req.body;
  if (!Number.isInteger(employeeId) || typeof isTimeOffApprover !== "boolean") {
    return res.status(400).json({ error: "bad_request", message: "isTimeOffApprover (boolean) is required." });
  }
  try {
    if (isTimeOffApprover) {
      await pool.query(
        `INSERT INTO timeoffapprovers (employeeid, grantedby) VALUES ($1, $2)
         ON CONFLICT (employeeid) DO NOTHING`,
        [employeeId, req.hittUser.employeeId]
      );
    } else {
      await pool.query(`DELETE FROM timeoffapprovers WHERE employeeid = $1`, [employeeId]);
    }
    res.json({ employeeId, isTimeOffApprover });
  } catch (err) {
    console.error("[PATCH /employees/:id/timeoff-approver] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// PATCH /api/settings/employees/:id/status   { isDeactivated: boolean }
// Mirrors Access's chkDeactivateUser: deactivating someone doesn't delete
// their data/activity, it just blocks every module/admin/approver gate in
// lib/permissions.js until reactivated.
router.patch("/employees/:id/status", async (req, res) => {
  const employeeId = Number(req.params.id);
  const { isDeactivated } = req.body;
  if (!Number.isInteger(employeeId) || typeof isDeactivated !== "boolean") {
    return res.status(400).json({ error: "bad_request", message: "isDeactivated (boolean) is required." });
  }
  if (isDeactivated && employeeId === Number(req.hittUser.employeeId)) {
    return res.status(400).json({ error: "bad_request", message: "You can't deactivate your own account." });
  }
  try {
    await pool.query(`UPDATE employees SET deactivated = $2 WHERE id = $1`, [employeeId, isDeactivated]);
    res.json({ employeeId, isDeactivated });
  } catch (err) {
    console.error("[PATCH /employees/:id/status] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// PATCH /api/settings/employees/:id/module-access   { moduleKey: string, hasAccess: boolean }
router.patch("/employees/:id/module-access", async (req, res) => {
  const employeeId = Number(req.params.id);
  const { moduleKey, hasAccess } = req.body;
  if (!Number.isInteger(employeeId) || !MODULE_KEYS.includes(moduleKey) || typeof hasAccess !== "boolean") {
    return res.status(400).json({
      error: "bad_request",
      message: `moduleKey (one of ${MODULE_KEYS.join(", ")}) and hasAccess (boolean) are required.`,
    });
  }
  try {
    if (hasAccess) {
      await pool.query(
        `DELETE FROM modulerestrictions WHERE employeeid = $1 AND modulekey = $2`,
        [employeeId, moduleKey]
      );
    } else {
      await pool.query(
        `INSERT INTO modulerestrictions (employeeid, modulekey, restrictedby) VALUES ($1, $2, $3)
         ON CONFLICT (employeeid, modulekey) DO NOTHING`,
        [employeeId, moduleKey, req.hittUser.employeeId]
      );
    }
    res.json({ employeeId, moduleKey, hasAccess });
  } catch (err) {
    console.error("[PATCH /employees/:id/module-access] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

module.exports = router;
