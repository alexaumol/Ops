# Database migrations (0C)

Ordered, forward-only schema changes with `node-pg-migrate`. Replaces the
old approach — a hand-maintained `server/db/schema-changes.sql` log plus
`ensure*Schema()` functions that ran `ALTER TABLE … IF NOT EXISTS` lazily at
runtime. That was fine for one deployment; across a fleet it has no version
record, no ordering guarantee, and no way to tell a fresh instance apart
from an up-to-date one.

## Model

- Migrations live in `server/migrations/`, named `<timestamp>_<name>.sql`,
  applied in filename order.
- Applied migrations are tracked in a `pgmigrations` table — **one per
  database**, which is exactly right under one-DB-per-customer.
- `server/migrations/1756684800000_baseline.sql` is the **entire schema as
  of v0.2.x**. A fresh instance runs it to build the schema from nothing;
  everything after it is an incremental change.
- The connection comes from the same `PG*` env vars as the app
  (`server/scripts/migrate.js`).

## Commands

```bash
npm run migrate                 # apply all pending (the deploy step)
npm run migrate:down            # roll back the most recent migration
npm run migrate:create add_foo  # scaffold server/migrations/<ts>_add_foo.sql
```

## Deploy step

```bash
git pull
cd server && npm ci
npm run migrate                 # <-- new
sudo systemctl restart <ops-service>
```

`npm run migrate` takes a Postgres advisory lock, so a fleet-wide rollout
that restarts many instances at once is safe. A failing migration exits
non-zero — wire the deploy to stop there rather than restart on a
half-migrated schema.

## Baseline — capturing it (one-time, done once for the whole product)

`1756684800000_baseline.sql` ships as a placeholder. Populate it from a
real database:

```bash
# on a host with psql access to a current Ops DB (HITT's):
pg_dump --schema-only --no-owner --no-privileges --no-comments \
        --schema=public "$PGDATABASE" > baseline.raw.sql
```

Sanitise `baseline.raw.sql` so it's portable:

- drop leading `SET` / `SELECT pg_catalog.set_config(...)` session lines
- drop `CREATE SCHEMA public` / `COMMENT ON SCHEMA public` (already there)
- drop any `ALTER … OWNER TO` / `GRANT` / `REVOKE` (`--no-owner
  --no-privileges` removes most)
- keep `CREATE TABLE`, `CREATE SEQUENCE`, `CREATE INDEX`, `ALTER TABLE …
  ADD CONSTRAINT`, `CREATE VIEW`, functions, triggers
- if any `CREATE INDEX CONCURRENTLY` slipped in, drop `CONCURRENTLY` (a
  migration runs in a transaction)

Paste the result into `1756684800000_baseline.sql`, replacing the
`(schema goes here)` line. Commit.

## One-time step for a database that ALREADY has the schema

HITT's DB — and any SaaS instance created before migrations existed —
already has every table and every `ensure*` column. Running the baseline
there would fail on `CREATE TABLE employees …` (already exists). Mark it
applied without running it:

```sql
INSERT INTO pgmigrations (name, run_on)
VALUES ('1756684800000_baseline', now());
```

Then `npm run migrate` is a clean no-op, and every later migration applies
normally. (`node-pg-migrate` creates `pgmigrations` on its first run; if it
doesn't exist yet, run `npm run migrate` once first — it will try the
baseline and fail; create the table by hand or just run the INSERT after
the table exists. Simplest: `CREATE TABLE IF NOT EXISTS pgmigrations (id
serial PRIMARY KEY, name varchar(255) NOT NULL, run_on timestamp NOT NULL);`
then the INSERT, then `npm run migrate`.)

## Adding a migration

```bash
npm run migrate:create add_widget_flag
# edits: server/migrations/<ts>_add_widget_flag.sql
```

```sql
-- Up Migration
ALTER TABLE widgets ADD COLUMN flag boolean NOT NULL DEFAULT false;

-- Down Migration
ALTER TABLE widgets DROP COLUMN flag;
```

The `-- Up Migration` / `-- Down Migration` markers split the file; without
a Down section `migrate:down` can't reverse it. Commit the file with the
code change that needs it.

**Never** put a new schema change in `schema-changes.sql` or an `ensure*`
function again.

## Retiring the `ensure*` functions

The runtime `ensure*Schema()` calls stay for one release as a safety net
(they're already no-ops on any DB that's current — every column exists).
Once HITT and all instances are on migrations, delete them:

- `server/lib/entitySchema.js` — `ensureEntitySchema`
- `server/lib/audit.js` — `ensureAuditSchema`
- `server/lib/employeeProfile.js` — `ensureEmployeeProfileSchema`
- `server/routes/invoicing.js` — `ensureInvoicingSchema`, `ensureCurrencyTable`
- `server/routes/settings.js` — `ensureSettingsSchema`
- `server/routes/branding.js` — `ensureConfigTable`

and the `await ensure…()` calls in their routes. `server/db/schema-changes.sql`
becomes read-only history.
