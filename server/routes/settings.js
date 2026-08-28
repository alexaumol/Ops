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

const router = express.Router();

router.use(requireAdmin);

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

// Idempotent one-time schema top-up for the holidays feature — keeps this
// self-contained instead of requiring a manual migration step on deploy.
// Mirrored in server/db/schema-changes.sql for anyone applying it by hand.
let schemaReady = null;
function ensureSettingsSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`ALTER TABLE public.holidays ADD COLUMN IF NOT EXISTS source varchar(32)`);
      await pool.query(`UPDATE public.holidays SET source = 'legacy' WHERE source IS NULL`);
    })().catch((err) => {
      schemaReady = null; // allow a later request to retry
      throw err;
    });
  }
  return schemaReady;
}

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

module.exports = router;
