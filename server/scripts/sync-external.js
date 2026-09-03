/**
 * Settings → Sync — external-storage catch-up job.
 * ---------------------------------------------------------------------------
 *   npm run sync:external            push anything new / retry past errors
 *   npm run sync:external -- --dry   report what would be pushed, do nothing
 *   npm run sync:external -- --limit 200
 *
 * Documents are pushed best-effort at upload time (see lib/externalSync.js);
 * this job is the safety net + the one-time backfill of everything that
 * existed before the feature was switched on. Wire it to an hourly systemd
 * timer (backup/systemd/ops-sync-external.*).
 *
 * A document is "pending" when it has no external_sync row, or its last
 * attempt failed. Successfully-synced documents are NOT re-pushed here (only
 * the upload hooks refresh them on change).
 * ---------------------------------------------------------------------------
 */
require("dotenv").config();
const { pool } = require("../config/db");
const graph = require("../lib/graph");
const externalSync = require("../lib/externalSync");

const DRY = process.argv.includes("--dry");
const limIdx = process.argv.indexOf("--limit");
const LIMIT = limIdx > -1 ? Math.max(1, Number(process.argv[limIdx + 1]) || 1000) : 1000;

async function pending(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows.map((r) => r.id);
}

(async () => {
  const cfg = await externalSync.getSyncConfig(pool);
  if (!graph.syncConfigured()) {
    console.log("[sync:external] Graph integration not configured (GRAPH_* env vars) — nothing to do.");
    await pool.end();
    return;
  }

  const work = { project_folder: [], expense_doc: [], invoice_doc: [] };

  if (cfg.projectsLocation) {
    work.project_folder = await pending(
      `SELECT p.id FROM projects p
         LEFT JOIN external_sync s ON s.kind = 'project_folder' AND s.ref_id = p.id
        WHERE p.projectnumber IS NOT NULL AND p.projectnumber <> ''
          AND p.entityid IS NOT NULL
          AND (s.id IS NULL OR s.status = 'error')
        ORDER BY p.id
        LIMIT $1`, [LIMIT]);
  }
  if (cfg.otherLocation && cfg.docTypes.has("tickets")) {
    work.expense_doc = await pending(
      `SELECT x.id FROM expenses x
         LEFT JOIN external_sync s ON s.kind = 'expense_doc' AND s.ref_id = x.id
        WHERE x.ticketurl IS NOT NULL AND x.ticketurl <> ''
          AND (s.id IS NULL OR s.status = 'error')
        ORDER BY x.id
        LIMIT $1`, [LIMIT]);
  }
  if (cfg.otherLocation && cfg.docTypes.has("invoices")) {
    work.invoice_doc = await pending(
      `SELECT i.id FROM invoices i
         LEFT JOIN external_sync s ON s.kind = 'invoice_doc' AND s.ref_id = i.id
        WHERE (s.id IS NULL OR s.status = 'error')
        ORDER BY i.id
        LIMIT $1`, [LIMIT]);
  }

  const totals = Object.fromEntries(Object.entries(work).map(([k, v]) => [k, v.length]));
  console.log(`[sync:external] pending — projects ${totals.project_folder}, tickets ${totals.expense_doc}, invoices ${totals.invoice_doc} (limit ${LIMIT}/kind)`);

  if (DRY) {
    console.log("[sync:external] --dry: nothing pushed.");
    await pool.end();
    return;
  }

  let ok = 0, failed = 0, skipped = 0;
  const tally = (r) => { if (!r) skipped++; else if (r.ok) ok++; else if (r.error) failed++; else skipped++; };

  for (const id of work.project_folder) {
    const { rows } = await pool.query(
      `SELECT id, projectnumber AS code, entityid AS "entityId", projectname AS name FROM projects WHERE id = $1`, [id]);
    tally(await externalSync.syncProjectFolder(pool, rows[0]));
  }
  for (const id of work.expense_doc) tally(await externalSync.syncExpenseDoc(pool, id));
  for (const id of work.invoice_doc) tally(await externalSync.syncInvoiceDoc(pool, id));

  console.log(`[sync:external] done — ${ok} ok, ${failed} failed, ${skipped} skipped.`);

  try {
    await pool.query(
      `INSERT INTO actionsaudit (actiondesc, actionts, actionkind, loglevel)
       VALUES ($1, now(), 'sync.run', $2)`,
      [`External sync: ${ok} ok, ${failed} failed, ${skipped} skipped `
        + `(projects ${totals.project_folder}, tickets ${totals.expense_doc}, invoices ${totals.invoice_doc}).`,
       failed ? 3 : 2]
    );
  } catch (err) {
    console.error("[sync:external] could not write audit row:", err.message);
  }

  await pool.end();
  if (failed) process.exit(1);
})().catch((err) => {
  console.error("[sync:external] failed:", err.message || err);
  process.exit(1);
});
