/**
 * /api/presence — legal working-time register (registro de jornada).
 * ---------------------------------------------------------------------------
 * Spanish RDL 8/2019 (art. 34.9 ET) + art. 35.5 ET. See
 * server/migrations/*_presence-register.sql and docs/presence-register.md.
 *
 * IDENTITY RULE: the employee whose register a write touches is ALWAYS
 * req.hittUser.employeeId — never a body/query field — UNLESS the caller is a
 * presence admin passing ?onBehalfOf=<id>, which forces source='manual' and a
 * mandatory reason and is audited as an HR action.
 *
 * presence_events is append-only. There is NO update/delete route here; a
 * correction is a new row with supersedes_id.
 * ---------------------------------------------------------------------------
 */
const express = require("express");
const { pool } = require("../config/db");
const {
  requireModuleAccess,
  requirePresenceAdmin,
  requirePresenceViewer,
  isPresenceAdmin,
  isPresenceViewer,
} = require("../lib/permissions");
const { logAudit } = require("../lib/audit");
const P = require("../lib/presence");
const { streamPresencePdf } = require("../lib/presencePdf");

const router = express.Router();

const LEAVE_STATUS_APPROVED = 4;
const clientIp = (req) => req.ip || (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || null;
// node-pg parses `date` columns to a JS Date at LOCAL midnight and
// `timestamp without time zone` to a Date in local time — for both, the
// LOCAL calendar components are the value that was stored. Never use
// toISOString() here (it would shift the day in a non-UTC process).
const p2 = (n) => String(n).padStart(2, "0");
const isoDate = (d) => {
  if (d == null) return null;
  if (typeof d === "string") return d.slice(0, 10);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};
// for iterating date cursors we construct ourselves as UTC midnight
const isoUTC = (d) => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
const eachDay = (from, to, fn) => {
  const cur = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  while (cur <= end) { fn(isoUTC(cur)); cur.setUTCDate(cur.getUTCDate() + 1); }
};

// current org-tz calendar date
async function today(tz) {
  const { rows } = await pool.query(`SELECT (now() AT TIME ZONE $1)::date AS d`, [tz]);
  return isoDate(rows[0].d);
}
function monthRange(year, month, fallbackDate) {
  const y = Number(year), m = Number(month);
  if (y >= 2000 && m >= 1 && m <= 12) {
    const from = `${y}-${String(m).padStart(2, "0")}-01`;
    const to = isoUTC(new Date(Date.UTC(y, m, 0)));
    return { from, to };
  }
  const d = new Date(fallbackDate + "T00:00:00Z");
  return monthRange(d.getUTCFullYear(), d.getUTCMonth() + 1, fallbackDate);
}

// employee display name
async function employeeName(id) {
  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(CONCAT(employeefirstname,' ',employeelastname)),''),'Empleado #'||id) AS name
     FROM employees WHERE id = $1`, [id]);
  return rows.length ? rows[0].name : `Empleado #${id}`;
}

// Expected working minutes per day across a range, from the effective-dated
// contract (falling back to org config).
async function expectedByDate(employeeId, from, to, cfg) {
  const { rows } = await pool.query(
    `SELECT d::date AS date, EXTRACT(ISODOW FROM d)::int AS dow,
            ct.weekly_minutes, ct.workdays, ct.daily_minutes
     FROM generate_series($2::date, $3::date, interval '1 day') d
     LEFT JOIN LATERAL (
       SELECT weekly_minutes, workdays, daily_minutes FROM presence_contract
       WHERE employee_id = $1 AND valid_from <= d::date
       ORDER BY valid_from DESC LIMIT 1
     ) ct ON true`,
    [employeeId, from, to]
  );
  const map = {};
  for (const r of rows) {
    const workdays = String(r.workdays || cfg.workdays.join(",")).split(",").map(Number).filter(Boolean);
    let minutes;
    if (!workdays.includes(r.dow)) minutes = 0;
    else if (r.daily_minutes) minutes = r.daily_minutes;
    else if (r.weekly_minutes) minutes = Math.round(r.weekly_minutes / (workdays.length || 5));
    else minutes = cfg.defaultDailyMinutes;
    map[isoDate(r.date)] = minutes;
  }
  return map;
}

// Approved-leave + holiday dates in a range (so 0-hour days aren't false positives).
async function contextByDate(employeeId, from, to) {
  const leave = await pool.query(
    `SELECT r.startdate, r.enddate, ws.workflowstatusdesc AS label
     FROM timeoffrequests r
     LEFT JOIN timeoffrequeststatus s ON s.timeoffreqid = r.id
     LEFT JOIN timeoffworkflowstatus ws ON ws.id = s.statusid
     WHERE r.empid = $1 AND s.statusid = $4
       AND r.startdate <= $3::date AND r.enddate >= $2::date`,
    [employeeId, from, to, LEAVE_STATUS_APPROVED]
  );
  const holidays = await pool.query(
    `SELECT holidaydate::date AS date, holidaydesc AS label
     FROM holidays WHERE holidaydate::date BETWEEN $1::date AND $2::date`,
    [from, to]
  );
  const map = {};
  for (const h of holidays.rows) map[isoDate(h.date)] = { holiday: h.label };
  for (const l of leave.rows) {
    eachDay(isoDate(l.startdate), isoDate(l.enddate), (k) => {
      map[k] = { ...(map[k] || {}), leave: l.label || "Ausencia" };
    });
  }
  return map;
}

async function loadEvents(employeeId, from, to) {
  const { rows } = await pool.query(
    `SELECT e.*, COALESCE(NULLIF(TRIM(CONCAT(b.employeefirstname,' ',b.employeelastname)),''),'') AS entered_by_name
     FROM presence_events e
     LEFT JOIN employees b ON b.id = e.entered_by
     WHERE e.employee_id = $1 AND e.local_date BETWEEN $2::date AND $3::date
     ORDER BY e.event_at, e.id`,
    [employeeId, from, to]
  );
  const superseded = new Set(rows.map((r) => r.supersedes_id).filter((x) => x != null).map(String));
  return rows.map((r) => ({ ...r, effective: !superseded.has(String(r.id)) }));
}

// Build the day-by-day register for a range.
async function buildRegister(employeeId, from, to, cfg) {
  const events = await loadEvents(employeeId, from, to);
  const summary = P.summariseByDay(events);
  const expected = await expectedByDate(employeeId, from, to, cfg);
  const context = await contextByDate(employeeId, from, to);
  const days = [];
  const totals = { workedMinutes: 0, expectedMinutes: 0 };
  eachDay(from, to, (date) => {
    const s = summary[date] || { segments: [], workedMinutes: 0, firstIn: null, lastOut: null, open: false, hasManual: false };
    const exp = expected[date] || 0;
    totals.workedMinutes += s.workedMinutes;
    totals.expectedMinutes += exp;
    days.push({
      date,
      firstIn: s.firstIn, lastOut: s.lastOut,
      segments: s.segments,
      workedMinutes: s.workedMinutes,
      expectedMinutes: exp,
      balanceMinutes: s.workedMinutes - exp,
      open: s.open, hasManual: s.hasManual,
      leave: context[date]?.leave || null,
      holiday: context[date]?.holiday || null,
    });
  });
  totals.balanceMinutes = totals.workedMinutes - totals.expectedMinutes;
  return { events, days, totals };
}

// Resolve which employee's register a request targets, enforcing the tiers.
async function resolveTarget(req, res) {
  const me = req.hittUser?.employeeId ?? null;
  const asked = req.query.employeeId || req.params.id || null;
  if (!asked || String(asked) === String(me)) {
    if (!me) { res.status(403).json({ error: "no_employee", message: "Tu sesión no está vinculada a un empleado." }); return null; }
    return { employeeId: me, self: true };
  }
  if (!(await isPresenceViewer(me))) {
    res.status(403).json({ error: "forbidden", message: "No tienes acceso al registro de otras personas." });
    return null;
  }
  return { employeeId: String(asked), self: false };
}

/* ====================== CONFIG ====================== */

router.get("/config", requireModuleAccess("presence"), async (req, res) => {
  try {
    const cfg = await P.getConfig(pool);
    const me = req.hittUser?.employeeId ?? null;
    res.json({
      timezone: cfg.timezone,
      defaultDailyMinutes: cfg.defaultDailyMinutes,
      workdays: cfg.workdays,
      methodDoc: cfg.methodDoc,
      privacyNotice: cfg.privacyNotice,
      isPresenceAdmin: await isPresenceAdmin(me),
      isPresenceViewer: await isPresenceViewer(me),
    });
  } catch (err) {
    console.error("[GET /api/presence/config] error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

router.put("/config", requireModuleAccess("presence"), requirePresenceAdmin(), async (req, res) => {
  const body = req.body || {};
  const allowed = {
    "presence.timezone": body.timezone,
    "presence.default_daily_minutes": body.defaultDailyMinutes,
    "presence.workdays": Array.isArray(body.workdays) ? body.workdays.join(",") : body.workdays,
    "presence.method_doc": body.methodDoc,
    "presence.retention_months": body.retentionMonths,
    "presence.legal_hold": body.legalHold ? "on" : (body.legalHold === false ? "off" : undefined),
    "presence.privacy_notice": body.privacyNotice,
  };
  try {
    for (const [key, val] of Object.entries(allowed)) {
      if (val === undefined) continue;
      await pool.query(
        `INSERT INTO appconfig (configkey, configvalue, updatedat, updatedby)
         VALUES ($1, $2, now(), $3)
         ON CONFLICT (configkey) DO UPDATE SET configvalue = EXCLUDED.configvalue, updatedat = now(), updatedby = EXCLUDED.updatedby`,
        [key, String(val), req.hittUser?.employeeId ?? null]
      );
    }
    res.json(await P.getConfig(pool));
    logAudit(req, { kind: "presence.config", desc: "Updated presence register configuration" });
  } catch (err) {
    console.error("[PUT /api/presence/config] error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

/* ====================== CLOCK ====================== */

router.get("/me/today", requireModuleAccess("presence"), async (req, res) => {
  const me = req.hittUser?.employeeId ?? null;
  if (!me) return res.status(403).json({ error: "no_employee", message: "Tu sesión no está vinculada a un empleado." });
  try {
    const cfg = await P.getConfig(pool);
    const t = await today(cfg.timezone);
    const yesterday = isoUTC(new Date(new Date(t + "T00:00:00Z").getTime() - 86400000));
    const events = await loadEvents(me, yesterday, t);
    const eff = events.filter((e) => e.effective);
    // running open state
    const stack = [];
    eff.sort((a, b) => new Date(a.event_at) - new Date(b.event_at) || Number(a.id) - Number(b.id));
    for (const e of eff) { if (e.kind === "in") stack.push(e); else if (e.kind === "out") stack.pop(); }
    const openEvent = stack[stack.length - 1] || null;
    const todaySummary = P.summariseByDay(eff.filter((e) => isoDate(e.local_date) === t))[t] ||
      { segments: [], workedMinutes: 0 };
    const expected = await expectedByDate(me, t, t, cfg);
    const context = await contextByDate(me, t, t);
    res.json({
      timezone: cfg.timezone,
      today: t,
      open: !!openEvent,
      since: openEvent ? openEvent.event_at : null,
      locationLabel: openEvent ? openEvent.location_label : null,
      segments: todaySummary.segments,
      workedMinutes: todaySummary.workedMinutes,
      expectedMinutes: expected[t] || 0,
      leave: context[t]?.leave || null,
      holiday: context[t]?.holiday || null,
    });
  } catch (err) {
    console.error("[GET /api/presence/me/today] error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

router.post("/clock", requireModuleAccess("presence"), async (req, res) => {
  const me = req.hittUser?.employeeId ?? null;
  if (!me) return res.status(403).json({ error: "no_employee", message: "Tu sesión no está vinculada a un empleado." });
  const kind = req.body?.kind;
  if (kind !== "in" && kind !== "out") {
    return res.status(400).json({ error: "validation_error", message: "kind debe ser 'in' o 'out'." });
  }
  const location = typeof req.body?.location === "string" ? req.body.location.trim().slice(0, 40) || null : null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cfg = await P.getConfig(client);
    const now = await P.serverNow(client);
    const { rows: recent } = await client.query(
      `SELECT * FROM presence_events
       WHERE employee_id = $1 AND local_date >= (now() AT TIME ZONE $2)::date - 2
       ORDER BY event_at, id`,
      [me, cfg.timezone]
    );
    const eff = P.effectiveEvents(recent);
    const stack = [];
    for (const e of eff) { if (e.kind === "in") stack.push(e); else if (e.kind === "out") stack.pop(); }
    const openEvent = stack[stack.length - 1] || null;
    if (kind === "in" && openEvent) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "already_open", message: "Ya tienes un fichaje de entrada abierto." });
    }
    if (kind === "out" && !openEvent) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "not_open", message: "No tienes ningún fichaje de entrada abierto." });
    }
    const localDate = kind === "in"
      ? await P.localDateOf(client, now, cfg.timezone)
      : openEvent.local_date;
    const row = await P.insertEvent(client, {
      employeeId: me, kind, eventAt: now, localDate,
      source: "clock", locationLabel: kind === "in" ? location : null,
      enteredBy: me, enteredIp: clientIp(req),
    });
    await client.query("COMMIT");
    res.status(201).json({ event: row, open: kind === "in" });
    logAudit(req, { kind: "presence.clock", desc: `Fichaje de ${kind === "in" ? "entrada" : "salida"}` });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[POST /api/presence/clock] error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

/* ====================== MANUAL ENTRY / CORRECTION ====================== */

router.post("/manual", requireModuleAccess("presence"), async (req, res) => {
  const me = req.hittUser?.employeeId ?? null;
  const body = req.body || {};
  const onBehalfOf = body.onBehalfOf ? String(body.onBehalfOf) : null;
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note) return res.status(400).json({ error: "validation_error", message: "Debes indicar el motivo del ajuste." });

  let targetEmployee = me;
  let onBehalf = false;
  if (onBehalfOf && onBehalfOf !== String(me)) {
    if (!(await isPresenceAdmin(me))) {
      return res.status(403).json({ error: "forbidden", message: "No puedes registrar fichajes de otra persona." });
    }
    targetEmployee = onBehalfOf;
    onBehalf = true;
  }
  if (!targetEmployee) return res.status(403).json({ error: "no_employee", message: "Sesión sin empleado vinculado." });

  const localDate = String(body.localDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    return res.status(400).json({ error: "validation_error", message: "Fecha inválida." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cfg = await P.getConfig(client);
    const created = [];

    if (body.supersedesId) {
      const { rows: orig } = await client.query(`SELECT * FROM presence_events WHERE id = $1`, [body.supersedesId]);
      if (!orig.length || String(orig[0].employee_id) !== String(targetEmployee)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "not_found", message: "El fichaje a corregir no existe." });
      }
      const { rows: already } = await client.query(`SELECT 1 FROM presence_events WHERE supersedes_id = $1`, [body.supersedesId]);
      if (already.length) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "already_corrected", message: "Ese fichaje ya fue corregido." });
      }
      const kind = body.kind === "out" ? "out" : "in";
      const instant = await P.wallClockToInstant(client, localDate, String(body.time || "").slice(0, 5), cfg.timezone);
      created.push(await P.insertEvent(client, {
        employeeId: targetEmployee, kind, eventAt: instant, localDate,
        source: "manual", note, supersedesId: body.supersedesId,
        enteredBy: me, enteredIp: clientIp(req),
      }));
    } else {
      const entries = Array.isArray(body.entries) ? body.entries : [];
      if (!entries.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "validation_error", message: "Añade al menos un fichaje." });
      }
      for (const en of entries) {
        const time = String(en.time || "").slice(0, 5);
        if ((en.kind !== "in" && en.kind !== "out") || !/^\d{2}:\d{2}$/.test(time)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "validation_error", message: "Fichaje inválido (tipo + HH:MM)." });
        }
      }
      // If the day already has clock entries, this submission replaces them:
      // void every existing effective 'in'/'out' (originals are kept, just no
      // longer effective) then add the new set. Fully traceable.
      if (body.replaceDay) {
        const { rows: existing } = await client.query(
          `SELECT e.* FROM presence_events e
           WHERE e.employee_id = $1 AND e.local_date = $2::date AND e.kind IN ('in','out')
             AND NOT EXISTS (SELECT 1 FROM presence_events c WHERE c.supersedes_id = e.id)`,
          [targetEmployee, localDate]
        );
        for (const ev of existing) {
          created.push(await P.insertEvent(client, {
            employeeId: targetEmployee, kind: "void", eventAt: ev.event_at, localDate,
            source: "manual", note, supersedesId: ev.id, enteredBy: me, enteredIp: clientIp(req),
          }));
        }
      }
      for (const en of entries) {
        const instant = await P.wallClockToInstant(client, localDate, String(en.time).slice(0, 5), cfg.timezone);
        created.push(await P.insertEvent(client, {
          employeeId: targetEmployee, kind: en.kind, eventAt: instant, localDate,
          source: "manual", note, enteredBy: me, enteredIp: clientIp(req),
        }));
      }
    }
    await client.query("COMMIT");
    res.status(201).json({ created });
    logAudit(req, {
      kind: body.supersedesId ? "presence.correct" : "presence.manual",
      desc: `${body.supersedesId ? "Corrección" : "Fichaje manual"} ${localDate}${onBehalf ? ` (en nombre de ${await employeeName(targetEmployee)})` : ""} — ${note}`,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[POST /api/presence/manual] error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

/* ====================== REGISTER (read) ====================== */

router.get("/me", requireModuleAccess("presence"), async (req, res) => {
  const me = req.hittUser?.employeeId ?? null;
  if (!me) return res.status(403).json({ error: "no_employee", message: "Sesión sin empleado vinculado." });
  await sendRegister(req, res, me, true);
});

router.get("/employees/:id", requireModuleAccess("presence"), requirePresenceViewer(), async (req, res) => {
  await sendRegister(req, res, String(req.params.id), false);
});

async function sendRegister(req, res, employeeId, self) {
  try {
    const cfg = await P.getConfig(pool);
    const t = await today(cfg.timezone);
    let from = String(req.query.from || "").slice(0, 10);
    let to = String(req.query.to || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      ({ from, to } = monthRange(null, null, t));
    }
    const reg = await buildRegister(employeeId, from, to, cfg);
    res.json({
      timezone: cfg.timezone,
      employeeId, employeeName: self ? undefined : await employeeName(employeeId),
      from, to,
      events: reg.events.map((e) => ({
        id: e.id, kind: e.kind, eventAt: e.event_at, localDate: isoDate(e.local_date),
        source: e.source, note: e.note, locationLabel: e.location_label,
        supersedesId: e.supersedes_id, effective: e.effective,
        enteredBy: e.entered_by, enteredByName: e.entered_by_name || null, enteredAt: e.entered_at,
      })),
      days: reg.days,
      totals: reg.totals,
    });
    if (!self) logAudit(req, { kind: "presence.export", desc: `Consultó el registro de ${await employeeName(employeeId)} (${from} → ${to})` });
  } catch (err) {
    console.error("[GET /api/presence register] error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
}

/* ====================== MONTHLY TOTALISATION (art. 35.5) ====================== */

router.get("/monthly", requireModuleAccess("presence"), async (req, res) => {
  const target = await resolveTarget(req, res);
  if (!target) return;
  try {
    const cfg = await P.getConfig(pool);
    const t = await today(cfg.timezone);
    const { from, to } = monthRange(req.query.year, req.query.month, t);
    const [y, m] = from.split("-").map(Number);
    const { rows: existing } = await pool.query(
      `SELECT * FROM presence_monthly WHERE employee_id = $1 AND period_year = $2 AND period_month = $3`,
      [target.employeeId, y, m]
    );
    let row = existing[0];
    const regenerate = !row || (!row.acknowledged_at && req.query.regenerate);
    if (regenerate) {
      const reg = await buildRegister(target.employeeId, from, to, cfg);
      const overtime = Math.max(0, reg.totals.workedMinutes - reg.totals.expectedMinutes);
      const snapshot = reg.days.map((d) => ({
        date: d.date, worked: d.workedMinutes, expected: d.expectedMinutes,
        firstIn: d.firstIn, lastOut: d.lastOut, segments: d.segments.length,
        manual: d.hasManual, open: d.open, leave: d.leave, holiday: d.holiday,
      }));
      const up = await pool.query(
        `INSERT INTO presence_monthly
           (employee_id, period_year, period_month, worked_minutes, expected_minutes, overtime_minutes, snapshot, generated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
         ON CONFLICT (employee_id, period_year, period_month)
           DO UPDATE SET worked_minutes = EXCLUDED.worked_minutes, expected_minutes = EXCLUDED.expected_minutes,
             overtime_minutes = EXCLUDED.overtime_minutes, snapshot = EXCLUDED.snapshot,
             generated_at = now(), generated_by = EXCLUDED.generated_by, acknowledged_at = NULL
         RETURNING *`,
        [target.employeeId, y, m, reg.totals.workedMinutes, reg.totals.expectedMinutes, overtime, JSON.stringify(snapshot), req.hittUser?.employeeId ?? null]
      );
      row = up.rows[0];
    }
    res.json({
      ...row,
      balanceMinutes: row.worked_minutes - row.expected_minutes,
      period: { year: y, month: m, from, to },
    });
  } catch (err) {
    console.error("[GET /api/presence/monthly] error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

router.post("/monthly/:id/acknowledge", requireModuleAccess("presence"), async (req, res) => {
  const me = req.hittUser?.employeeId ?? null;
  try {
    const { rows } = await pool.query(
      `UPDATE presence_monthly SET acknowledged_at = now()
       WHERE id = $1 AND employee_id = $2 AND acknowledged_at IS NULL
       RETURNING *`,
      [req.params.id, me]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found", message: "Resumen no encontrado o ya confirmado." });
    res.json(rows[0]);
    logAudit(req, { kind: "presence.ack", desc: `Confirmó la recepción del resumen ${rows[0].period_year}-${String(rows[0].period_month).padStart(2, "0")}` });
  } catch (err) {
    console.error("[POST /api/presence/monthly/:id/acknowledge] error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

/* ====================== EXPORT ====================== */

router.get("/export", requireModuleAccess("presence"), async (req, res) => {
  const target = await resolveTarget(req, res);
  if (!target) return;
  const format = req.query.format === "pdf" ? "pdf" : "csv";
  try {
    const cfg = await P.getConfig(pool);
    const t = await today(cfg.timezone);
    let from = String(req.query.from || "").slice(0, 10);
    let to = String(req.query.to || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) ({ from, to } = monthRange(null, null, t));
    const name = await employeeName(target.employeeId);
    const reg = await buildRegister(target.employeeId, from, to, cfg);
    const fnameBase = `registro-jornada_${name.replace(/[^\w-]+/g, "_")}_${from}_${to}`;

    logAudit(req, { kind: "presence.export", desc: `Exportó (${format.toUpperCase()}) el registro de ${name} (${from} → ${to})` });

    if (format === "pdf") {
      streamPresencePdf(res, { name, from, to, timezone: cfg.timezone, generatedAt: new Date(), days: reg.days, totals: reg.totals, methodDoc: cfg.methodDoc });
      return;
    }
    const fmt = (iso) => (iso ? new Intl.DateTimeFormat("es-ES", { timeZone: cfg.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "");
    const hhmm = (min) => { const a = Math.abs(min); return `${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")}`; };
    const signed = (min) => (min < 0 ? "-" : "") + hhmm(min);
    const lines = [
      `Registro de jornada — ${name}`,
      `Periodo: ${from} a ${to}`,
      `Zona horaria: ${cfg.timezone}`,
      `Generado: ${new Date().toISOString()}`,
      `Conservación conforme al art. 34.9 del Estatuto de los Trabajadores (RDL 8/2019).`,
      "",
      ["Fecha", "Entrada", "Salida", "Segmentos", "Trabajado (h:m)", "Previsto (h:m)", "Saldo (h:m)", "Manual", "Ausencia"].join(";"),
    ];
    for (const d of reg.days) {
      lines.push([
        d.date, fmt(d.firstIn), fmt(d.lastOut),
        d.segments.map((s) => `${fmt(s.in)}-${fmt(s.out)}`).join(" "),
        hhmm(d.workedMinutes), hhmm(d.expectedMinutes), signed(d.balanceMinutes),
        d.hasManual ? "sí" : "", d.leave || d.holiday || "",
      ].join(";"));
    }
    lines.push("");
    lines.push(["TOTAL", "", "", "", hhmm(reg.totals.workedMinutes), hhmm(reg.totals.expectedMinutes),
      signed(reg.totals.balanceMinutes), "", ""].join(";"));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fnameBase}.csv"`);
    res.send("﻿" + lines.join("\r\n"));
  } catch (err) {
    console.error("[GET /api/presence/export] error:", err.message);
    if (!res.headersSent) res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

/* ====================== HR: OVERVIEW + CONTRACT ====================== */

router.get("/overview", requireModuleAccess("presence"), requirePresenceViewer(), async (req, res) => {
  try {
    const cfg = await P.getConfig(pool);
    const t = await today(cfg.timezone);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || "")) ? req.query.date : t;
    const { rows: emps } = await pool.query(
      `SELECT id, COALESCE(NULLIF(TRIM(CONCAT(employeefirstname,' ',employeelastname)),''),'Empleado #'||id) AS name
       FROM employees WHERE deactivated = false ORDER BY name`
    );
    const { rows: dayRows } = await pool.query(
      `SELECT * FROM presence_day WHERE local_date = $1::date`, [date]
    );
    const byEmp = {};
    dayRows.forEach((d) => { byEmp[String(d.employee_id)] = d; });
    const leave = await pool.query(
      `SELECT r.empid FROM timeoffrequests r
       LEFT JOIN timeoffrequeststatus s ON s.timeoffreqid = r.id
       WHERE s.statusid = $2 AND r.startdate <= $1::date AND r.enddate >= $1::date`,
      [date, LEAVE_STATUS_APPROVED]
    );
    const onLeave = new Set(leave.rows.map((r) => String(r.empid)));
    res.json({
      date,
      rows: emps.map((e) => {
        const d = byEmp[String(e.id)];
        return {
          employeeId: e.id, name: e.name,
          clockedIn: !!d,
          open: d ? d.is_open : false,
          workedMinutes: d ? d.worked_minutes : 0,
          hasManual: d ? d.has_manual : false,
          onLeave: onLeave.has(String(e.id)),
        };
      }),
    });
  } catch (err) {
    console.error("[GET /api/presence/overview] error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

router.get("/contract/:employeeId", requireModuleAccess("presence"), requirePresenceAdmin(), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, valid_from, weekly_minutes, workdays, daily_minutes, note, created_at
       FROM presence_contract WHERE employee_id = $1 ORDER BY valid_from DESC`,
      [req.params.employeeId]
    );
    res.json({ rows });
  } catch (err) {
    console.error("[GET /api/presence/contract] error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

router.post("/contract/:employeeId", requireModuleAccess("presence"), requirePresenceAdmin(), async (req, res) => {
  const b = req.body || {};
  const validFrom = String(b.validFrom || "").slice(0, 10);
  const weekly = Number(b.weeklyMinutes);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom) || !(weekly > 0)) {
    return res.status(400).json({ error: "validation_error", message: "validFrom (YYYY-MM-DD) y weeklyMinutes (>0) son obligatorios." });
  }
  const workdays = Array.isArray(b.workdays) ? b.workdays.join(",") : (b.workdays || "1,2,3,4,5");
  try {
    const { rows } = await pool.query(
      `INSERT INTO presence_contract (employee_id, valid_from, weekly_minutes, workdays, daily_minutes, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.employeeId, validFrom, Math.round(weekly), workdays,
       b.dailyMinutes ? Math.round(Number(b.dailyMinutes)) : null,
       typeof b.note === "string" ? b.note.trim() || null : null,
       req.hittUser?.employeeId ?? null]
    );
    res.status(201).json(rows[0]);
    logAudit(req, { kind: "presence.contract", desc: `Contrato de jornada para ${await employeeName(req.params.employeeId)} desde ${validFrom} (${weekly} min/sem)` });
  } catch (err) {
    console.error("[POST /api/presence/contract] error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

module.exports = router;
