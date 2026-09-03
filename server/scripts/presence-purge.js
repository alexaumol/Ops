/**
 * Presence register — retention purge.
 * ---------------------------------------------------------------------------
 *   npm run presence:purge          delete records past the retention window
 *   npm run presence:purge -- --dry just report what would be deleted
 *
 * RDL 8/2019 requires the register to be kept for FOUR YEARS. Beyond that the
 * GDPR storage-limitation principle applies — the data no longer serves the
 * legal obligation, so it is deleted. `presence.retention_months` (appconfig,
 * default 48) sets the window.
 *
 * This is the ONLY code allowed to delete from presence_events: it runs the
 * DELETE inside a transaction that sets `app.presence_purge = 'on'`, which the
 * immutability trigger checks. It refuses to run while a legal hold is set
 * (`presence.legal_hold = 'on'` — set that during a dispute or inspection).
 *
 * Wire it to a monthly systemd timer (see backup/systemd/ops-presence-purge.*).
 * ---------------------------------------------------------------------------
 */
require("dotenv").config();
const { pool } = require("../config/db");
const { getConfig } = require("../lib/presence");

const DRY = process.argv.includes("--dry");

(async () => {
  const cfg = await getConfig(pool);
  if (cfg.legalHold) {
    console.error("[presence:purge] presence.legal_hold is ON — refusing to delete anything. Clear it in Settings → Presence when the hold is lifted.");
    process.exit(3);
  }
  const months = cfg.retentionMonths || 48;
  const { rows: cnt } = await pool.query(
    `SELECT count(*)::int AS n, min(local_date) AS oldest, max(local_date) AS newest
     FROM presence_events
     WHERE local_date < (current_date - ($1 || ' months')::interval)`,
    [months]
  );
  const n = cnt[0].n;
  console.log(`[presence:purge] retention = ${months} months; ${n} event(s) older than that${n ? ` (${cnt[0].oldest} … ${cnt[0].newest})` : ""}.`);

  const { rows: mcnt } = await pool.query(
    `SELECT count(*)::int AS n FROM presence_monthly
     WHERE make_date(period_year, period_month, 1) < (current_date - ($1 || ' months')::interval)`,
    [months]
  );
  console.log(`[presence:purge] ${mcnt[0].n} monthly summary row(s) older than that.`);

  if (DRY) { console.log("[presence:purge] --dry: nothing deleted."); await pool.end(); return; }
  if (!n && !mcnt[0].n) { console.log("[presence:purge] nothing to do."); await pool.end(); return; }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL app.presence_purge = 'on'");
    const e = await client.query(
      `DELETE FROM presence_events WHERE local_date < (current_date - ($1 || ' months')::interval)`,
      [months]
    );
    const m = await client.query(
      `DELETE FROM presence_monthly WHERE make_date(period_year, period_month, 1) < (current_date - ($1 || ' months')::interval)`,
      [months]
    );
    await client.query(
      `INSERT INTO actionsaudit (actiondesc, actionts, actionkind, loglevel)
       VALUES ($1, now(), 'presence.purge', 2)`,
      [`Purga de registro de jornada: ${e.rowCount} fichajes y ${m.rowCount} resúmenes anteriores a ${months} meses eliminados.`]
    );
    await client.query("COMMIT");
    console.log(`[presence:purge] deleted ${e.rowCount} events + ${m.rowCount} monthly summaries.`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
})().catch((err) => {
  console.error("[presence:purge] failed:", err.message || err);
  process.exit(1);
});
