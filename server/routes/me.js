/**
 * /api/me — self-service profile for the signed-in user.
 * ---------------------------------------------------------------------------
 * Backs the "Profile" item in the header avatar menu. Unlike /api/settings
 * (admin only), this is available to any authenticated employee, but it can
 * only touch a limited set of the caller's OWN fields:
 *   - employees.employeefirstname / employeelastname
 *   - employeesinfo: birthday, showbirthday, personal contact, emergency
 *     contacts, bank, avatarimage, avatarusephoto
 * username / work email / onboarding date / termination date are read-only
 * here (managed by an admin in Settings) and silently ignored if sent.
 * ---------------------------------------------------------------------------
 */
const express = require("express");
const { pool } = require("../config/db");
const { logAudit } = require("../lib/audit");
const {
  ensureEmployeeProfileSchema, upsertEmployeeInfo, employeeInfoRow,
} = require("../lib/employeeProfile");

const router = express.Router();

// The employeesinfo keys a user may edit about themselves.
const SELF_INFO_KEYS = [
  "birthdaydate", "showbirthday",
  "phone_personal", "email_personal",
  "phone_emergency1", "contact_emergency1",
  "phone_emergency2", "contact_emergency2",
  "bankname", "bankacctemp",
  "avatarimage", "avatarusephoto",
];

function requireSelf(req, res) {
  const employeeId = req.hittUser?.employeeId;
  if (!employeeId) {
    res.status(403).json({
      error: "no_employee",
      message: "Your sign-in isn't linked to an employee record — contact an admin.",
    });
    return null;
  }
  return employeeId;
}

async function selfProfile(employeeId, isAdmin) {
  const { rows } = await pool.query(
    `SELECT employeefirstname AS "firstName", employeelastname AS "lastName",
            username, emailid
     FROM employees WHERE id = $1`,
    [employeeId]
  );
  if (!rows.length) return null;
  return { ...rows[0], isAdmin: !!isAdmin, info: await employeeInfoRow(employeeId) };
}

// GET /api/me/profile
router.get("/profile", async (req, res) => {
  const employeeId = requireSelf(req, res);
  if (!employeeId) return;
  try {
    await ensureEmployeeProfileSchema();
    const profile = await selfProfile(employeeId, req.hittUser.isAdmin);
    if (!profile) return res.status(404).json({ error: "not_found", message: "Employee not found." });
    res.json(profile);
  } catch (err) {
    console.error("[GET /api/me/profile] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// PATCH /api/me/profile   { firstName, lastName, info }
router.patch("/profile", async (req, res) => {
  const employeeId = requireSelf(req, res);
  if (!employeeId) return;
  const { firstName, lastName, info } = req.body || {};
  if (!firstName || !firstName.trim() || !lastName || !lastName.trim()) {
    return res.status(400).json({ error: "bad_request", message: "First and last name are required." });
  }
  try {
    await ensureEmployeeProfileSchema();
    const { rowCount } = await pool.query(
      `UPDATE employees SET employeefirstname = $1, employeelastname = $2 WHERE id = $3`,
      [firstName.trim(), lastName.trim(), employeeId]
    );
    if (!rowCount) return res.status(404).json({ error: "not_found", message: "Employee not found." });

    // upsertEmployeeInfo is a full overwrite of the managed columns, so
    // merge the caller's self-editable keys over the current row — this
    // keeps admin-only fields (onboard/termination date, docs path)
    // untouched. `undefined` 3rd arg leaves employeedocumentpath alone.
    const current = await employeeInfoRow(employeeId);
    const merged = { ...current };
    for (const k of SELF_INFO_KEYS) if (info && k in info) merged[k] = info[k];
    await upsertEmployeeInfo(employeeId, merged);

    const profile = await selfProfile(employeeId, req.hittUser.isAdmin);
    res.json(profile);
    logAudit(req, {
      kind: "settings.user.self-edit",
      desc: `${firstName.trim()} ${lastName.trim()} updated their own profile`,
    });
  } catch (err) {
    console.error("[PATCH /api/me/profile] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

module.exports = router;
