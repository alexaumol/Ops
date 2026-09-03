# HITT Ops

A web app for managing project lifecycle and invoicing at HITT, replacing
a legacy MS Access application. Built for **progressive delivery** — each
module (Projects, Business partners, Time allocation, Invoicing) goes live
independently while the rest keeps working as static placeholder pages.

## Features

- **Microsoft 365 sign-in** — real Entra ID (Azure AD) sign-in via MSAL.js,
  with the access token it issues verified server-side (signature, issuer,
  audience, expiry, tenant, scope) on every API request. See
  [Authentication](#authentication).
- **Project portfolio kanban** — drag-and-drop board across pipeline
  stages, search, project detail modal (deliverables, notes, quotations),
  business-partner and invoicing-partner pickers.
- **Business partners** — searchable directory with contacts, notes, and
  tax companies per partner.
- **Time allocation** — weekly project-hours logging and time-off requests
  (submit/view/withdraw/approve/reject).
- **Permissions & Settings** — admin-only page to manage who's an admin,
  who can approve/reject time-off requests, which modules each employee
  can access, and who's active vs. deactivated.
- **Invoicing** — proceed-to-invoice release settings per project, invoice
  create/edit with auto-derived status and VAT, and PDF generation matching
  the real HITT invoice template.
- **Expenses** — company expenses (travel, meals, materials) bound to a
  project or marked internal, each with one evidence document. Includes a
  phone-first **mobile capture** page (`pages/mobile-expenses.html`,
  installable to a home screen via `manifest.json` — the first slice of a
  gradually-growing mobile app): photograph a receipt, bind it to an alive
  project, and it's created under your own name. The project picker there
  is pre-filtered server-side (`GET /api/expenses/my-projects`) to alive
  projects you're assigned to as owner/resource; an admin sees every alive
  project instead.
- **Reports** — hours logged per project (with a per-employee drill-down),
  a calendar view of company holidays and employee leaves, portfolio
  charts (projects by status/entity, projects opened by month), a project
  status-change timeline, and CSV export on every report.
- **Ops assistant** — an in-app chat widget that answers questions about a
  project or business partner and gives portfolio insight (budgeted vs
  invoiced, trends). Backed by Azure OpenAI with read-only tool calls; off
  until configured. See [Ops assistant](#ops-assistant).
- Corporate design system with light/dark support and a small set of
  reusable UI primitives (buttons, app header, cards).

## Tech stack

- **Frontend**: plain HTML/CSS/vanilla JS — no framework, no build step to
  run. Ships as static files that can be opened directly in a browser or
  served from any web server / shared folder.
- **Backend**: Node.js + Express, exposing a small REST API.
- **Database**: PostgreSQL.
- **Styling**: Tailwind CSS (pre-compiled — see `build/`) plus a small
  hand-written design-token stylesheet.

## Project structure

```
public/   Static frontend — HTML/CSS/vanilla JS only.
          index.html          → sign-in
          welcome.html        → module menu
          pages/               → one page per module
          css/, js/            → shared styles & scripts

server/   Node/Express REST API. The only component that talks to
          PostgreSQL — the frontend never holds database credentials.

build/    Dev-only tooling that compiles the Tailwind CSS used by the
          Projects page into a static stylesheet committed under
          public/css/. Not required at runtime.
```

The frontend/backend split exists so the static files can be safely
distributed (shared folder, employee machine, etc.) without ever holding a
database credential — all data access goes through the API over HTTPS.

## Getting started

**Backend:**

```bash
cd server
cp .env.example .env   # fill in your own PostgreSQL connection details
npm install            # includes multer, used for expense evidence uploads
npm start               # listens on PORT (default 4000)
```

Expense evidence files are written to `UPLOAD_DIR/expenses` (env var,
default `server/uploads/`). That directory is gitignored — back it up
alongside the database.

**Frontend:**

Open `public/index.html` in a browser, or serve the `public/` folder with
any static file server. Edit `public/js/config.js` to point at your API's
URL and (once registered) your Entra ID tenant/client IDs.

**Rebuilding the Projects page's Tailwind CSS** (only needed if you change
a Tailwind class in `pages/projects.html` or `js/projects.js`):

```bash
cd build
npm install
npm run build:css
```

**Updating the vendored MSAL library** (`public/vendor/msal-browser.min.js`
— vendored rather than loaded from a CDN, since this app needs to work from
a locked-down corporate network):

```bash
cd build
npm install
npm run vendor:msal
```

Real Microsoft sign-in only works when `public/` is served over http(s) —
opening `index.html` directly as a `file://` URL cannot complete the Entra
ID sign-in popup. The exact origin serving the files must also be
registered as a redirect URI on the Entra app registration (Authentication
→ Single-page application).

## Authentication

The frontend acquires an Entra ID **access token** for this app's own API
scope and sends it as `Authorization: Bearer …` on every request. The API
verifies each token's signature (against the tenant's published JWKS),
issuer, audience, expiry, tenant and delegated scope before trusting the
caller — see [`server/lib/entraToken.js`](server/lib/entraToken.js). The
identity then resolves to an `employees` row exactly as before, and the
existing per-module permission layer applies on top.

**`AUTH_MODE`** (server env, see `server/.env.example`):

| value    | behaviour |
|----------|-----------|
| `bearer` | Every request needs a valid verified token. `X-HITT-User` is ignored. Missing/invalid → 401. **Use for real deployments.** Default when `AAD_TENANT_ID` + `AAD_CLIENT_ID` are set. |
| `hybrid` | A valid token wins; if none is sent, fall back to trusting `X-HITT-User`. A token that *is* sent but invalid still → 401 (no silent downgrade). Rollout only. |
| `header` | Legacy — trust the `X-HITT-User` header. Not secure. Local / offline / stub-login only. Default when AAD is not configured. |

**One-time Entra setup for `bearer`** (same SPA app registration employees
sign in with):

1. **Expose an API** → set Application ID URI to `api://<AAD_CLIENT_ID>`.
2. **Add a scope** → `access_as_user` (admins + users can consent).
3. **Authorized client applications** → add `<AAD_CLIENT_ID>` itself and
   check the `access_as_user` scope, so users get no consent prompt.

Then set `AAD_TENANT_ID`, `AAD_CLIENT_ID`, `AUTH_MODE=bearer` in
`server/.env` and restart. `public/js/config.js` needs no change — it
derives the scope as `api://<clientId>/access_as_user` (override via
`MSAL.apiScopes` if you named things differently).

**Cutover / rollback.** Deploy the new frontend and set `AUTH_MODE=hybrid`
first: existing tabs keep working, new page loads start sending tokens.
Once the audit log shows everyone on `bearer`-method requests, switch to
`AUTH_MODE=bearer`. To roll back instantly, set `AUTH_MODE=header` and
restart — `/api/health` stays open in every mode.

**Offline / `file://` testing** still works: set `FEATURES.msalLoginEnabled`
to `false` in `config.js` and run the server with `AUTH_MODE=header`.

## Ops assistant

A chat widget (bottom-right on every module page) that answers questions
about a project or business partner and reads the portfolio for insight —
budgeted vs invoiced, trends, where attention is worth spending.

**How it works.** `public/js/chat.js` posts the conversation to
`POST /api/chat`. The server ([`server/routes/chat.js`](server/routes/chat.js))
runs a tool-calling loop against Azure OpenAI
([`server/lib/chatLlm.js`](server/lib/chatLlm.js)): the model can only call
the fixed read-only tools in
[`server/lib/chatTools.js`](server/lib/chatTools.js) — `get_project`,
`get_business_partner`, `budget_vs_invoiced`, `portfolio_trend`,
`search_projects`, `list_projects` — each a parameterised query run inside
a `READ ONLY` transaction on a SELECT-only pool. The model never sees the
database and never emits SQL; every figure in an answer comes from a tool
result. Access is gated by the `chat` module permission (Settings), a
per-user rate limit, and the `chatEnabled` feature flag.

**Turn it on:**

1. Create an **Azure OpenAI** resource in an EU region, deploy a chat model
   (e.g. `gpt-4.1`), and set `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`,
   `AZURE_OPENAI_DEPLOYMENT` in `server/.env`.
2. Create the read-only DB role and set `PG_READONLY_USER` /
   `PG_READONLY_PASSWORD` (SQL in `server/.env.example`). Until you do, the
   tools run on the main pool — fine for a first test, not for production.
3. Restart the server. `GET /api/chat/status` flips to
   `{ configured: true }` and the widget appears for users with `chat`
   access.

Without step 1 the feature is simply off: `/api/chat` returns 503 and the
widget stays hidden.

## Status

Early-stage prototype. Projects, Business partners, Time allocation,
Invoicing, and Reports are all wired to a real PostgreSQL test database.
Microsoft 365 sign-in is real (Entra ID via MSAL.js), and the API verifies
the access token server-side on every request (see
[Authentication](#authentication)). The Ops assistant is scaffolded and
runs once Azure OpenAI is configured (see [Ops assistant](#ops-assistant)).
A permissions layer controls module
access, admin rights, and time-off approve/reject rights (see Settings,
admin-only). Not yet built: invoice-PDF emailing.

## License

Internal project — not currently licensed for external use.
