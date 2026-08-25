# HITT Ops — Handoff Context (Cowork → VS Code / Claude Code)

This summarizes everything decided and built in the Cowork session before
switching to VS Code + Claude Code, so the next session doesn't have to
rediscover it. The project itself (this zip) is the source of truth; this
file is the narrative behind it.

## The ask

Alex is the IT SME at HITT (fhitt.org) rebuilding a custom MS Access app
(project lifecycle + invoicing management) as a web app. Requirements:

- **Progressive delivery** — ship one module at a time, rest kept working.
- Frontend must run as **plain static files**: shared network folder, or
  copied locally to an employee's machine, no install step.
- Connects to a **test PostgreSQL environment** at `217.154.101.149:8432`,
  generic `postgres` user — credentials must be **hidden from employees**.
- **Login page** using Microsoft 365 credentials (Alex will supply an Entra
  ID tenant ID later); **no credential validation for now**.
- After login → **welcome menu**: Projects, Business partners, Time
  allocation, Invoicing.
- **Projects** → a kanban board like one from an earlier, separate Claude
  conversation ("Project lifecycle kanban board proof of concept"), this
  time wired to real data.
- **Responsive, modern CSS**, colours from the company's corporate colour
  sheet, not afraid of custom/non-standard visuals (Alex's stated
  preference — he's a PowerBI/Deneb/SVG enthusiast).

## Decisions made (asked via clarifying questions, all confirmed by Alex)

| Decision | Choice |
|---|---|
| Backend language | **Node.js + Express** (Claude's recommendation, Alex deferred) — chosen for MSAL.js compatibility later and a mature `pg` driver |
| Backend hosting | **Linux VPS on the hosting provider** |
| Secret storage | **Server-side `.env`** file (not a vault — this is a test environment) |
| Kanban reference | Alex uploaded the actual file: `hitt_project_pipeline_1.html` — a full-featured drag-and-drop kanban (Tailwind CDN, mock/seeded data, project detail modal, "new project" modal) |

## Architecture delivered

Two folders, split specifically so the static frontend never needs to know
the database password:

```
public/   Static HTML/CSS/vanilla JS, no build step, no secrets.
          index.html         → M365-style 2-step login (NOT validated yet — stub only)
          welcome.html       → 4-tile menu (Projects live, other 3 "coming soon")
          pages/projects.html → kanban board, wired to the API
          pages/business-partners.html, time-allocation.html, invoicing.html → placeholder shells
          css/styles.css     → design tokens (corporate colours) + shared header/buttons
          js/config.js       → the ONLY file that needs editing per deployment (API URL, future MSAL ids)
          js/auth.js         → login stub + sessionStorage session helpers
          js/api.js          → thin fetch wrapper for the backend
          js/projects.js     → kanban logic: live data with fallback to demo data if API unreachable

server/   Node/Express API — the ONLY thing holding PostgreSQL credentials.
          server.js, config/db.js, routes/projects.js, .env.example (gitignored .env), package.json
```

Login → welcome → kanban flow was verified end-to-end with a headless
Playwright run (screenshots taken); login and welcome pages render exactly
as designed. The kanban page depends on the Tailwind CDN + Google Fonts at
runtime, which this sandbox's network couldn't reach, so it rendered
unstyled in-session — this is a sandbox limitation, not a code bug, but see
Caveat #1 below since it could bite in a real deployment too.

## Corporate colour tokens (extracted from "HITT corporate colours.jpg" in the Ops project)

```
--hitt-ink:      #171717   near-black, primary text/wordmark
--hitt-charcoal: #211916   darkest surface
--hitt-teal:     #5C757C   primary brand accent
--hitt-sage:     #ABAF96   secondary accent
--hitt-cream:    #DAD4B2   light surface tint
--hitt-olive:    #B3B07D   secondary surface
--hitt-amber:    #BC9A1C   call-to-action / highlight
Font: Calibri (corporate), system-ui/Segoe UI fallback stack
```

## Real PostgreSQL schema (confirmed — Alex ran a schema dump and pasted results)

This was a full `information_schema.columns` dump of the test DB. Key
tables identified and **already wired**:

- `projects` — id, projectnumber, projectname, entrydate, entityid,
  biospectrumid, projecttypeid, busspartnerid, **projectstatusid**,
  projectyear, busspartnertoinvoiceid, lastupdated, lastupdatedby,
  bprunningname, notinvoiceable
- `projectstatus` — id, projectstatusdesc, **ordinal** — the lookup table
  behind the kanban stages (Lead, Oferta, Guanyat, WIP, Delivered, Closed,
  Cancelled)
- `projectportfolioprogress` — id, projectid, progress, updatedby,
  updatedat, datadate — **a history table** (one row per snapshot, not per
  project) — the API takes the most recent row per project via a `LEFT
  JOIN LATERAL`

`server/routes/projects.js` was rewritten twice: first against guessed
table names (flagged clearly as guesses), then replaced entirely once the
real schema came back. It now exposes:

- `GET /api/projects` — full list, joined with latest progress
- `GET /api/projects/statuses` — real stage labels/order from `projectstatus`
  (the frontend fetches this and re-derives its kanban columns dynamically,
  matching styling by label text, with the hardcoded Lead→Cancelled order
  as a fallback if this call fails)
- `GET /api/projects/:id` — single project detail
- `POST /api/projects` — create (transaction: insert into `projects` +
  optional initial `projectportfolioprogress` row)
- `PATCH /api/projects/:id/stage` — drag-and-drop move
- `PATCH /api/projects/:id` — general edit (stage + progress today)

Tables identified for **later modules** (not yet wired, just located):

- **Business partners**: `businesspartners`, `businesspartnersnotes`,
  `contacts`, `addresses`, `taxcompanies` + `taxcompaniesaddresses`,
  `companytypes`, `countries`
- **Time allocation**: `timeallocationlog`, `projectstimetracking`,
  `employeeworkcalendar`, `holidays`, `timeoffrequests`
- **Invoicing**: `invoices`, `invoicesdetails`, `invoicesstatus`,
  `invoicingprojectrelease`, `invoicescheduletypes`,
  `invoicepaymentmethods`, `invoices_vattypes`
- **Projects, other modal tabs** (deliverables/quotations/notes/expenses —
  currently placeholder text in the modal): `projectquotations`,
  `projectdeliverables`, `projectnotes`, `projectowners`, `expenses`

Important: tables suffixed `_dump` (e.g. `projectportfolioprogress_dump`,
`businesspartnersnotes_dump`) are **Access-side caches refreshed FROM the
live tables** — never query those from the new API, they go stale.

Also present: a large number of `qry_*` / `q_*` views (e.g.
`qry_projectandprogress`, `q_project_portfolio_overview`,
`qry_projectstatuslist`) that look like pre-built reporting joins from the
Access side — possibly worth reusing directly for some endpoints instead of
re-deriving the same joins from scratch.

## Known caveats / open items for the next session

1. **`pages/projects.html` depends on `cdn.tailwindcss.com` + Google Fonts
   at runtime.** Fine on the open internet, but HITT is a managed Windows
   domain — a locked-down proxy could block it, and the whole point of this
   project is offline-capable static files. Worth replacing with a
   self-contained/compiled stylesheet (the rest of the app — login, welcome,
   placeholder pages — already uses plain CSS with zero external deps via
   `css/styles.css`, only the kanban page is the odd one out).
2. **The rewritten SQL has not been executed against real rows** — no
   direct DB access from the Cowork sandbox. First thing to check in VS
   Code: point the backend at the real test DB and confirm
   `GET /api/projects` and `GET /api/projects/statuses` return sane data.
   Watch for the `double precision` typing on several ID columns (likely an
   Access/ODBC artifact) in case it causes unexpected casts.
3. **MSAL.js / real Entra ID sign-in is not implemented.** `js/auth.js` and
   `js/config.js` have TODOs marking exactly where it plugs in. Waiting on
   Alex to register an Entra ID app and provide tenant ID + client ID.
4. **Business partners / Time allocation / Invoicing are placeholder
   "coming soon" pages** sharing the same header/auth/styling shell, ready
   to receive real content. Business partners is the suggested next module
   (simplest schema, and the Projects modal's "Contracting Business
   Partner" field already needs a BP search/lookup).
5. The Projects modal's other tabs (deliverables, quotations, notes,
   expenses) currently show "not wired yet" placeholder text — real tables
   are identified above, just not connected.

## Where things live

- This zip (`hitt-ops-web.zip`) is the full current state of the code.
- A living version of most of this document is also saved in Alex's
  **claude.ai "Ops" project** as `claude/web-prototype-plan.md`, alongside
  the original Access `.frm` exports and the corporate colours image this
  session read from. If a future Cowork session picks this up again, it'll
  find that doc plus the project's other reference files there.
- The kanban reference file Alex uploaded mid-session
  (`hitt_project_pipeline_1.html`) was a proof-of-concept from an earlier,
  separate conversation — it's not part of this deliverable, but its
  structure (drag & drop, modal, "new project" flow) is what
  `pages/projects.html` was built from.

## Suggested first prompt for Claude Code

> "This is the HITT Ops web prototype. Read CONTEXT.md and README.md first.
> I want to [point the backend at the real test DB and verify the
> projects/statuses endpoints / replace the Tailwind CDN dependency in
> pages/projects.html with a local stylesheet / build the Business
> partners module against the businesspartners table / wire up MSAL.js —
> here's the tenant ID and client ID]."
