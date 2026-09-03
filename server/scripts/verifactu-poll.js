/**
 * Veri*Factu — AEAT status poll.
 * ---------------------------------------------------------------------------
 * BOLD has no webhooks. This job re-reads the AEAT state of `sent` records
 * (catching a late AEAT rejection) and re-sends `pending` submissions that
 * never reached BOLD (an outage during issue/cancel). Safe to run often;
 * a `sent` record is only re-checked every couple of hours.
 *
 *   npm run verifactu:poll                 process up to 300 records
 *   npm run verifactu:poll -- --dry        report only, change nothing
 *   npm run verifactu:poll -- --limit 100
 *
 * Wire to a ~15-minute systemd timer on a Spanish instance. No-op when
 * FEATURE_VERIFACTU is off.
 * ---------------------------------------------------------------------------
 */
require("../lib/loadEnv");
const { runPoll } = require("../lib/verifactu/poll");

const dryRun = process.argv.includes("--dry");
const li = process.argv.indexOf("--limit");
const limit = li > -1 ? Math.max(1, Number(process.argv[li + 1]) || 300) : 300;

(async () => {
  try {
    const r = await runPoll({ limit, dryRun });
    console.log(`[verifactu:poll]${dryRun ? " (dry)" : ""}`, JSON.stringify(r));
    process.exit(0);
  } catch (err) {
    console.error("[verifactu:poll] failed:", err.message || err);
    process.exit(1);
  }
})();
