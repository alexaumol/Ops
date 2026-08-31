# 0B — hardcoded values inventory

Result of the tree sweep for per-deployment values. Grouped by what to do about each.

---

## 1 · Template per instance — `public/js/config.js`

The frontend reads **everything** through `window.HITT_CONFIG`, so this one file is the
whole frontend templating surface. Confirmed: `api.js:10`, `auth.js:206`,
`branding.js:44`, `i18n.js:181` all use `HITT_CONFIG.API_BASE_URL`; no other
hardcoded host in `public/js`.

| Location | Current value | Per-instance value |
|---|---|---|
| `config.js:26` | `API_BASE_URL: "https://ops.fhitt.org"` | `https://<slug>.ops.theaumol.com` |
| `config.js:50` | `MSAL.tenantId: "6ab80f28-…"` | → OIDC `issuer: "https://auth.theaumol.com"` (shared) |
| `config.js:51` | `MSAL.clientId: "841556ac-…"` | → OIDC `clientId` of the shared "Ops" app (shared) |
| `config.js:52` | `redirectUri: origin + "/index.html"` | already dynamic — just register the origin in Zitadel at provision time |
| `config.js:63` | `apiScopes: null` → derives `api://…/access_as_user` | → `["openid","profile","email"]` |
| (new) | — | optional `orgIdHint: "<zitadel-org-id>"` so the login lands users in the right customer org |

Most of the identity block becomes **shared** (one Zitadel issuer + one Ops client);
the only truly per-instance frontend values are `API_BASE_URL` and the org hint.
The MSAL→OIDC rewrite itself is issue 0A — `auth.js:41` (`authority`),
`auth.js:70` (`api://…` scope), `auth.js:148`.

---

## 2 · Template per instance — `server/.env`

`server/server.js:59-77` already parses `CORS_ALLOWED_ORIGINS` correctly. Just needs
a documented template and per-instance values.

| Var | Current (`.env.example`) | Per-instance value |
|---|---|---|
| `CORS_ALLOWED_ORIGINS` | `https://ops.fhitt.org,http://localhost:5500,null` | `https://<slug>.ops.theaumol.com` only — **drop `localhost` and `null`** for prod |
| `PGHOST/PGDATABASE/PGUSER/PGPASSWORD` | test values | `ops_<slug>` DB + a role scoped to it |
| `UPLOAD_DIR` (`.env.example:48`) | `/var/lib/hitt-ops/uploads` | `/srv/ops/<slug>/uploads` |
| `AAD_TENANT_ID` / `AAD_CLIENT_ID` / `AAD_*` | Entra | → replaced by `OIDC_ISSUER=https://auth.theaumol.com` + `OIDC_AUDIENCE` (issue 0A, `server/lib/entraToken.js`) |
| `GRAPH_*` (OneDrive project folders) | Entra daemon app | per instance **iff** the customer wants OneDrive folders; `graph.js:41` already fails silently when unset |
| `GRAPH_MAIL_*` / `SMTP_*` (invoice email) | HITT / IONOS mailboxes | per instance — see §3 |
| `AZURE_OPENAI_*` (chat assistant) | Azure OpenAI | per instance or shared key; `chatLlm.js:25` gates on it |

---

## 3 · Real code smell — invoice mail routing keyed off the entity **name**

`server/routes/invoicing.js`:

- `453-454` — `INVOICE_SENDER_HITT = "invoices@hittbcn.com"`, `INVOICE_SENDER_FHITT = "invoices@fhitt.org"`
- `457-459` — `senderFor(key)` switches on `key === "fhitt" | "hitt" | "hitt/osm"`
- `462-467` — `transportFor()` returns `key === "fhitt" ? "smtp" : "graph"` — **transport chosen by the entity's display name**
- `473-474` — error strings naming "FHiTT" / "HiTT"
- `483, 528` — `Entity: data.entityLabel || "HITT"` fallback

`server/lib/invoicePdf.js`:

- `35-51` — `HITT_LETTERHEAD` hardcoded (`invoices@hittbcn.com`, `www.hittbcn.com`), `ENTITY_LETTERHEAD` map keyed `HiTT` / `FHiTT` / `HiTT/OSM`, all pointing at the same block
- `102` — falls back to `HITT_LETTERHEAD` when the DB entity row has no letterhead
- `24, 151-160` — `HITT-logo-invoices.png` + a literal `"HITT"` text mark fallback

`public/js/reports.js`:

- `420, 424` — `ENTITY_COLORS` and `ENTITY_ORDER = ["HiTT","FHiTT","HiTT/OSM","Unassigned"]` hardcoded in the frontend

**Fix direction:** the `entity` table already carries `legalname / vatnumber / address /
emailinvoicing / webpage / logo` (added 2026-08). Add `mailtransport` (`graph` | `smtp`)
and `mailsender` columns; drive `transportFor` / `senderFor` off the row, not the name.
Delete the `HITT_LETTERHEAD` hardcoded fallback — use the entity row, and a neutral
text mark when a field is blank. `reports.js` should pull entity order/colours from the
entities API.

---

## 4 · Product branding baked into the HTML shell

- `public/index.html:158` `assets/fhitt-logo.png` (login logo), `:216 / :228` placeholder `name.surname@fhitt.org`, `:251` footer `© HITT · fhitt.org`
- Every `public/pages/*.html` header: `<img src="…/fhitt-logo.png"> HITT<span>·</span>Ops`
- `public/pages/settings.html:237, :349`, `public/js/settings.js:1021` `DEFAULT_LOGO_SRC = "../assets/fhitt-logo.png"`

`public/js/branding.js` **already** fetches `/api/branding/logo` from the DB (appconfig
`branding.logo`), so the logo is overridable per instance via Settings today. What's
still hardcoded: the fallback asset, the `HITT·Ops` wordmark, the `fhitt.org` footer,
and the email placeholders.

**Fix:** neutral wordmark ("Ops"), generic fallback logo, drop / make-configurable the
footer, generic email placeholders (`name@company.com`).

---

## 5 · `public.` schema qualifiers — leave as-is ✔

`lib/audit.js` (×6), `db/schema-changes.sql`, `routes/branding.js:34`,
`routes/settings.js:56-59`, `routes/audit.js:12`.

Under **one database per customer** every instance has its own `public` schema, so
these are correct and need no change. (They would only be a problem under the
schema-per-tenant model, which we rejected.) **Check the box** with this note.

---

## 6 · Region/locale hardcoding — not 0B-blocking, note for later

- `server/routes/settings.js:46` `CATALONIA_HOLIDAYS_URL` — Generalitat de Catalunya
  open-data feed. A customer outside Catalonia can't use the holiday **import** (manual
  entry still works). Later: configurable feed URL / country picker per instance.
- `settings.js:80` path placeholder `/HITT Shared/HR/Employees`
- `lib/invoicePdf.js:254` Spanish VAT-exemption legal text (Law 37/1992) — already a
  localised string; Spain-specific but harmless
- VAT rate 21% is baked into legacy Access data labels (`invoicePdf.js:131`), per-invoice

---

## 7 · Cosmetic naming — opportunistic, not required

`X-HITT-User` / `X-HITT-Client` headers, `req.hittUser`, `window.HITT_CONFIG`, package
name `hitt-ops-api`, `server.js` log lines. The `X-HITT-User` header is legacy dev-mode
auth and is ignored once on OIDC. Rename when convenient.

---

## 0B action list

1. **[done]** `public/js/config.example.js` added (template: `APP_NAME`, `API_BASE_URL`,
   `OIDC` block, `MSAL` block, feature flags). `config.js` gained `APP_NAME`
   and stays **tracked** for now — the move to a gitignored, per-instance
   `config.js` rendered by the provisioning script is deferred to 0D, so a
   `git pull` on HITT's VPS can't delete its live config.
2. **[done]** `server/.env.example` rewritten — single-origin `CORS_ALLOWED_ORIGINS`
   (no localhost/null), `[per-instance]` markers, `PGDATABASE=ops_CUSTOMER`,
   `UPLOAD_DIR=/srv/ops/CUSTOMER/uploads`, commented `OIDC_*` section, mail
   section generalised (no HiTT/FHiTT).
3. **[done]** `entity.mailtransport` + `entity.mailsender` columns
   (`entitySchema.js`, `schema-changes.sql`); `entities.js` CRUD; Settings →
   Entities → "Invoice email" UI (`settings.html`, `settings.js`, i18n ×3);
   `invoicing.js` `invoiceSenderFor` / `invoiceMailChannel` rewritten to read
   the entity row; `invoicePdf.js` `HITT_LETTERHEAD` / `ENTITY_LETTERHEAD` /
   bundled-logo fallback all removed — letterhead is now 100% from the entity
   record.
4. **[done]** HTML shell de-branded — neutral `assets/ops-mark.svg`,
   `.app-header__name` / `.login-brand__name` wordmark driven by
   `HITT_CONFIG.APP_NAME` via `branding.js`; `fhitt.org` footer + email
   placeholders + HITT-specific i18n strings (login, holidays, invoice mail,
   logo) neutralised in all 3 languages. `reports.js` `ENTITY_COLORS` /
   `ENTITY_ORDER` replaced with a palette + `entityDisplay(rows)` derived
   from the data.
5. **[done]** `public.` qualifiers — left as-is (correct under silo).
6. (later) configurable holiday feed — untouched.

### Follow-ups this created

- **HITT invoice letterhead:** PDFs now take the letterhead *only* from
  Settings → Entities (done — HITT's entities are filled in).
- **HITT invoice email:** transport is no longer inferred from the entity
  name. Set each entity's transport in Settings → Entities → "Invoice email"
  after deploy. FHiTT SMTP is pending its mailbox credentials — a FHiTT
  invoice email will fail until both are set (acceptable, tracked).
- **0D:** make `config.js` gitignored + per-instance, rendered by the
  provisioning script; migrate HITT with `git update-index --skip-worktree`.
- Cosmetic `HITT_CONFIG` / `HITT_I18N` / `X-HITT-User` identifiers left alone.
- New chat feature (`AZURE_OPENAI_*`) — decide shared vs per-instance key.
