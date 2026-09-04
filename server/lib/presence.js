/**
 * Presence register — shared helpers.
 * ---------------------------------------------------------------------------
 * Backs Time allocation → "Presence" (Spanish RDL 8/2019 registro de jornada).
 *
 *  - Config: presence.* keys in appconfig, with legal defaults.
 *  - Hash chain: every presence_events row is chained to the employee's
 *    previous row (prev_hash -> row_hash) so tampering is detectable
 *    (`npm run presence:verify`). insertEvent() must run inside a transaction;
 *    it takes a per-employee advisory lock so the chain can't fork.
 *  - Time: everything is timestamptz + explicit `AT TIME ZONE <org tz>`.
 *    The Node process timezone is never trusted.
 *  - Segment maths: pair effective (non-superseded) in/out events into
 *    worked segments; used by exports and the monthly totalisation.
 * ---------------------------------------------------------------------------
 */
const crypto = require("crypto");

const CONFIG_DEFAULTS = {
  "presence.timezone": "Europe/Madrid",
  "presence.default_daily_minutes": "480",
  "presence.workdays": "1,2,3,4,5",
  "presence.method_doc": "",
  "presence.retention_months": "48",
  "presence.legal_hold": "off",
  "presence.privacy_notice": "",
};
const CONFIG_KEYS = Object.keys(CONFIG_DEFAULTS);

const ZERO_HASH = "0".repeat(64);

function sha256Hex(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

// node-pg gives `date` columns back as a JS Date at LOCAL midnight — the
// local calendar components are the stored value. Normalise every local_date
// through this (both at insert and at verify) so the hash chain is stable
// regardless of the process timezone. Never toISOString() a `date`.
const pad2 = (n) => String(n).padStart(2, "0");
function dateStr(d) {
  if (d == null) return "";
  if (typeof d === "string") return d.slice(0, 10);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// The fields whose integrity the chain protects. Anything that changes the
// legal meaning of the entry is here; note/location are advisory and left out
// so a typo fix in a reason (itself done as a superseding row) doesn't need
// special handling.
function canonicalEvent(row) {
  return [
    row.employee_id,
    row.kind,
    new Date(row.event_at).toISOString(), // timestamptz — an absolute instant, stable
    dateStr(row.local_date),
    row.source,
    row.supersedes_id == null ? "" : row.supersedes_id,
    row.entered_by,
    new Date(row.entered_at).toISOString(),
  ].join("|");
}

function rowHash(prevHash, row) {
  return sha256Hex(`${prevHash}|${canonicalEvent(row)}`);
}

/**
 * Read presence.* config (appconfig) merged over the legal defaults.
 * `db` is a pool or client.
 */
async function getConfig(db) {
  const { rows } = await db.query(
    `SELECT configkey, configvalue FROM appconfig WHERE configkey = ANY($1)`,
    [CONFIG_KEYS]
  );
  const raw = { ...CONFIG_DEFAULTS };
  rows.forEach((r) => { if (r.configvalue != null) raw[r.configkey] = r.configvalue; });
  return {
    timezone: raw["presence.timezone"] || "Europe/Madrid",
    defaultDailyMinutes: Number(raw["presence.default_daily_minutes"]) || 480,
    workdays: String(raw["presence.workdays"] || "1,2,3,4,5")
      .split(",").map((n) => Number(n.trim())).filter((n) => n >= 1 && n <= 7),
    methodDoc: raw["presence.method_doc"] || "",
    retentionMonths: Number(raw["presence.retention_months"]) || 48,
    legalHold: raw["presence.legal_hold"] === "on",
    privacyNotice: raw["presence.privacy_notice"] || "",
  };
}

/** `SELECT now()` as an authoritative instant (a JS Date). */
async function serverNow(client) {
  const { rows } = await client.query("SELECT now() AS at");
  return rows[0].at;
}

/** Interpret a wall-clock `YYYY-MM-DD` + `HH:MM` in `tz` as a UTC instant. */
async function wallClockToInstant(client, dateStr, timeStr, tz) {
  const { rows } = await client.query(
    `SELECT (($1 || ' ' || $2)::timestamp AT TIME ZONE $3) AS at`,
    [dateStr, `${timeStr}:00`.slice(0, 8), tz]
  );
  return rows[0].at;
}

/** The org-tz calendar date an instant falls on. */
async function localDateOf(client, instant, tz) {
  const { rows } = await client.query(
    `SELECT ($1::timestamptz AT TIME ZONE $2)::date AS d`,
    [instant instanceof Date ? instant.toISOString() : instant, tz]
  );
  return rows[0].d;
}

/**
 * Append one event to the chain. MUST be called inside a transaction.
 * Returns the inserted row.
 */
async function insertEvent(client, e) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`presence:${e.employeeId}`]);
  const { rows: prev } = await client.query(
    `SELECT row_hash FROM presence_events WHERE employee_id = $1 ORDER BY id DESC LIMIT 1`,
    [e.employeeId]
  );
  const prevHash = prev.length ? prev[0].row_hash : ZERO_HASH;
  const enteredAt = await serverNow(client);
  const shape = {
    employee_id: e.employeeId,
    kind: e.kind,
    event_at: e.eventAt,
    local_date: e.localDate,
    source: e.source || "clock",
    supersedes_id: e.supersedesId ?? null,
    entered_by: e.enteredBy,
    entered_at: enteredAt,
  };
  const hash = rowHash(prevHash, shape);
  const { rows } = await client.query(
    `INSERT INTO presence_events
       (employee_id, kind, event_at, local_date, source, note, location_label,
        supersedes_id, entered_by, entered_at, entered_ip, prev_hash, row_hash)
     VALUES ($1,$2,$3::timestamptz,$4::date,$5,$6,$7,$8,$9,$10::timestamptz,$11,$12,$13)
     RETURNING *`,
    [
      e.employeeId, e.kind,
      e.eventAt instanceof Date ? e.eventAt.toISOString() : e.eventAt,
      dateStr(shape.local_date),
      shape.source, e.note ?? null, e.locationLabel ?? null,
      shape.supersedes_id, e.enteredBy,
      enteredAt.toISOString(), e.enteredIp ?? null, prevHash, hash,
    ]
  );
  return rows[0];
}

/** Verify one employee's chain. Returns { ok, count, brokenAt? }. */
async function verifyChain(db, employeeId) {
  const { rows } = await db.query(
    `SELECT * FROM presence_events WHERE employee_id = $1 ORDER BY id`,
    [employeeId]
  );
  let prev = ZERO_HASH;
  for (const row of rows) {
    if (row.prev_hash !== prev) return { ok: false, count: rows.length, brokenAt: row.id, reason: "prev_hash mismatch" };
    const expect = rowHash(prev, row);
    if (row.row_hash !== expect) return { ok: false, count: rows.length, brokenAt: row.id, reason: "row_hash mismatch" };
    prev = row.row_hash;
  }
  return { ok: true, count: rows.length };
}

// --- segment maths -----------------------------------------------------

/** Drop rows that have been superseded by another row in the same set. */
function effectiveEvents(rows) {
  const superseded = new Set(rows.map((r) => r.supersedes_id).filter((x) => x != null).map(String));
  return rows.filter((r) => !superseded.has(String(r.id)));
}

/**
 * Pair effective events (already filtered, any order) into worked segments,
 * grouped by local_date. Each segment carries the self-declared `location`
 * from its opening `in` event (office / remote / client / free text, or null).
 * -> { [localDate]: { segments:[{in,out,minutes,location}], workedMinutes,
 *                     firstIn, lastOut, open:bool, hasManual:bool } }
 */
function summariseByDay(events) {
  const byDay = {};
  const groups = {};
  effectiveEvents(events).forEach((e) => {
    if (e.kind === "void") return; // a void only removes the event it supersedes
    const d = dateStr(e.local_date);
    (groups[d] = groups[d] || []).push(e);
  });
  for (const [d, evs] of Object.entries(groups)) {
    evs.sort((a, b) => new Date(a.event_at) - new Date(b.event_at) || Number(a.id) - Number(b.id));
    const segments = [];
    let openEv = null;
    let hasManual = false;
    let firstIn = null, lastOut = null;
    for (const e of evs) {
      if (e.source && e.source !== "clock") hasManual = true;
      if (e.kind === "in") {
        if (!firstIn) firstIn = e.event_at;
        openEv = e;
      } else { // out
        lastOut = e.event_at;
        if (openEv) {
          const minutes = Math.round((new Date(e.event_at) - new Date(openEv.event_at)) / 60000);
          if (minutes > 0) {
            segments.push({ in: openEv.event_at, out: e.event_at, minutes, location: openEv.location_label || null });
          }
          openEv = null;
        }
      }
    }
    byDay[d] = {
      segments,
      workedMinutes: segments.reduce((s, x) => s + x.minutes, 0),
      firstIn, lastOut,
      open: openEv != null,
      hasManual,
    };
  }
  return byDay;
}

module.exports = {
  CONFIG_KEYS,
  CONFIG_DEFAULTS,
  ZERO_HASH,
  dateStr,
  getConfig,
  serverNow,
  wallClockToInstant,
  localDateOf,
  insertEvent,
  verifyChain,
  effectiveEvents,
  summariseByDay,
  rowHash,
};
