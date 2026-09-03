/**
 * /api/verifactu — Settings → Veri*Factu tab (admin only)
 * ---------------------------------------------------------------------------
 * Per-entity Veri*Factu configuration + a status overview. The API key is a
 * SERVER-ONLY SECRET: it is never returned — only a boolean "has key". See
 * docs/verifactu-integration-roadmap.md §7.
 *
 * Everything degrades to "not available" on an instance where the Veri*Factu
 * migrations haven't run (the columns / verifactu_records table are missing).
 * ---------------------------------------------------------------------------
 */
const express = require("express");
const { pool } = require("../config/db");
const { requireAdmin } = require("../lib/permissions");
const { logAudit } = require("../lib/audit");
const { featureEnabled, providerName } = require("../lib/verifactu");

const router = express.Router();
router.use(requireAdmin);

const OPTION_KEYS = {
  "verifactu.declaracion_url": { type: "text" }, // Ops' own declaración responsable
  "verifactu.id_check": { type: "bool" },        // pre-check recipient NIF on issue (phase V5c)
};

async function ensureAppconfig() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.appconfig (
      configkey   varchar(64) PRIMARY KEY,
      configvalue text,
      updatedat   timestamp without time zone,
      updatedby   bigint
    )`);
}

async function readOptions() {
  await ensureAppconfig();
  const { rows } = await pool.query(`SELECT configkey, configvalue FROM appconfig WHERE configkey LIKE 'verifactu.%'`);
  const stored = Object.fromEntries(rows.map((r) => [r.configkey, r.configvalue]));
  const out = {};
  for (const [key, meta] of Object.entries(OPTION_KEYS)) {
    out[key] = meta.type === "bool" ? stored[key] === "true" : (stored[key] ?? "");
  }
  return out;
}

function cleanSeries(v) {
  return String(v || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 16) || null;
}

// GET /api/verifactu — feature status + per-entity config + options
router.get("/", async (req, res) => {
  try {
    const entities = await pool.query(
      `SELECT e.id, e.entitydesc AS name, e.vatnumber AS nif,
              COALESCE(e.verifactu_enabled, false)          AS enabled,
              COALESCE(e.verifactu_environment, 'sandbox')  AS environment,
              e.invoice_series                              AS series,
              (e.verifactu_api_key IS NOT NULL AND e.verifactu_api_key <> '') AS "hasKey",
              COALESCE(agg.pending, 0)::int AS pending,
              COALESCE(agg.errored, 0)::int AS errored,
              COALESCE(agg.issued, 0)::int  AS issued
         FROM entity e
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE vr.aeat_state = 'pending') AS pending,
                  count(*) FILTER (WHERE vr.aeat_state = 'error')   AS errored,
                  count(*) FILTER (WHERE vr.kind = 'alta')          AS issued
             FROM verifactu_records vr
             JOIN invoices i ON i.id = vr.invoiceid
             LEFT JOIN projects p ON p.id = i.projectid::bigint
            WHERE COALESCE(i.entityid, p.entityid::bigint) = e.id
         ) agg ON true
        ORDER BY e.id`
    );
    res.json({
      featureEnabled: featureEnabled(),
      provider: providerName(),
      defaultEnvironment: (process.env.VERIFACTU_ENV || "sandbox").toLowerCase(),
      migrated: true,
      entities: entities.rows,
      options: await readOptions(),
    });
  } catch (err) {
    if (err && (err.code === "42P01" || err.code === "42703")) {
      return res.json({
        featureEnabled: featureEnabled(),
        provider: providerName(),
        defaultEnvironment: (process.env.VERIFACTU_ENV || "sandbox").toLowerCase(),
        migrated: false,
        entities: [],
        options: {},
      });
    }
    console.error("[GET /api/verifactu] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// PATCH /api/verifactu/entities/:id   { enabled?, environment?, series?, apiKey? }
// apiKey: a non-empty string sets it, "" clears it, omitted leaves it — and
// it is never echoed back.
router.patch("/entities/:id", async (req, res) => {
  const b = req.body || {};
  const sets = [];
  const params = [];
  const changed = [];

  if (typeof b.enabled === "boolean") {
    params.push(b.enabled);
    sets.push(`verifactu_enabled = $${params.length}`);
    changed.push(`enabled=${b.enabled}`);
  }
  if (b.environment === "sandbox" || b.environment === "production") {
    params.push(b.environment);
    sets.push(`verifactu_environment = $${params.length}`);
    changed.push(`environment=${b.environment}`);
  }
  if (b.series !== undefined) {
    params.push(cleanSeries(b.series));
    sets.push(`invoice_series = $${params.length}`);
    changed.push(`series=${cleanSeries(b.series) || "(none)"}`);
  }
  if (typeof b.apiKey === "string") {
    const k = b.apiKey.trim();
    params.push(k === "" ? null : k);
    sets.push(`verifactu_api_key = $${params.length}`);
    changed.push(k === "" ? "API key cleared" : "API key set");
  }

  if (!sets.length) {
    return res.status(400).json({ error: "bad_request", message: "Nothing to update." });
  }

  params.push(req.params.id);
  try {
    const { rowCount } = await pool.query(
      `UPDATE entity SET ${sets.join(", ")} WHERE id = $${params.length}`,
      params
    );
    if (!rowCount) return res.status(404).json({ error: "not_found", message: "Entity not found." });

    const name = await pool.query(`SELECT entitydesc FROM entity WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
    logAudit(req, {
      kind: "settings.verifactu",
      desc: `Veri*Factu config — "${name.rows[0]?.entitydesc || `#${req.params.id}`}": ${changed.join(", ")}`,
      level: 2,
    });
  } catch (err) {
    if (err && (err.code === "42P01" || err.code === "42703")) {
      return res.status(409).json({ error: "not_migrated", message: "Run the database migrations to enable Veri*Factu." });
    }
    console.error("[PATCH /api/verifactu/entities/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// PUT /api/verifactu/options/:key   { value }
router.put("/options/:key", async (req, res) => {
  const key = req.params.key;
  const meta = OPTION_KEYS[key];
  if (!meta) return res.status(400).json({ error: "bad_request", message: "Unknown option." });

  let value;
  if (meta.type === "bool") value = req.body?.value ? "true" : "false";
  else value = typeof req.body?.value === "string" ? req.body.value.trim().slice(0, 500) : null;

  try {
    await ensureAppconfig();
    await pool.query(
      `INSERT INTO appconfig (configkey, configvalue, updatedat, updatedby)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (configkey) DO UPDATE SET configvalue = EXCLUDED.configvalue, updatedat = now(), updatedby = EXCLUDED.updatedby`,
      [key, value, req.hittUser?.employeeId || null]
    );
    res.json({ key, value: meta.type === "bool" ? value === "true" : value });
    logAudit(req, { kind: "settings.verifactu", desc: `Veri*Factu option "${key}" = ${value}` });
  } catch (err) {
    console.error("[PUT /api/verifactu/options/:key] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

module.exports = router;
