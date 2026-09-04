/**
 * /api/settings — admin-only management of the permissions layer
 * (server/lib/permissions.js). Backs the Settings page: who's an admin,
 * who's a time-off approver, which modules each employee is restricted
 * from, and who's deactivated. Every route here requires requireAdmin.
 *
 * Also backs the Settings "Holidays" and "Work calendar" tabs:
 *   holidays               dated company/public holidays. A `source`
 *                          column (added lazily below) tags each row as
 *                          'catalonia' (bulk-imported from the Generalitat
 *                          open-data feed), 'hitt' (added by HR here), or
 *                          'legacy' (pre-existing rows, never touched by
 *                          re-import). See server/db/schema-changes.sql.
 *   corporateworkcalendar  one row per year: holidaysamount (leave-day
 *                          allowance) + labourhoursperyear (working hours).
 *                          Used as the fallback for the time-off balance
 *                          view when an employee has no employeeworkcalendar
 *                          row of their own (see routes/timeOff.js).
 * ---------------------------------------------------------------------------
 */
const express = require("express");
const { pool } = require("../config/db");
const { MODULE_KEYS, requireAdmin } = require("../lib/permissions");
const { logAudit } = require("../lib/audit");
const {
  ensureEmployeeProfileSchema, upsertEmployeeInfo, employeeInfoRow,
} = require("../lib/employeeProfile");

const router = express.Router();

router.use(requireAdmin);

// Settings → Email: DB-managed outbound-mail transports.
router.use("/email-transports", require("./emailTransports"));

async function employeeName(id) {
  try {
    const { rows } = await pool.query(
      `SELECT NULLIF(TRIM(CONCAT(employeefirstname, ' ', employeelastname)), '') AS name, username FROM employees WHERE id = $1`,
      [id]
    );
    return rows[0]?.name || rows[0]?.username || `#${id}`;
  } catch {
    return `#${id}`;
  }
}

// Public holidays open-data feed (Generalitat de Catalunya — "Dies festius
// a Catalunya"). rows.json format: meta.view.columns describes field order,
// data is an array of arrays. Columns of interest: codi / any / data /
// nom_del_festiu.
const CATALONIA_HOLIDAYS_URL =
  "https://analisi.transparenciacatalunya.cat/api/views/8qnu-agns/rows.json?accessType=DOWNLOAD";

// Idempotent one-time schema top-up — keeps the Settings features
// self-contained instead of requiring a manual migration step on deploy.
// Mirrored in server/db/schema-changes.sql for anyone applying it by hand.
let schemaReady = null;
function ensureSettingsSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`ALTER TABLE public.holidays ADD COLUMN IF NOT EXISTS source varchar(32)`);
      await pool.query(`UPDATE public.holidays SET source = 'legacy' WHERE source IS NULL`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS public.appconfig (
          configkey   varchar(64) PRIMARY KEY,
          configvalue text,
          updatedat   timestamp without time zone,
          updatedby   bigint
        )
      `);
      await ensureEmployeeProfileSchema();
    })().catch((err) => {
      schemaReady = null; // allow a later request to retry
      throw err;
    });
  }
  return schemaReady;
}

// Configurable values, surfaced on the Settings → Sync and Presence tabs. The
// server owns this list so the frontend never writes an arbitrary key.
//
//   group  : "sync" (default) | "presence" — which Settings tab it renders on
//   type   : "text" (default) | "boolean" ("on"/"") | "multi" (CSV of `options`)
//            | "location" (a provider <select> + a path box; the stored value
//              is JSON {"provider","path"}; a bare string is read as
//              {provider:"onedrive", path:<string>})
//   options   (multi only)   : [{ value, label }]
//   providers (location only): [{ value, label, placeholder, hint }]
//   master  : a boolean that gates the rest of its group in the UI + engine
//   hideWhen: { key, equals } — grey this row out when that key holds `equals`

// Storage providers offered for each Sync location. Only "onedrive" is wired
// into the engine (server/lib/externalSync.js); the others save fine but a
// sync attempt records a "not built yet" error until their backend lands.
const SYNC_PROVIDERS = [
  {
    value: "onedrive",
    label: "OneDrive / SharePoint",
    placeholder: "Clients/Projects   or   a folder link from OneDrive",
    hint: "A folder path in the company OneDrive, a \"Copy link\" sharing URL, or the browser address of the folder in OneDrive. Leave empty to use the GRAPH_ONEDRIVE_FOLDER default.",
  },
  {
    value: "gdrive",
    label: "Google Drive",
    placeholder: "Shared-drive folder link   or   folder ID",
    hint: "Saved, but Google Drive sync isn't built yet — nothing is copied there.",
  },
  {
    value: "network",
    label: "Network server (UNC)",
    placeholder: "\\\\server\\share\\Ops",
    hint: "A UNC path on the corporate LAN/VPN. Saved, but network-server sync isn't built yet.",
  },
];

const CONFIG_KEYS = {
  // --- Sync tab: external-storage backup ---------------------------------
  "sync.enabled": {
    group: "sync",
    type: "boolean",
    master: true,
    label: "Sync documents to an external storage",
    hint: "Off: the app never touches OneDrive / SharePoint. On: expense tickets, invoices and project folders are backed up as configured below.",
  },
  "sync.projects_location": {
    group: "sync",
    type: "location",
    label: "Create project folder on a remote location",
    hint: "When a project is created the app adds a subfolder here named \"PROJECTNUMBER_ENTITYID PROJECT NAME\". The catch-up job backfills any project missing one.",
    providers: SYNC_PROVIDERS,
  },
  "sync.backup_doc_types": {
    group: "sync",
    type: "multi",
    label: "Back up these document types",
    hint: "Which documents are copied to the backup location.",
    options: [
      { value: "tickets", label: "Expense tickets" },
      { value: "invoices", label: "Invoices" },
    ],
  },
  "sync.backup_under_project": {
    group: "sync",
    type: "boolean",
    label: "File backups under each document's project folder",
    hint: "On: a document goes inside its project's folder (under the project location above), so a separate backup location isn't needed. Off: documents are grouped by type at the location below.",
  },
  "sync.other_docs_location": {
    group: "sync",
    type: "location",
    label: "Backup other documents",
    hint: "Base folder where the selected document types are backed up, grouped by type (Tickets / Invoices).",
    providers: SYNC_PROVIDERS,
    hideWhen: { key: "sync.backup_under_project", equals: "on" },
  },

  // --- Presence tab: working-time register ------------------------------
  // Also editable by a "Presence admin" via PUT /api/presence/config.
  "presence.timezone": {
    group: "presence",
    label: "Presence — timezone",
    hint: "IANA timezone the working-day is recorded in (Spanish law: local wall-clock). Default Europe/Madrid.",
    placeholder: "Europe/Madrid",
  },
  "presence.default_daily_minutes": {
    group: "presence",
    label: "Presence — default working minutes per day",
    hint: "Used when an employee has no specific working-time contract row. 480 = 8 h.",
    placeholder: "480",
  },
  "presence.workdays": {
    group: "presence",
    label: "Presence — default working weekdays",
    hint: "ISO day numbers, comma-separated. 1 = Monday … 7 = Sunday. Default 1,2,3,4,5.",
    placeholder: "1,2,3,4,5",
  },
  "presence.method_doc": {
    group: "presence",
    label: "Presence — register method (consultation record)",
    hint: "The collective agreement / company agreement / employer decision (after consulting worker representatives) that establishes this register. Text or a link. Printed on the exported PDF.",
    placeholder: "Acuerdo de empresa de DD/MM/AAAA",
  },
  "presence.retention_months": {
    group: "presence",
    label: "Presence — retention (months)",
    hint: "Records are kept this long, then hard-deleted by `npm run presence:purge`. Legal minimum is 48 (four years).",
    placeholder: "48",
  },
  "presence.legal_hold": {
    group: "presence",
    label: "Presence — legal hold",
    hint: "Set to 'on' during a labour dispute or inspection to stop the retention purge from deleting anything. 'off' otherwise.",
    placeholder: "off",
  },
  "presence.privacy_notice": {
    group: "presence",
    label: "Presence — privacy notice",
    hint: "Short text shown to employees from the Presence tab (purpose, legal basis, retention, rights). Optional.",
    placeholder: "",
  },
};

// Shared projection for an employee row as the Settings table wants it —
// profile fields + role/approver/module-restriction state. Callers append
// their own WHERE (optional) + the GROUP BY + ORDER BY.
const EMPLOYEE_ROW_SELECT = `
  SELECT e.id, e.username, e.emailid, e.deactivated AS "isDeactivated",
         e.employeefirstname AS "firstName", e.employeelastname AS "lastName",
         TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)) AS name,
         (a.employeeid IS NOT NULL) AS "isAdmin",
         (t.employeeid IS NOT NULL) AS "isTimeOffApprover",
         (pa.employee_id IS NOT NULL) AS "isPresenceAdmin",
         (pv.employee_id IS NOT NULL) AS "isPresenceViewer",
         av.avatarimage AS avatar,
         COALESCE(ARRAY_AGG(mr.modulekey) FILTER (WHERE mr.modulekey IS NOT NULL), '{}') AS "restrictedModules"
  FROM employees e
  LEFT JOIN admins a ON a.employeeid = e.id
  LEFT JOIN timeoffapprovers t ON t.employeeid = e.id
  LEFT JOIN presence_admins pa ON pa.employee_id = e.id
  LEFT JOIN presence_viewers pv ON pv.employee_id = e.id
  LEFT JOIN modulerestrictions mr ON mr.employeeid = e.id
  LEFT JOIN LATERAL (
    SELECT avatarimage FROM employeesinfo
    WHERE empid = e.id::double precision AND avatarusephoto = true
    LIMIT 1
  ) av ON true
`;
const EMPLOYEE_ROW_GROUP_BY = `
  GROUP BY e.id, e.username, e.emailid, e.deactivated, e.employeefirstname, e.employeelastname,
           a.employeeid, t.employeeid, pa.employee_id, pv.employee_id, av.avatarimage
`;

async function employeeRow(id) {
  const { rows } = await pool.query(
    `${EMPLOYEE_ROW_SELECT} WHERE e.id = $1 ${EMPLOYEE_ROW_GROUP_BY}`,
    [id]
  );
  return rows[0] || null;
}

// Rejects a username/email that already belongs to another employee (case-
// insensitive) — a duplicate would break identity resolution in
// lib/permissions.js. Returns an error message string, or null if clear.
async function usernameEmailConflict(username, email, excludeId = null) {
  const u = (username || "").trim();
  const m = (email || "").trim();
  if (!u && !m) return null;
  const { rows } = await pool.query(
    `SELECT username, emailid FROM employees
     WHERE id <> COALESCE($3, -1)
       AND (($1 <> '' AND LOWER(username) = LOWER($1))
         OR ($2 <> '' AND LOWER(emailid) = LOWER($2)))
     LIMIT 1`,
    [u, m, excludeId]
  );
  if (!rows.length) return null;
  return "Another user already has that username or email.";
}

// GET /api/settings/employees
// Full roster with current role/approver/module-restriction state, for the
// Settings page's employee table.
router.get("/employees", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${EMPLOYEE_ROW_SELECT} ${EMPLOYEE_ROW_GROUP_BY}
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

// Count of admins who are also active (not deactivated) — the number that
// actually matters for "at least one admin must be active", since a
// deactivated employee's admin row existing doesn't let anyone use it.
async function countActiveAdmins(excludeEmployeeId = null) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FROM admins a
     JOIN employees e ON e.id = a.employeeid
     WHERE e.deactivated = false AND ($1::int IS NULL OR a.employeeid != $1)`,
    [excludeEmployeeId]
  );
  return Number(rows[0].count);
}

// employeesinfo read/write (the add/edit modal's whole `info` object) is
// shared with the self-service Profile modal — see lib/employeeProfile.js.

// GET /api/settings/employees/:id — full detail for the edit modal
// (profile + roles + employeesinfo).
router.get("/employees/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "bad_request", message: "A valid employee id is required." });
  }
  try {
    await ensureSettingsSchema();
    const row = await employeeRow(id);
    if (!row) return res.status(404).json({ error: "not_found", message: "Employee not found." });
    res.json({ ...row, info: await employeeInfoRow(id) });
  } catch (err) {
    console.error("[GET /api/settings/employees/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// POST /api/settings/employees   { firstName, lastName, username, email, info }
// Creates an employees record + its employeesinfo row. Roles / module
// access / approver are managed with the toggles once the row exists.
router.post("/employees", async (req, res) => {
  const { firstName, lastName, username, email, info } = req.body || {};
  if (!firstName || !firstName.trim() || !lastName || !lastName.trim()) {
    return res.status(400).json({ error: "bad_request", message: "First and last name are required." });
  }
  try {
    await ensureSettingsSchema();
    const conflict = await usernameEmailConflict(username, email);
    if (conflict) return res.status(409).json({ error: "conflict", message: conflict });

    const { rows } = await pool.query(
      `INSERT INTO employees (employeefirstname, employeelastname, username, emailid, deactivated)
       VALUES ($1, $2, $3, $4, false)
       RETURNING id`,
      [firstName.trim(), lastName.trim(), username?.trim() || null, email?.trim() || null]
    );
    const newId = rows[0].id;
    await upsertEmployeeInfo(newId, info || {});

    const row = await employeeRow(newId);
    res.status(201).json({ ...row, info: await employeeInfoRow(newId) });
    logAudit(req, {
      kind: "settings.user.add",
      desc: `Added user ${firstName.trim()} ${lastName.trim()}${username?.trim() ? ` (${username.trim()})` : ""}`,
    });
  } catch (err) {
    console.error("[POST /api/settings/employees] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// PATCH /api/settings/employees/:id/profile
//   { firstName, lastName, username, email, info }
// Edits the employee's own fields + employeesinfo. Role / status / approver
// / module access have their own endpoints.
router.patch("/employees/:id/profile", async (req, res) => {
  const employeeId = Number(req.params.id);
  const { firstName, lastName, username, email, info } = req.body || {};
  if (!Number.isInteger(employeeId)) {
    return res.status(400).json({ error: "bad_request", message: "A valid employee id is required." });
  }
  if (!firstName || !firstName.trim() || !lastName || !lastName.trim()) {
    return res.status(400).json({ error: "bad_request", message: "First and last name are required." });
  }
  try {
    await ensureSettingsSchema();
    const conflict = await usernameEmailConflict(username, email, employeeId);
    if (conflict) return res.status(409).json({ error: "conflict", message: conflict });

    const { rowCount } = await pool.query(
      `UPDATE employees
       SET employeefirstname = $1, employeelastname = $2, username = $3, emailid = $4
       WHERE id = $5`,
      [firstName.trim(), lastName.trim(), username?.trim() || null, email?.trim() || null, employeeId]
    );
    if (!rowCount) return res.status(404).json({ error: "not_found", message: "Employee not found." });

    await upsertEmployeeInfo(employeeId, info || {});

    const row = await employeeRow(employeeId);
    res.json({ ...row, info: await employeeInfoRow(employeeId) });
    logAudit(req, {
      kind: "settings.user.edit",
      desc: `Edited user ${firstName.trim()} ${lastName.trim()}`,
    });
  } catch (err) {
    console.error("[PATCH /api/settings/employees/:id/profile] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

/* ==================== APP CONFIG (Sync + Presence tabs) ============== */

// GET /api/settings/config — the configurable values, with their metadata.
router.get("/config", async (req, res) => {
  try {
    await ensureSettingsSchema();
    const { rows } = await pool.query(`SELECT configkey, configvalue FROM appconfig`);
    const stored = Object.fromEntries(rows.map((r) => [r.configkey, r.configvalue]));
    res.json({
      keys: Object.entries(CONFIG_KEYS).map(([key, meta]) => ({ key, ...meta, value: stored[key] ?? "" })),
    });
  } catch (err) {
    console.error("[GET /api/settings/config] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// PUT /api/settings/config/:key   { value }
router.put("/config/:key", async (req, res) => {
  const key = req.params.key;
  if (!CONFIG_KEYS[key]) {
    return res.status(400).json({ error: "bad_request", message: "Unknown config key." });
  }
  const value = typeof req.body?.value === "string" ? req.body.value.trim() : null;
  try {
    await ensureSettingsSchema();
    await pool.query(
      `INSERT INTO appconfig (configkey, configvalue, updatedat, updatedby)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (configkey)
       DO UPDATE SET configvalue = EXCLUDED.configvalue, updatedat = now(), updatedby = EXCLUDED.updatedby`,
      [key, value, req.hittUser.employeeId || null]
    );
    res.json({ key, value });
    logAudit(req, {
      kind: "settings.config",
      desc: `Set "${CONFIG_KEYS[key].label}" to ${value || "(empty)"}`,
    });
  } catch (err) {
    console.error("[PUT /api/settings/config/:key] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// PATCH /api/settings/employees/:id/role   { isAdmin: boolean }
router.patch("/employees/:id/role", async (req, res) => {
  const employeeId = Number(req.params.id);
  const { isAdmin } = req.body;
  if (!Number.isInteger(employeeId) || typeof isAdmin !== "boolean") {
    return res.status(400).json({ error: "bad_request", message: "isAdmin (boolean) is required." });
  }
  if (!isAdmin && employeeId === Number(req.hittUser.employeeId)) {
    return res.status(400).json({ error: "bad_request", message: "You can't remove your own admin role." });
  }
  try {
    if (isAdmin) {
      await pool.query(
        `INSERT INTO admins (employeeid, grantedby) VALUES ($1, $2)
         ON CONFLICT (employeeid) DO NOTHING`,
        [employeeId, req.hittUser.employeeId]
      );
    } else {
      if ((await countActiveAdmins(employeeId)) < 1) {
        return res.status(400).json({ error: "bad_request", message: "At least one admin must stay active." });
      }
      await pool.query(`DELETE FROM admins WHERE employeeid = $1`, [employeeId]);
    }
    res.json({ employeeId, isAdmin });
    employeeName(employeeId).then((name) =>
      logAudit(req, { kind: "settings.role", desc: `${isAdmin ? "Granted" : "Removed"} admin role: ${name}` }));
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
    employeeName(employeeId).then((name) =>
      logAudit(req, { kind: "settings.approver", desc: `${isTimeOffApprover ? "Granted" : "Removed"} time-off approver: ${name}` }));
  } catch (err) {
    console.error("[PATCH /employees/:id/timeoff-approver] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// PATCH /api/settings/employees/:id/presence-role   { role: 'admin'|'viewer', granted: boolean }
// Presence admin  — configure the register + record fichajes on someone's behalf.
// Presence viewer — read + export EVERY register (worker legal representatives /
//                   Inspección de Trabajo); no edit.
router.patch("/employees/:id/presence-role", async (req, res) => {
  const employeeId = Number(req.params.id);
  const { role, granted } = req.body || {};
  const table = role === "admin" ? "presence_admins" : role === "viewer" ? "presence_viewers" : null;
  if (!Number.isInteger(employeeId) || !table || typeof granted !== "boolean") {
    return res.status(400).json({ error: "bad_request", message: "role ('admin'|'viewer') and granted (boolean) are required." });
  }
  try {
    if (granted) {
      await pool.query(
        `INSERT INTO ${table} (employee_id, grantedby) VALUES ($1, $2) ON CONFLICT (employee_id) DO NOTHING`,
        [employeeId, req.hittUser.employeeId]
      );
    } else {
      await pool.query(`DELETE FROM ${table} WHERE employee_id = $1`, [employeeId]);
    }
    res.json({ employeeId, role, granted });
    employeeName(employeeId).then((name) =>
      logAudit(req, { kind: "settings.presence-role", desc: `${granted ? "Granted" : "Removed"} presence ${role}: ${name}` }));
  } catch (err) {
    console.error("[PATCH /employees/:id/presence-role] DB error:", err.message);
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
    // Deactivating an admin has the same effect on "at least one admin
    // must be active" as removing their admin role outright — check the
    // same way, only when this employee is actually an admin.
    if (isDeactivated) {
      const { rows } = await pool.query(`SELECT 1 FROM admins WHERE employeeid = $1`, [employeeId]);
      if (rows.length && (await countActiveAdmins(employeeId)) < 1) {
        return res.status(400).json({ error: "bad_request", message: "At least one admin must stay active — deactivate another admin first, or remove this one's admin role after promoting someone else." });
      }
    }
    await pool.query(`UPDATE employees SET deactivated = $2 WHERE id = $1`, [employeeId, isDeactivated]);
    res.json({ employeeId, isDeactivated });
    employeeName(employeeId).then((name) =>
      logAudit(req, { kind: "settings.status", desc: `${isDeactivated ? "Deactivated" : "Reactivated"} account: ${name}`, level: 2 }));
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
    employeeName(employeeId).then((name) =>
      logAudit(req, {
        kind: "settings.module-access",
        desc: `${hasAccess ? "Restored" : "Restricted"} ${moduleKey} access for ${name}`,
      }));
  } catch (err) {
    console.error("[PATCH /employees/:id/module-access] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

/* ============================== HOLIDAYS ================================= */

// GET /api/settings/holidays?year=YYYY
router.get("/holidays", async (req, res) => {
  try {
    await ensureSettingsSchema();
    const year = req.query.year ? Number(req.query.year) : null;
    const { rows } = await pool.query(
      `SELECT id, holidaydate AS date, holidaydesc AS description, holidaycode AS code,
              holidayyear AS year, holidayweekday AS weekday,
              COALESCE(source, 'legacy') AS source
       FROM holidays
       WHERE ($1::int IS NULL OR holidayyear = $1)
       ORDER BY holidaydate NULLS LAST`,
      [year]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/settings/holidays] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/settings/holidays/years — distinct years present, for the filter.
router.get("/holidays/years", async (req, res) => {
  try {
    await ensureSettingsSchema();
    const { rows } = await pool.query(
      `SELECT DISTINCT holidayyear::int AS year FROM holidays WHERE holidayyear IS NOT NULL ORDER BY year DESC`
    );
    res.json(rows.map((r) => r.year));
  } catch (err) {
    console.error("[GET /api/settings/holidays/years] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// POST /api/settings/holidays   { date: 'YYYY-MM-DD', description, kind: 'hitt' | 'local' }
// Adds one HR-defined holiday: a company ("hitt") day or a local bank
// ("local") holiday. Both are left untouched by the Catalonia re-import.
router.post("/holidays", async (req, res) => {
  const { date, description } = req.body || {};
  const kind = req.body?.kind === "local" ? "local" : "hitt";
  if (!date || !description || !description.trim()) {
    return res.status(400).json({ error: "bad_request", message: "date and description are required." });
  }
  try {
    await ensureSettingsSchema();
    const { rows } = await pool.query(
      `INSERT INTO holidays (holidaycode, holidayyear, holidaydate, holidaydesc, holidayweekday, source)
       VALUES ($1, EXTRACT(YEAR FROM $2::date), $2::date, $3, TRIM(TO_CHAR($2::date, 'Day')), $4)
       RETURNING id, holidaydate AS date, holidaydesc AS description, holidaycode AS code,
                 holidayyear AS year, holidayweekday AS weekday, source`,
      [`${kind.toUpperCase()}-${Date.now()}`, date, description.trim(), kind]
    );
    res.status(201).json(rows[0]);
    logAudit(req, {
      kind: "settings.holiday.add",
      desc: `Added ${kind === "local" ? "local bank" : "HITT"} holiday ${date} — "${description.trim()}"`,
    });
  } catch (err) {
    console.error("[POST /api/settings/holidays] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// DELETE /api/settings/holidays/:id
router.delete("/holidays/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM holidays WHERE id = $1 RETURNING holidaydesc, holidaydate`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found", message: "Holiday not found." });
    res.status(204).end();
    logAudit(req, {
      kind: "settings.holiday.delete",
      desc: `Deleted holiday "${rows[0].holidaydesc || "—"}"${rows[0].holidaydate ? ` (${new Date(rows[0].holidaydate).toISOString().slice(0, 10)})` : ""}`,
    });
  } catch (err) {
    console.error("[DELETE /api/settings/holidays/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// POST /api/settings/holidays/import — pull the Catalonia public-holiday
// feed and replace every source='catalonia' row with it. HR's own
// source='hitt' rows and legacy rows are left untouched.
router.post("/holidays/import", async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureSettingsSchema();

    let payload;
    try {
      const resp = await fetch(CATALONIA_HOLIDAYS_URL, { headers: { Accept: "application/json" } });
      if (!resp.ok) {
        client.release();
        return res.status(502).json({ error: "upstream_error", message: `Holiday feed returned HTTP ${resp.status}.` });
      }
      payload = await resp.json();
    } catch (fetchErr) {
      client.release();
      console.error("[POST /api/settings/holidays/import] fetch failed:", fetchErr.message);
      return res.status(502).json({ error: "upstream_unreachable", message: "Could not reach the public-holiday feed." });
    }

    const cols = (payload.meta?.view?.columns || []).map((c) => c.fieldName);
    const idx = {
      code: cols.indexOf("codi"),
      year: cols.indexOf("any"),
      date: cols.indexOf("data"),
      name: cols.indexOf("nom_del_festiu"),
    };
    if (idx.date === -1 || idx.name === -1) {
      client.release();
      return res.status(502).json({ error: "upstream_error", message: "Holiday feed format not recognised." });
    }

    // Only import 2024 onwards — the feed goes back to 2011 and older
    // records aren't useful here (any that were imported before are removed
    // by the DELETE below).
    const IMPORT_FROM = "2024-01-01";
    const records = (payload.data || [])
      .map((r) => ({
        code: idx.code > -1 ? r[idx.code] : null,
        year: idx.year > -1 && r[idx.year] != null ? Number(r[idx.year]) : null,
        date: r[idx.date] ? String(r[idx.date]).slice(0, 10) : null,
        name: r[idx.name],
      }))
      .filter((r) => r.date && r.name && r.date >= IMPORT_FROM);

    if (!records.length) {
      client.release();
      return res.status(502).json({ error: "upstream_error", message: "Holiday feed contained no usable rows." });
    }

    await client.query("BEGIN");
    await client.query(`DELETE FROM holidays WHERE source = 'catalonia'`);
    for (const rec of records) {
      await client.query(
        `INSERT INTO holidays (holidaycode, holidayyear, holidaydate, holidaydesc, holidayweekday, source)
         VALUES ($1, $2, $3::date, $4, TRIM(TO_CHAR($3::date, 'Day')), 'catalonia')`,
        [rec.code, rec.year, rec.date, rec.name]
      );
    }
    await client.query("COMMIT");

    const years = [...new Set(records.map((r) => r.year).filter(Boolean))].sort();
    res.json({ imported: records.length, years });
    logAudit(req, {
      kind: "settings.holiday.import",
      desc: `Imported ${records.length} public holidays (Catalonia)` +
        (years.length ? ` for ${years[0]}–${years[years.length - 1]}` : ""),
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[POST /api/settings/holidays/import] error:", err.message);
    res.status(502).json({ error: "import_failed", message: err.message });
  } finally {
    client.release();
  }
});

/* ============================== WORK CALENDAR =========================== */

// GET /api/settings/work-calendar — one row per year.
router.get("/work-calendar", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, workyear::int AS year, holidaysamount AS "leaveDays",
              labourhoursperyear AS "workingHours",
              corporateholidaysamount AS "corporateHolidayDays",
              updatedat AS "updatedAt"
       FROM corporateworkcalendar
       WHERE workyear IS NOT NULL
       ORDER BY workyear DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/settings/work-calendar] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// PUT /api/settings/work-calendar/:year   { leaveDays, workingHours }
// Upsert (one row per year). Nulls are allowed — a year can have just one
// of the two set.
router.put("/work-calendar/:year", async (req, res) => {
  const year = Number(req.params.year);
  const { leaveDays, workingHours } = req.body || {};
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return res.status(400).json({ error: "bad_request", message: "A valid year (2000–2100) is required." });
  }
  const leave = leaveDays === "" || leaveDays == null ? null : Number(leaveDays);
  const hours = workingHours === "" || workingHours == null ? null : Number(workingHours);
  if ((leave != null && !Number.isFinite(leave)) || (hours != null && !Number.isFinite(hours))) {
    return res.status(400).json({ error: "bad_request", message: "leaveDays and workingHours must be numbers." });
  }
  try {
    const existing = await pool.query(`SELECT id FROM corporateworkcalendar WHERE workyear = $1 LIMIT 1`, [year]);
    if (existing.rows.length) {
      await pool.query(
        `UPDATE corporateworkcalendar
         SET holidaysamount = $1, labourhoursperyear = $2, updatedat = now(), updatedby = $3
         WHERE id = $4`,
        [leave, hours, req.hittUser.employeeId || null, existing.rows[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO corporateworkcalendar (workyear, holidaysamount, labourhoursperyear, updatedat, updatedby)
         VALUES ($1, $2, $3, now(), $4)`,
        [year, leave, hours, req.hittUser.employeeId || null]
      );
    }
    res.json({ year, leaveDays: leave, workingHours: hours });
    logAudit(req, {
      kind: "settings.workcalendar",
      desc: `Work calendar ${year}: leave days ${leave ?? "—"}, working hours ${hours ?? "—"}`,
    });
  } catch (err) {
    console.error("[PUT /api/settings/work-calendar/:year] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

/* ===================== SETTINGS CATALOGS (Categories tab) ============= */
// Small id/name controlled vocabularies edited on Settings → Categories.
// Table / column names below are HARDCODED (never client input), so the
// string interpolation into SQL is safe. Each row reports how many records
// reference it (`usageCount`) and can't be deleted while in use.
const CATALOGS = {
  "expense-categories": {
    table: "expensescategories", descCol: "categorydesc",
    usageTable: "expenses", usageCol: "categoryid",
    auditKind: "settings.expense-category", label: "expense category",
  },
  "biotech-spectrums": {
    table: "biotechspectrums", descCol: "spectrumdesc",
    usageTable: "projects", usageCol: "biospectrumid",
    auditKind: "settings.biotech-spectrum", label: "biotech spectrum",
  },
  "project-types": {
    table: "projecttypes", descCol: "projecttypedesc",
    usageTable: "projects", usageCol: "projecttypeid",
    auditKind: "settings.project-type", label: "project type",
  },
};

for (const [slug, c] of Object.entries(CATALOGS)) {
  router.get(`/${slug}`, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT t.id, t.${c.descCol} AS name, COALESCE(u.n, 0)::int AS "usageCount"
           FROM ${c.table} t
           LEFT JOIN (
             SELECT ${c.usageCol}::bigint AS ref, COUNT(*) AS n
               FROM ${c.usageTable} WHERE ${c.usageCol} IS NOT NULL GROUP BY 1
           ) u ON u.ref = t.id
          ORDER BY t.${c.descCol}`
      );
      res.json(rows);
    } catch (err) {
      console.error(`[GET /api/settings/${slug}] DB error:`, err.message);
      res.status(502).json({ error: "database_unreachable", message: err.message });
    }
  });

  router.post(`/${slug}`, async (req, res) => {
    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "bad_request", message: `A ${c.label} name is required.` });
    try {
      const dup = await pool.query(`SELECT 1 FROM ${c.table} WHERE LOWER(${c.descCol}) = LOWER($1)`, [name]);
      if (dup.rows.length) return res.status(409).json({ error: "conflict", message: `That ${c.label} already exists.` });
      const { rows } = await pool.query(
        `INSERT INTO ${c.table} (${c.descCol}) VALUES ($1) RETURNING id, ${c.descCol} AS name`, [name]
      );
      res.status(201).json({ ...rows[0], usageCount: 0 });
      logAudit(req, { kind: c.auditKind, desc: `Added ${c.label} "${name}"` });
    } catch (err) {
      console.error(`[POST /api/settings/${slug}] DB error:`, err.message);
      res.status(502).json({ error: "database_unreachable", message: err.message });
    }
  });

  router.patch(`/${slug}/:id`, async (req, res) => {
    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "bad_request", message: `A ${c.label} name is required.` });
    try {
      const dup = await pool.query(
        `SELECT 1 FROM ${c.table} WHERE LOWER(${c.descCol}) = LOWER($1) AND id <> $2`, [name, req.params.id]
      );
      if (dup.rows.length) return res.status(409).json({ error: "conflict", message: `Another ${c.label} already has that name.` });
      const { rowCount } = await pool.query(
        `UPDATE ${c.table} SET ${c.descCol} = $1 WHERE id = $2`, [name, req.params.id]
      );
      if (!rowCount) return res.status(404).json({ error: "not_found", message: `${c.label} not found.` });
      res.json({ id: Number(req.params.id), name });
      logAudit(req, { kind: c.auditKind, desc: `Renamed ${c.label} #${req.params.id} to "${name}"` });
    } catch (err) {
      console.error(`[PATCH /api/settings/${slug}/:id] DB error:`, err.message);
      res.status(502).json({ error: "database_unreachable", message: err.message });
    }
  });

  router.delete(`/${slug}/:id`, async (req, res) => {
    try {
      const used = await pool.query(
        `SELECT 1 FROM ${c.usageTable} WHERE ${c.usageCol}::bigint = $1::bigint LIMIT 1`, [req.params.id]
      );
      if (used.rows.length) {
        return res.status(409).json({ error: "conflict", message: `This ${c.label} is in use and can't be deleted.` });
      }
      const { rows } = await pool.query(
        `DELETE FROM ${c.table} WHERE id = $1 RETURNING ${c.descCol} AS name`, [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: "not_found", message: `${c.label} not found.` });
      res.status(204).end();
      logAudit(req, { kind: c.auditKind, desc: `Deleted ${c.label} "${rows[0].name}"` });
    } catch (err) {
      console.error(`[DELETE /api/settings/${slug}/:id] DB error:`, err.message);
      res.status(502).json({ error: "database_unreachable", message: err.message });
    }
  });
}

/* ============================== INVOICE CURRENCIES ================== */
// The currency list offered in the invoice modal (invoicecurrencies).
// Same table + seed row the invoicing route creates at runtime.
let currencyTableReady = null;
function ensureCurrencyTable() {
  if (!currencyTableReady) {
    currencyTableReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS invoicecurrencies (
          id     bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          code   varchar(8) NOT NULL UNIQUE,
          symbol varchar(8) NOT NULL DEFAULT '',
          label  varchar(64) NOT NULL DEFAULT ''
        )`);
      await pool.query(`ALTER TABLE invoicecurrencies ADD COLUMN IF NOT EXISTS sortorder int NOT NULL DEFAULT 0`);
      await pool.query(
        `INSERT INTO invoicecurrencies (code, symbol, label, sortorder) VALUES ('EUR', '€', 'Euro', 0)
         ON CONFLICT (code) DO NOTHING`
      );
    })().catch((err) => { currencyTableReady = null; throw err; });
  }
  return currencyTableReady;
}

const cleanCode = (v) => (v || "").toString().trim().toUpperCase().slice(0, 8);

router.get("/currencies", async (req, res) => {
  try {
    await ensureCurrencyTable();
    const { rows } = await pool.query(
      `SELECT c.id, c.code, c.symbol, c.label,
              COALESCE(u.n, 0)::int AS "usageCount"
       FROM invoicecurrencies c
       LEFT JOIN (SELECT currency, COUNT(*) AS n FROM invoicesdetails GROUP BY currency) u
              ON u.currency = c.code
       ORDER BY c.sortorder, (c.code = 'EUR') DESC, c.code`
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/settings/currencies] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// PUT /api/settings/currencies/order  { ids: [...] }  — full new order.
// Registered before /currencies/:id so "order" isn't read as an id.
router.put("/currencies/order", async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (!ids) return res.status(400).json({ error: "bad_request", message: "ids array is required." });
  const client = await pool.connect();
  try {
    await ensureCurrencyTable();
    await client.query("BEGIN");
    for (let i = 0; i < ids.length; i++) {
      await client.query(`UPDATE invoicecurrencies SET sortorder = $1 WHERE id = $2`, [i, ids[i]]);
    }
    await client.query("COMMIT");
    res.status(204).end();
    logAudit(req, { kind: "settings.currency", desc: "Reordered invoice currencies" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[PUT /api/settings/currencies/order] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

router.post("/currencies", async (req, res) => {
  const code = cleanCode(req.body?.code);
  const symbol = (req.body?.symbol || "").toString().trim().slice(0, 8);
  const label = (req.body?.label || "").toString().trim().slice(0, 64);
  if (!code) return res.status(400).json({ error: "bad_request", message: "A currency code is required (e.g. USD)." });
  try {
    await ensureCurrencyTable();
    const dup = await pool.query(`SELECT 1 FROM invoicecurrencies WHERE code = $1`, [code]);
    if (dup.rows.length) return res.status(409).json({ error: "conflict", message: "That currency already exists." });
    const { rows } = await pool.query(
      `INSERT INTO invoicecurrencies (code, symbol, label, sortorder)
       VALUES ($1, $2, $3, (SELECT COALESCE(MAX(sortorder), 0) + 1 FROM invoicecurrencies))
       RETURNING id, code, symbol, label`,
      [code, symbol || code, label]
    );
    res.status(201).json({ ...rows[0], usageCount: 0 });
    logAudit(req, { kind: "settings.currency", desc: `Added invoice currency ${code}` });
  } catch (err) {
    console.error("[POST /api/settings/currencies] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

router.patch("/currencies/:id", async (req, res) => {
  const symbol = (req.body?.symbol || "").toString().trim().slice(0, 8);
  const label = (req.body?.label || "").toString().trim().slice(0, 64);
  try {
    await ensureCurrencyTable();
    const { rows } = await pool.query(
      `UPDATE invoicecurrencies SET symbol = $1, label = $2 WHERE id = $3 RETURNING id, code, symbol, label`,
      [symbol, label, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found", message: "Currency not found." });
    res.json(rows[0]);
    logAudit(req, { kind: "settings.currency", desc: `Updated invoice currency ${rows[0].code}` });
  } catch (err) {
    console.error("[PATCH /api/settings/currencies/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

router.delete("/currencies/:id", async (req, res) => {
  try {
    await ensureCurrencyTable();
    const cur = await pool.query(`SELECT code FROM invoicecurrencies WHERE id = $1`, [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: "not_found", message: "Currency not found." });
    if (cur.rows[0].code === "EUR") {
      return res.status(409).json({ error: "conflict", message: "EUR is the default currency and can't be deleted." });
    }
    const used = await pool.query(`SELECT 1 FROM invoicesdetails WHERE currency = $1 LIMIT 1`, [cur.rows[0].code]);
    if (used.rows.length) {
      return res.status(409).json({ error: "conflict", message: "This currency is used by at least one invoice and can't be deleted." });
    }
    await pool.query(`DELETE FROM invoicecurrencies WHERE id = $1`, [req.params.id]);
    res.status(204).end();
    logAudit(req, { kind: "settings.currency", desc: `Deleted invoice currency ${cur.rows[0].code}` });
  } catch (err) {
    console.error("[DELETE /api/settings/currencies/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

module.exports = router;
