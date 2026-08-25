/**
 * PostgreSQL connection pool.
 *
 * Credentials come ONLY from process.env (populated by dotenv from a
 * server-side .env file that is never shipped to the browser — see
 * ../.env.example). This module is the single choke point for DB access;
 * routes import `pool` from here rather than creating their own clients.
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

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on("error", (err) => {
  console.error("[db] Unexpected error on idle PostgreSQL client", err);
});

module.exports = { pool };
