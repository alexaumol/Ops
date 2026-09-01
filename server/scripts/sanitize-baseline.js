/**
 * Turn a raw `pg_dump --schema-only` (or pgAdmin "schema only" backup) into a
 * portable baseline migration.
 *
 *   node scripts/sanitize-baseline.js <raw.sql> > ../migrations/<ts>_baseline.sql
 *
 * Drops: psql \restrict/\unrestrict, the SET/search_path session header, the
 * pgAdmin `pgagent` scheduler schema+extension, the migration tracking table
 * (node-pg-migrate owns it), known-dead objects (`auditlog`,
 * `update_access_timestamp`), and pg_dump's TOC comment noise. Keeps every
 * CREATE TABLE / SEQUENCE / INDEX / CONSTRAINT / FUNCTION for the app.
 */
const fs = require("fs");

const src = fs.readFileSync(process.argv[2], "utf8").replace(/\r\n/g, "\n");

// pg_dump separates objects with a blank-line gap; split on 2+ blank lines.
const chunks = src.split(/\n{3,}/);

// Whole objects to drop (substring match against the trimmed chunk — plain
// substrings, so `pgmigrations_id_seq` etc. are caught too; none of these
// appear as a substring of any object we want to keep).
const DROP_IF_MATCHES = [
  /pgagent/,               // pgAdmin scheduler — not part of Ops
  /pgmigrations/,          // node-pg-migrate creates/manages this itself
  /auditlog/,              // superseded by actionsaudit (see schema-changes.sql)
  /update_access_timestamp/, // dead trigger fn — no trigger, no column
];

// Individual lines to drop — session GUCs, psql meta-commands, TOC comments.
// NOT whole-chunk, because pg_dump glues `SET default_*` onto the first
// CREATE TABLE with only a blank line between them.
const STRIP_LINE = [
  /^\\(un)?restrict\b/,
  /^SET (statement_timeout|lock_timeout|idle_in_transaction_session_timeout|transaction_timeout|client_encoding|standard_conforming_strings|check_function_bodies|xmloption|client_min_messages|row_security|default_tablespace|default_table_access_method)\b/,
  /^SELECT pg_catalog\.set_config\('search_path'/,
  /^--(\s*$|\s*(TOC entry|Dependencies:|Name:.*Type:.*Schema:|Started on|Completed on|Dumped (from|by)|PostgreSQL database dump))/,
];

const out = [];
for (let chunk of chunks) {
  const trimmed = chunk.trim();
  if (!trimmed) continue;
  if (DROP_IF_MATCHES.some((re) => re.test(trimmed))) continue;

  const kept = chunk
    .split("\n")
    .filter((line) => !STRIP_LINE.some((re) => re.test(line)))
    .join("\n")
    .trim()
    // sequence START WITH values are the source DB's next id — a fresh
    // instance starts every sequence at 1.
    .replace(/(\bSTART WITH )\d+/g, "$11");

  if (kept) out.push(kept);
}

process.stdout.write(
  "-- ==========================================================================\n" +
    "-- BASELINE — full Ops schema as of v0.2.x\n" +
    "-- Generated from a pg_dump --schema-only of test_ops by\n" +
    "-- server/scripts/sanitize-baseline.js. See docs/migrations.md.\n" +
    "--\n" +
    "-- A database that ALREADY has this schema (HITT, or any instance created\n" +
    "-- before migrations) must NOT run this — mark it applied instead:\n" +
    "--   INSERT INTO pgmigrations (name, run_on)\n" +
    "--   VALUES ('1756684800000_baseline', now());\n" +
    "-- ==========================================================================\n\n" +
    out.join("\n\n") +
    "\n"
);
