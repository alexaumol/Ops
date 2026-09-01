/**
 * Database migration runner.
 * ---------------------------------------------------------------------------
 * Thin wrapper around node-pg-migrate that reuses the same PG* env vars as
 * config/db.js, so there's one place to configure the connection.
 *
 *   npm run migrate            apply every pending migration (deploy step)
 *   npm run migrate:down       roll back the most recent migration
 *   npm run migrate:create x   scaffold server/migrations/<ts>_x.sql
 *
 * Applied migrations are tracked in the `pgmigrations` table (one per
 * database — fine under the one-DB-per-customer model). See
 * docs/migrations.md, especially the ONE-TIME step for a database that
 * already has the schema (HITT, or any instance created before this).
 * ---------------------------------------------------------------------------
 */
require("../lib/loadEnv");
const path = require("path");
const runner = require("node-pg-migrate").default;

const requiredVars = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"];
const missing = requiredVars.filter((v) => !process.env[v]);
if (missing.length) {
  console.error(`[migrate] Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const direction = process.argv[2] === "down" ? "down" : "up";

runner({
  databaseUrl: {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT) || 5432,
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : false,
  },
  dir: path.join(__dirname, "..", "migrations"),
  migrationsTable: "pgmigrations",
  // only *_name.sql / .js files are migrations — skip notes, dotfiles, etc.
  ignorePattern: "\\..*|.*\\.(md|txt)$|.*~$",
  direction,
  count: direction === "down" ? 1 : Infinity,
  // Serialize concurrent runners (a fleet-wide restart) with an advisory lock.
  lock: true,
  verbose: true,
})
  .then((applied) => {
    console.log(
      applied.length
        ? `[migrate] ${direction}: ${applied.map((m) => m.name).join(", ")}`
        : `[migrate] ${direction}: nothing to do`
    );
    process.exit(0);
  })
  .catch((err) => {
    console.error("[migrate] failed:", err.message || err);
    process.exit(1);
  });
