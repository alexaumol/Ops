/**
 * Veri*Factu — AEAT status polling (phase V4)
 * ---------------------------------------------------------------------------
 * BOLD has no webhooks, so a record's AEAT outcome is discovered by polling
 * `POST /invoice_state/{queueId}`. Two jobs, both here:
 *
 *   refresh   a `sent` (or queued-`pending`) record → re-read its AEAT state
 *             and update aeat_state / error_* / state_checked_at
 *   resend    a `pending` record with NO queueId (a submission that never
 *             reached BOLD) → re-submit it via issue.js retryRecord
 *
 * `refreshInvoice()` runs both for one invoice (the "Refresh AEAT status"
 * button, POST /api/invoicing/invoices/:id/verifactu/refresh).
 * `runPoll()` runs both across the fleet (npm run verifactu:poll, cron).
 * ---------------------------------------------------------------------------
 */
const { pool } = require("../../config/db");
const { configForEntity, featureEnabled } = require("./index");
const { VerifactuError } = require("./errors");
const { retryRecord } = require("./issue");

const STALE_AFTER = "2 hours";   // don't re-poll a sent record more often
const MAX_AGE = "60 days";       // stop chasing very old records

async function entityRow(entityId) {
  if (!entityId) return null;
  const { rows } = await pool.query(
    `SELECT id, vatnumber, verifactu_enabled, verifactu_api_key, verifactu_environment
       FROM entity WHERE id = $1`,
    [entityId]
  );
  return rows[0] || null;
}

/** One `sent`/queued record → refresh its AEAT state. Returns the new state. */
async function refreshRecord(rec, cfg) {
  if (!rec.queue_id) return rec.aeat_state;
  let st;
  try {
    st = await cfg.provider.state(rec.queue_id, { apiKey: cfg.apiKey, issuerNif: cfg.issuerNif });
  } catch (err) {
    // Outage → leave the record as-is, just stamp the check time.
    await pool.query(`UPDATE verifactu_records SET state_checked_at = now() WHERE id = $1`, [rec.id]);
    if (err instanceof VerifactuError && err.retryable) return rec.aeat_state;
    throw err;
  }
  const next = st.state === "sent" ? "sent" : st.state === "error" ? "error" : "pending";
  await pool.query(
    `UPDATE verifactu_records
        SET aeat_state = $1,
            error_code = COALESCE($2, error_code),
            error_text = COALESCE($3, error_text),
            state_checked_at = now()
      WHERE id = $4`,
    [next, st.error_code || null, st.error_text || null, rec.id]
  );
  return next;
}

function credsFor(entity) {
  const cfg = configForEntity(entity);
  return cfg;
}

/**
 * Refresh + resend everything outstanding for one invoice.
 * @returns {Promise<{ checked:number, resent:number, state:string|null }>}
 */
async function refreshInvoice(invoiceId, opts = {}) {
  const inv = await pool.query(
    `SELECT COALESCE(i.entityid, p.entityid::bigint) AS entityid
       FROM invoices i LEFT JOIN projects p ON p.id = i.projectid::bigint
      WHERE i.id = $1`,
    [invoiceId]
  );
  if (!inv.rows.length) return { checked: 0, resent: 0, state: null };
  const cfg = credsFor(await entityRow(inv.rows[0].entityid));

  const { rows } = await pool.query(
    `SELECT id, invoiceid, queue_id, kind, aeat_state
       FROM verifactu_records
      WHERE invoiceid = $1
      ORDER BY created_at DESC, id DESC`,
    [invoiceId]
  );

  let checked = 0;
  let resent = 0;
  for (const rec of rows) {
    if (rec.aeat_state === "pending" && !rec.queue_id) {
      if (cfg.enabled) { await retryRecord(invoiceId, opts).catch(() => {}); resent++; }
    } else if (rec.queue_id && rec.aeat_state !== "error") {
      if (cfg.enabled) { await refreshRecord(rec, cfg); checked++; }
    }
  }

  const latest = await pool.query(
    `SELECT aeat_state FROM verifactu_records WHERE invoiceid = $1 AND kind = 'alta'
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [invoiceId]
  );
  return { checked, resent, state: latest.rows[0] ? latest.rows[0].aeat_state : null };
}

/**
 * Fleet-wide poll. Refreshes stale `sent`/queued records and re-sends
 * `pending`-without-queueId records.
 * @returns {Promise<{ refreshed:number, resent:number, errors:number }>}
 */
async function runPoll({ limit = 300, dryRun = false } = {}) {
  if (!featureEnabled()) return { refreshed: 0, resent: 0, errors: 0, skipped: "feature off" };

  const { rows } = await pool.query(
    `SELECT vr.id, vr.invoiceid, vr.queue_id, vr.kind, vr.aeat_state,
            COALESCE(i.entityid, p.entityid::bigint) AS entityid
       FROM verifactu_records vr
       JOIN invoices i ON i.id = vr.invoiceid
       LEFT JOIN projects p ON p.id = i.projectid::bigint
      WHERE vr.created_at > now() - interval '${MAX_AGE}'
        AND (
          (vr.aeat_state = 'pending')
          OR (vr.aeat_state = 'sent' AND vr.queue_id IS NOT NULL
              AND (vr.state_checked_at IS NULL OR vr.state_checked_at < now() - interval '${STALE_AFTER}'))
        )
      ORDER BY vr.created_at
      LIMIT $1`,
    [limit]
  );

  const cfgCache = new Map();
  async function cfgForEntity(entityId) {
    const key = String(entityId || 0);
    if (!cfgCache.has(key)) cfgCache.set(key, credsFor(await entityRow(entityId)));
    return cfgCache.get(key);
  }

  let refreshed = 0;
  let resent = 0;
  let errors = 0;
  const resentInvoices = new Set();

  for (const rec of rows) {
    const cfg = await cfgForEntity(rec.entityid);
    if (!cfg.enabled) continue;
    try {
      if (rec.aeat_state === "pending" && !rec.queue_id) {
        if (resentInvoices.has(rec.invoiceid)) continue;
        resentInvoices.add(rec.invoiceid);
        if (!dryRun) await retryRecord(rec.invoiceid, {});
        resent++;
      } else if (rec.queue_id) {
        if (!dryRun) await refreshRecord(rec, cfg);
        refreshed++;
      }
    } catch (err) {
      errors++;
      console.error(`[verifactu:poll] record ${rec.id} (invoice ${rec.invoiceid}):`, err.message);
    }
  }

  return { refreshed, resent, errors, candidates: rows.length };
}

module.exports = { refreshInvoice, refreshRecord, runPoll };
