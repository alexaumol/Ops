/**
 * Verify the presence register hash chains.
 * ---------------------------------------------------------------------------
 *   npm run presence:verify
 *
 * Walks every employee's presence_events chain (prev_hash -> row_hash) and
 * reports any break — i.e. a row that was altered directly in the database,
 * bypassing the append-only API and the immutability trigger. Exits non-zero
 * if any chain is broken (wire it into a monitoring cron).
 * ---------------------------------------------------------------------------
 */
require("dotenv").config();
const { pool } = require("../config/db");
const { verifyChain } = require("../lib/presence");

(async () => {
  const { rows: emps } = await pool.query(
    `SELECT DISTINCT employee_id FROM presence_events ORDER BY employee_id`
  );
  let broken = 0;
  for (const { employee_id } of emps) {
    const r = await verifyChain(pool, employee_id);
    if (r.ok) {
      console.log(`[presence:verify] employee ${employee_id}: OK (${r.count} events)`);
    } else {
      broken++;
      console.error(`[presence:verify] employee ${employee_id}: BROKEN at event ${r.brokenAt} — ${r.reason}`);
    }
  }
  await pool.end();
  if (broken) {
    console.error(`[presence:verify] ${broken} chain(s) broken — the register has been tampered with.`);
    process.exit(1);
  }
  console.log(`[presence:verify] all ${emps.length} chain(s) intact.`);
})().catch((err) => {
  console.error("[presence:verify] failed:", err.message || err);
  process.exit(2);
});
