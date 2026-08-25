# HITT Ops

A web app for managing project lifecycle and invoicing at HITT, replacing
a legacy MS Access application. Built for **progressive delivery** — each
module (Projects, Business partners, Time allocation, Invoicing) goes live
independently while the rest keeps working as static placeholder pages.

## Features

- **Microsoft 365 sign-in** — login flow styled after the M365 experience,
  wired for Entra ID (Azure AD) via MSAL.js.
- **Project portfolio kanban** — drag-and-drop board across pipeline
  stages (Lead → Oferta → Guanyat → WIP → Delivered → Closed → Cancelled),
  with search, project detail modal, and progress tracking.
- **Business partners, Time allocation, Invoicing** — additional modules,
  brought online one at a time.
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

## Status

Early-stage prototype. The Projects module is wired end-to-end; Business
partners, Time allocation, and Invoicing are placeholder pages awaiting
their turn. Microsoft 365 sign-in is UI-only pending an Entra ID app
registration.

## License

Internal project — not currently licensed for external use.
