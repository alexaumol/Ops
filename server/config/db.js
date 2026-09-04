/**
 * PostgreSQL connection pools.
 *
 * Credentials come ONLY from process.env (populated by dotenv from a
 * server-side .env file that is never shipped to the browser — see
 * ../.env.example). This module is the single choke point for DB access;
 * routes import a pool from here rather than creating their own clients.
 *
 *   pool        the read/write pool every normal route uses.
 *   readerPool  a SELECT-only pool for the chat assistant's tools
 *               (lib/chatTools.js). Uses PG_READONLY_* if set, otherwise
 *               falls back to `pool` — so the assistant still works before
 *               the dedicated role exists, it just isn't sandboxed yet.
 *               Every statement it runs is capped by PG_READONLY_TIMEOUT_MS.
 */
const { Pool } = require("pg");

const requiredVars = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"];
const missing = requiredVars.filter((v) => !process.env[v]);
if (missing.length) {
  console.error(
    `[db] Missing required environment variables: ${missing.join(", ")}. ` +
      `Copy server/.env.example to server/.env and fill in real values.`
  );
}

const ssl = process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : false;

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on("error", (err) => {
  console.error("[db] Unexpected error on idle PostgreSQL client", err);
});

// --- Read-only pool for the chat assistant ------------------------------
const READONLY_CONFIGURED = !!(process.env.PG_READONLY_USER && process.env.PG_READONLY_PASSWORD);

let readerPool;
if (READONLY_CONFIGURED) {
  const roUser = process.env.PG_READONLY_USER;
  readerPool = new Pool({
    host: process.env.PG_READONLY_HOST || process.env.PGHOST,
    port: Number(process.env.PG_READONLY_PORT || process.env.PGPORT) || 5432,
    database: process.env.PG_READONLY_DATABASE || process.env.PGDATABASE,
    user: roUser,
    password: process.env.PG_READONLY_PASSWORD,
    ssl,
    max: 5,
    idleTimeoutMillis: 30000,
  });
  readerPool.on("error", (err) => {
    console.error("[db] Unexpected error on idle read-only PostgreSQL client", err);
  });
  console.log(`[db] chat assistant uses the dedicated read-only role "${roUser}"`);
} else {
  readerPool = pool;
  if (process.env.AZURE_OPENAI_ENDPOINT) {
    console.warn(
      "[db] PG_READONLY_* not set — the chat assistant's queries will run on the read/write pool " +
        "(no per-statement timeout, not SELECT-sandboxed). Create a SELECT-only role and set " +
        "PG_READONLY_USER / PG_READONLY_PASSWORD before production (see .env.example)."
    );
  }
}

module.exports = { pool, readerPool, READONLY_CONFIGURED };
