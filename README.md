# HITT Ops — Web Prototype

Replaces the MS Access "HITT Ops" application with a web app, built for
progressive delivery: one module at a time goes live while the rest keeps
working as-is.

## Why two folders

```
public/   Static frontend — HTML/CSS/vanilla JS only, no build step.
          Can be run straight from a shared network folder, copied to an
          employee's machine and opened with a double-click, or served by
          any web server later. Contains NO secrets.

server/   Node/Express API — the ONLY thing that knows the PostgreSQL
          credentials. Runs on a server (a Linux VPS, per your setup),
          never on employee machines.
```

The split exists because "static files employees can run locally" and
"hide DB credentials" are in tension — a browser can't safely hold a
database password. The frontend never talks to Postgres directly; it
calls the API over HTTPS, and the API is the only thing with a `.env` file.

## Hiding the PostgreSQL credentials

- `server/.env` (copied from `server/.env.example`, filled in with the
  real `postgres` password) lives only on the API server. It's covered by
  `server/.gitignore` so it can never be committed or accidentally shipped.
- `public/js/config.js` — the only "configuration" file that ships to
  employees — contains just the API's public URL and (later) the Entra ID
  tenant/client IDs. Neither is a secret: a client ID identifies an app
  registration, it doesn't authenticate one.
- If this ever needs to be hardened further (e.g. once it's not just a
  test environment), move `server/.env` values into a proper secrets
  vault — Azure Key Vault is the natural choice since you're already in
  the Microsoft 365 / Entra ID ecosystem — and have `server.js` fetch them
  at startup instead of reading `.env`. The rest of the app doesn't change.

## Running it

**Backend (on the VPS or any machine that can reach `217.154.101.149:8432`):**

```bash
cd server
cp .env.example .env      # fill in PGPASSWORD and CORS_ALLOWED_ORIGINS
npm install
npm start                 # listens on PORT (default 4000)
```

Put this behind Nginx/Caddy with a real TLS certificate for anything
beyond local testing — right now it's plain HTTP, fine for a same-LAN
prototype, not for the open internet.

**Frontend (anywhere):**

- Simplest: open `public/index.html` directly in a browser (`file://…`).
- Shared folder: point employees at `\\server\share\HITT-Ops\index.html`
  (or the Linux/Mac equivalent) — no install needed.
- Local copy: zip `public/` and have each employee extract it; only
  `public/js/config.js` ever needs editing per-deployment (the API URL).

Before any of this works end-to-end, edit `public/js/config.js`:

```js
API_BASE_URL: "https://ops-api.fhitt.org", // -> your real API URL
```

## What's real vs. placeholder right now

| Area | Status |
|---|---|
| Login page | UI built (M365-style two-step form), **no credential validation** as requested. Stub in `js/auth.js` remembers the typed username only. |
| Welcome menu | Built — Projects / Business partners / Time allocation / Invoicing tiles. |
| Projects (kanban) | Built and wired to `GET/POST/PATCH /api/projects`. Falls back to on-screen demo data automatically if the API can't be reached, and says so in the header pill. |
| Business partners / Time allocation / Invoicing | Placeholder "coming soon" pages using the same shared header/auth, ready to receive real content next. |
| Backend `/api/projects` | Wired to the **real** schema (confirmed 2026-08-22 via `information_schema.columns`): `projects`, `projectstatus` (stage lookup, has an `ordinal` column), and `projectportfolioprogress` (a progress history table — the API takes the most recent row per project). See `server/routes/projects.js`. |
| Stage labels | Fetched live from `GET /api/projects/statuses` (reads the `projectstatus` table) and matched onto the Lead/Oferta/Guanyat/WIP/Delivered/Closed/Cancelled styling by name; falls back to the hardcoded 0–6 order if that call fails, so the board still renders. |
| Microsoft 365 sign-in | Not implemented yet. `js/auth.js` and `js/config.js` have TODOs for wiring in MSAL.js once you provide the Entra tenant ID and register an app (client ID). |

## Real schema notes (for extending the other modules)

The database is already well-normalized — no guessing needed for the next
modules either. Relevant tables found:

- **Business partners**: `businesspartners`, `businesspartnersnotes`, `contacts`, `addresses`, `taxcompanies` + `taxcompaniesaddresses`, `companytypes`, `countries`.
- **Time allocation**: `timeallocationlog`, `projectstimetracking`, `employeeworkcalendar`, `holidays`, `timeoffrequests`.
- **Invoicing**: `invoices`, `invoicesdetails`, `invoicesstatus`, `invoicingprojectrelease`, `invoicescheduletypes`, `invoicepaymentmethods`, `invoices_vattypes`.
- **Projects (done)**: `projects`, `projectstatus`, `projectportfolioprogress`, plus `projectquotations`, `projectdeliverables`, `projectnotes`, `projectowners`, `expenses` for the project modal's other tabs (not wired yet — see the "not wired yet" notes inside `pages/projects.html`).
- A number of `qry_*` and `q_*` views already exist (e.g. `qry_projectandprogress`, `q_project_portfolio_overview`) — these look like pre-built reporting joins from the Access side and may be worth reusing directly instead of re-deriving the same joins in the API.

## Next steps (once you're ready)

1. Run the backend against the real test DB and confirm `GET /api/projects`
   and `GET /api/projects/statuses` return sensible data — I wrote the SQL
   from the schema but haven't been able to execute it against your actual
   rows.
2. Register an Entra ID app for this SPA, give me the tenant ID + client
   ID, and I'll wire up MSAL.js for real Microsoft 365 sign-in.
3. Decide the API's real hostname (e.g. `ops-api.fhitt.org`) and TLS setup,
   then update `public/js/config.js`.
4. Pick the next module to bring online — Business partners has the
   simplest schema of the remaining three and the Projects modal already
   needs it (contracting/invoicing business partner lookups).
