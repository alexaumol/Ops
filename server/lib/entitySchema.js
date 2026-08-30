/**
 * Idempotent schema top-up for the billing-entity letterhead columns
 * (Settings → Entities). Shared by routes/entities.js (which owns the CRUD)
 * and routes/invoicing.js (which reads these columns when building an
 * invoice PDF, and may run before the Entities tab is ever opened).
 * Mirrored in server/db/schema-changes.sql.
 */
const { pool } = require("../config/db");

let ready = null;
function ensureEntitySchema() {
  if (!ready) {
    ready = (async () => {
      await pool.query(`ALTER TABLE entity ADD COLUMN IF NOT EXISTS legalname varchar(255)`);
      await pool.query(`ALTER TABLE entity ADD COLUMN IF NOT EXISTS vatnumber varchar(64)`);
      await pool.query(`ALTER TABLE entity ADD COLUMN IF NOT EXISTS address text`);
      await pool.query(`ALTER TABLE entity ADD COLUMN IF NOT EXISTS emailinvoicing varchar(255)`);
      await pool.query(`ALTER TABLE entity ADD COLUMN IF NOT EXISTS webpage varchar(255)`);
      await pool.query(`ALTER TABLE entity ADD COLUMN IF NOT EXISTS logo text`);
    })().catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

module.exports = { ensureEntitySchema };
