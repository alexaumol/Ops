# HITT Ops

A web app for managing project lifecycle and invoicing at HITT, replacing
a legacy MS Access application. Built for **progressive delivery** — each
module (Projects, Business partners, Time allocation, Invoicing) goes live
independently while the rest keeps working as static placeholder pages.

## Features

- **Microsoft 365 sign-in** — real Entra ID (Azure AD) sign-in via MSAL.js.
- **Project portfolio kanban** — drag-and-drop board across pipeline
  stages, search, project detail modal (deliverables, notes, quotations),
  business-partner and invoicing-partner pickers.
- **Business partners** — searchable directory with contacts, notes, and
  tax companies per partner.
- **Time allocation** — weekly project-hours logging and time-off requests
  (submit/view/withdraw).
- **Invoicing** — proceed-to-invoice release settings per project, invoice
  create/edit with auto-derived status and VAT, and PDF generation matching
  the real HITT invoice template.
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
npm install
npm start               # listens on PORT (default 4000)
```

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

## Status

Early-stage prototype. Projects, Business partners, Time allocation, and
Invoicing are all wired to a real PostgreSQL test database. Microsoft 365
sign-in is real (Entra ID via MSAL.js). Not yet built: approve/reject
workflows (need a manager-relationship concept the data model doesn't have
yet), invoice-PDF emailing, and server-side validation of the MSAL ID token
(the API currently trusts a plain header, not a verified bearer token).

## License

Internal project — not currently licensed for external use.
