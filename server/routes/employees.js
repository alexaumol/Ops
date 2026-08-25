/**
 * /api/employees
 * ---------------------------------------------------------------------------
 * Minimal read-only employee lookup. Right now the only consumer is the
 * Time allocation page's "Logging time as" picker — there's no real
 * employee identity yet because MSAL/Entra ID sign-in isn't wired up (see
 * js/auth.js), so the stub login can't tell us who's actually typing.
 * Once real auth lands, this can resolve the signed-in user's employee
 * record directly instead of asking them to pick themselves from a list.
 * ---------------------------------------------------------------------------
 */
const express = require("express");
const { pool } = require("../config/db");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, username, emailid,
              TRIM(CONCAT(employeefirstname, ' ', employeelastname)) AS name
       FROM employees
       WHERE deactivated = false
       ORDER BY employeefirstname, employeelastname`
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/employees] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

module.exports = router;
