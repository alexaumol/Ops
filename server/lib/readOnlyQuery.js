/**
 * Shared read-only query runner.
 * ---------------------------------------------------------------------------
 * Runs one parameterised statement inside `BEGIN READ ONLY` with a
 * per-statement timeout. That transaction — not the role's grants — is what
 * guarantees no write happens, so this is safe even on the main read/write
 * pool (see the note in config/db.js).
 *
 * Prefers the dedicated SELECT-only pool (readerPool) when one is configured
 * (PG_READONLY_*). If that pool proves UNREACHABLE — a pg_hba.conf rejection,
 * a bad password, SSL mismatch, host down — it latches to the main pool for
 * the rest of the process and logs a one-time warning. The feature keeps
 * working; the fix is to make the PG_READONLY_* role reachable (pg_hba.conf /
 * SSL) to restore the extra sandbox.
 * ---------------------------------------------------------------------------
 */
const { pool, readerPool } = require("../config/db");

const STMT_TIMEOUT_MS = Number(process.env.PG_READONLY_TIMEOUT_MS) || 8000;
const HAS_DEDICATED_READER = readerPool !== pool;

let readerUnavailable = false;

async function runOnPool(p, text, params) {
  const client = await p.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${STMT_TIMEOUT_MS}`);
    const { rows } = await client.query(text, params);
    await client.query("COMMIT");
    return rows;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

// A connection/auth failure (not a problem with the SQL itself).
function isConnectionFailure(err) {
  const code = err && err.code;
  if (["28000", "28P01", "3D000", "08001", "08006", "08004", "08P01",
       "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH"].includes(code)) {
    return true;
  }
  return /no pg_hba\.conf entry|password authentication failed|no encryption|SSL (?:off|connection|required)|connection refused|getaddrinfo|timeout expired/i
    .test((err && err.message) || "");
}

async function runReadOnly(text, params = []) {
  if (HAS_DEDICATED_READER && !readerUnavailable) {
    try {
      return await runOnPool(readerPool, text, params);
    } catch (err) {
      if (!isConnectionFailure(err)) throw err;
      readerUnavailable = true;
      console.warn(
        `[readOnlyQuery] the dedicated read-only pool is unreachable (${err.code || err.message}). ` +
        `Falling back to the main pool inside a READ ONLY transaction for the rest of this process. ` +
        `Add a pg_hba.conf entry (and SSL, if required) for the PG_READONLY_* role to restore SELECT sandboxing.`
      );
    }
  }
  return runOnPool(pool, text, params);
}

module.exports = { runReadOnly };
