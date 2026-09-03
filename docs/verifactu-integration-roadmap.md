# Veri*Factu integration — roadmap

Status: **draft / proposal · V1 in progress** · Owner: Alex · Target provider: **BOLD Software** (`apiverifactu.boldsoftware.es`)
Reference: [`docs/verifactu-boldsoftware-openapi.yaml`](verifactu-boldsoftware-openapi.yaml) (OpenAPI 3.1, v1.2.0, downloaded 2026-09-01)

### V0 decisions locked — 2026-09-03

- **API keys:** assume **one BOLD API-Key per issuing NIF** (conservative; BOLD asked, answer
  pending). Key lives on `entity.verifactu_api_key`, server-side only.
- **Auto-submit to AEAT:** **on by default, per invoice.** A checkbox in the invoice modal
  (checked) — unchecking it issues the invoice without registering, to be sent later.
  No global toggle.
- **When BOLD/AEAT is unreachable at issue time:** **never block issuing.** The AEAT developer
  FAQ is explicit — invoicing continues, the record is queued and re-sent periodically until it
  goes through (BOLD sets the *Incidencia* flag on the delayed submission; there is no maximum
  deadline during an incident). So: the invoice is issued and locked, its `verifactu_records`
  row stays `pending`, a background job retries. Applies equally to a `503` from BOLD and a
  network error. See [AEAT FAQ – Sistemas VERI\*FACTU](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/sistemas-verifactu.html)
  and the [developer FAQ PDF](https://sede.agenciatributaria.gob.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/FAQs-Desarrolladores.pdf).
- **Invoice numbering:** confirmed changeable to per-NIF gap-free series with a visible prefix.

---

## 1 · Goal and approach

Make Ops-issued invoices compliant with the Spanish *Reglamento de sistemas informáticos de
facturación* (RD 1007/2023 + Orden HAC/1177/2024 — "Veri\*Factu" / Ley Antifraude) **without
turning Ops itself into a certified SIF**.

We do this with a **mixed architecture**: Ops stays the billing application; BOLD's API is the
SIF component that does hash-chaining, record XML, digital signature, QR generation and
submission to the AEAT under BOLD's own representation certificate. Ops sends invoice data as
JSON and stores what comes back.

### What BOLD handles

- Chained hash (`RegistroAlta`), record XML, timestamp, immutability
- QR code (`data:image/png` URL) + AEAT verification URL
- Transmission to the AEAT (`vf1.boldsoftware.es` → AEAT), in **Veri\*Factu mode** — so there
  is **no obligation for Ops to retain the records** (the AEAT already has them; we keep copies
  anyway as insurance)
- Cancellations (`anulaciones`), corrections (`subsanaciones`), state queries
- Keeping the record format current as the spec evolves

### What Ops still owns  (does **not** disappear by using a provider)

1. **Its own *declaración responsable*.** In a mixed architecture *both* parties self-declare.
   BOLD declares for its component; Ops must publish a declaration covering the part it
   controls: correct and complete invoice capture, no hidden/duplicated invoices, no
   dual-use ("doble uso") software, correct field population, an event trail. **Draft this
   with a tax advisor before go-live.** (Carries the software-producer liability regime —
   up to €50k per financial year for a non-compliant system.)
2. **Correct, gap-free invoice numbering per issuer NIF** (see §4.1 — today's pooled sequence
   is not compliant).
3. **Locking issued invoices** so they can't be silently edited or deleted (see §4.2).
4. **Correct VAT / operation classification** on every line (see §4.4).
5. Showing the QR + Veri\*Factu legend on the invoice PDF (§4.6).

---

## 2 · BOLD API summary (what we integrate against)

| Item | Value |
|---|---|
| Base URL | `https://vf1.boldsoftware.es/v1` |
| Auth | header `API-Key: <key>`; optional `Verify-Issuer-Id: <NIF>` — rejects the call (`000007`) if the key's company NIF doesn't match. **Send this on every call** as a guard. |
| Sandbox vs production | Separate by **API-Key**. Sandbox key issued on signup (we have one — assigned company *EMPRESA DE PRUEBAS (PI4)*; sandbox auto-prefixes every invoice number with `PI4-`). Production needs a signed agreement + POA ("justificante de alta") — until then calls fail `953444`. |
| Error convention | **Everything is HTTP 400** with `{code, message, requestId}`. No 401/403/500. `503` (+ `ServiceUnavailableError`) only for maintenance / DB issues. Malformed JSON on `/invoice_cancel` returns a different shape (`{error:"invalid_json"}`). |
| Webhooks | **None.** AEAT acceptance is discovered by polling `POST /invoice_state/{id}`. |
| Company / NIF scope | One API-Key ↔ one company (NIF). **Multiple billing entities almost certainly need one key each** — confirm with BOLD. |

### Endpoints

| Method / path | Purpose | Notes |
|---|---|---|
| `POST /invoice` | Register (alta) an invoice | Body `{ invoice: {...} }`. Returns `DatosVerifactu`: `qrcode`, `verifactuUrl`, `chainInfo` (previous record + hash), `verifactuXml` (base64), **`queueId`** (persist this — it's the handle for everything else), `requestId`. |
| `POST /invoice_cancel` | Cancel (anulación) an invoice | Body is the **bare `queueId` as JSON text** (e.g. `44`, not an object; no leading zeros). Response has **no `qrcode`**. |
| `POST /invoice_state/{id}` | AEAT processing state | `id` = `queueId`. Returns `state`: `pending` \| `sent` \| `error`. `error_code` / `error_text` / `aeat_registered` only present "for certain accounts" — **ask BOLD to enable these for ours**. |
| `POST /invoice_data/{id}` | Re-fetch the original `DatosVerifactu` | Recovery if we failed to persist the create response. Does **not** report AEAT state. |
| `POST /id_check` | Contrast a Spanish NIF + name against the AEAT | Optional pre-flight before issuing (avoids `397430` "recipient not identifiable"). |

### `invoice` request shape (the fields we must produce)

```
invoice:
  recipient:            # omit only for simplified (F2). One of:
    # Spanish NIF form:
    irsId: "B13674197"
    name:  "Client SL"
    country: ES         # optional here
    # Foreign / non-NIF form:
    id: "IT00470550013"
    idType: "02"        # 02 VAT-intracom, 03 passport, 04 official doc, 05 residence cert, 06 other, 07 census-NIF
    name: "..."
    country: IT
  id:
    number: "2026-014"  # our invoice code — string; unique per (issuer NIF, normalised number, year)
    issuedTime: "2026-09-01"    # date; must be >= 2024-07-01, not future, not > 20y old
  description:
    text: "..."         # non-empty (561100). Use the service description.
    operationDate: "2026-09-01"
  type: F1              # F1 full · F2 simplified · F3 replaces tickets · R1..R4 rectificativa · R5 rectif. of simplified
  vatLines:             # >= 1
    - base: 100
      rate: 21          # IVA: only 0, 4, 5, 10, 21
      amount: 21
      vatOperation: S1  # S1 subject+not-exempt · S2 reverse charge · N1/N2 not-subject · E1..E6 exempt
      vatKey: "01"      # régimen: 01 general, 02 export, 03 REBU, ... (see enum)
      rate2 / amount2:  # equivalence surcharge (recargo), optional
  amount: 21            # total VAT — validated ±1 vs sum(vatLines); AEAT value is recomputed from vatLines
  total: 121            # invoice total — same validation
  creditNote:           # only for R1..R5
    style: I            # I = por diferencias · S = sustitutiva (then creditBase + creditVat required)
    ids: [ { number, issuedTime } ]   # the invoice(s) being corrected
  replacedTicketIds:    # only for F3
  isFix: true           # re-send a rejected registration under the same key without "duplicate" error
```

---

## 3 · Where this plugs into Ops today

| Ops concept | File | Relevance |
|---|---|---|
| Invoice create (regular + corrective) | [`server/routes/invoicing.js:662`](../server/routes/invoicing.js) `POST /projects/:projectId/invoices` | The **issue point**. Corrective auto-cancels its source (`status 6`) — this becomes an AEAT event. |
| Invoice edit | `invoicing.js:748` `PATCH /invoices/:id` | Must be **blocked once registered**. |
| Invoice delete | `invoicing.js:823` `DELETE /invoices/:id` | Must be **blocked once registered** (cancel instead). |
| Numbering | `invoicing.js:685` | `${year}-${seq}` pooled across entities + separate corrective sequence — **not per-NIF** (§4.1). |
| Status model | `set_new_invoice_status()`, ids 1–6 (6 = cancelled) | Date-derived; no "draft vs issued" distinction (§4.2). |
| Issuing entity + its NIF | `entity.vatnumber` ([`server/lib/entitySchema.js`](../server/lib/entitySchema.js)) | Becomes `Verify-Issuer-Id` and the API-Key selector. |
| Recipient fiscal data | `taxcompanies.vatnumber` + `taxcompaniesaddresses` + `countries` (joined in `loadInvoiceForPdf`) | Becomes `recipient`. Needs a NIF-vs-foreign-doc distinction + `idType` (§4.3). |
| VAT | `invoicesdetails.vatid` → `invoices_vattypes.percentage`, single rate/line per invoice; exemption = rate 0 + Art 20.1.9º Law 37/1992 text (`invoicePdf.js:213`) | Becomes one `vatLine`; needs `vatOperation` / `vatKey` mapping (§4.4). |
| Invoice PDF | [`server/lib/invoicePdf.js`](../server/lib/invoicePdf.js) (pdfkit) | Add QR + verification URL + Veri\*Factu legend (§4.6). |
| Audit | [`server/lib/audit.js`](../server/lib/audit.js) `logAudit({kind})` | New kinds `verifactu.register` / `.cancel` / `.rectify` / `.error`. |
| Per-deployment config | [`docs/0B-config-inventory.md`](0B-config-inventory.md), `server/.env.example`, `public/js/config.js` `FEATURES` | Gate the whole feature behind a flag; API keys are per-deployment secrets. |

---

## 4 · Gap analysis — what must change before we can register a single invoice

### 4.1 Per-NIF invoice series  *(blocker)*

Veri\*Factu keys a record on **issuer NIF + normalised number + year**. Ops currently pools
HITT / HiTT-OSM / FHiTT into one yearly sequence (`invoicing.js:29-35` flags this as an
unverified simplification). Two entities issuing `2026-014` in the same year is a hard
conflict (`B113047`).

**Fix:** give every entity its own gap-free sequence and (recommended) its own visible prefix,
e.g. `HITT-2026-014` / `FH-2026-014`. Migration: freeze current numbering at a cutover date,
start per-entity sequences after it. **Confirm the historic Access rule with finance first.**

### 4.2 Draft vs issued  *(blocker)*

Today an invoice is fully mutable after creation and only "sent" later by email. Veri\*Factu
needs the record submitted **at issuance** and immutable thereafter.

**Fix:** add an explicit lifecycle step.
- `draft` — editable, not registered, not a legal invoice yet (no fiscal number, or a clearly
  provisional one).
- **"Issue"** action → assigns the definitive number, registers with BOLD, locks the row.
- `issued` — `PATCH`/`DELETE` return 409; the only mutations are **Cancel** and **Rectify**.

### 4.3 Recipient fiscal identification

`recipient` needs either `{irsId,name}` (Spanish NIF/NIE/CIF) or `{id,idType,name,country}`
(foreign / passport / etc.). Ops stores a single `taxcompanies.vatnumber` string with no
type flag, sometimes `ES`-prefixed.

**Fix:** on `taxcompanies`, add `fiscalidtype` (`nif` \| `02` \| `03` \| `04` \| `05` \| `06` \|
`07`) and normalise the number (strip `ES`, uppercase). Default `nif` when `country = ES`.
Surface on the BP → tax-company form. Optionally pre-validate with `/id_check`.

### 4.4 VAT / operation mapping

One Ops invoice = one rate today. BOLD wants `vatLines[]` with `vatOperation` + `vatKey`.

**Fix:** extend `invoices_vattypes` with `verifactu_vatoperation` (`S1`/`S2`/`N1`/`N2`/`E1..E6`),
`verifactu_vatkey` (default `01`), and `verifactu_exemption_note`. Seed defaults; let an admin
adjust them in Settings → Categories (or the new tab). Build one `vatLine` per invoice from the
invoice's VAT type + net amount. **Settled (2026-09-03):** taxed → `S1`/`01`, 0% → `E1`
(Art. 20 Ley 37/1992) — no advisor sign-off needed. Exports, intra-community supplies and
reverse charge get their own `vatOperation`/`vatKey` per case when those actually arise.

### 4.5 Corrective / cancellation semantics

- Ops "corrective invoice" (`iscorrective` + `sourceInvoiceId`) → BOLD `type: R1`,
  `creditNote.style: "I"`, `creditNote.ids: [{number, issuedTime of source}]`. Register it as
  its own record.
- Ops currently *also* silently sets the source to `status 6`. Once we're on Veri\*Factu,
  cancelling the source is a **separate AEAT event** (`POST /invoice_cancel` with the source's
  `queueId`) — do it explicitly, or don't cancel it at all if the rectificativa "por
  diferencias" leaves it valid. Decide the policy with the advisor.
- Rejected registration → resend with `isFix: true`.

### 4.6 Invoice PDF

Add, from the stored `DatosVerifactu`:
- the QR image (`qrcode` data URL — pdfkit takes PNG),
- the verification URL text,
- the legend: *"Factura verificable en la sede electrónica de la AEAT o en la app 'Comprueba' — VERI\*FACTU"* (exact wording per the Orden; confirm).

### 4.7 Time / timezone

`issuedTime` must not be in the future and not predate `2024-07-01`. Pin submission timestamps
to `Europe/Madrid`; guard against a server in UTC pushing an evening invoice to "tomorrow".

---

## 5 · Data model changes

Since this roadmap was drafted the repo adopted **node-pg-migrate** (Phase 0C), so schema
changes are now ordered SQL migrations under `server/migrations/`, created with
`npm run migrate:create` — **not** runtime `ensure*Schema()` + `schema-changes.sql`. V1 ships
[`server/migrations/1788448547623_verifactu-foundations.sql`](../server/migrations/1788448547623_verifactu-foundations.sql)
with the columns below (plus `invoicesdetails.verifactu_autosubmit` for the per-invoice
checkbox, and `entity.verifactu_environment`):

```sql
-- per-invoice Veri*Factu record (1:1 with an issued invoice; a cancellation adds a 2nd row)
CREATE TABLE IF NOT EXISTS verifactu_records (
  id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  invoiceid      bigint NOT NULL,
  kind           varchar(12) NOT NULL DEFAULT 'alta',   -- 'alta' | 'anulacion'
  provider       varchar(24) NOT NULL DEFAULT 'bold',
  environment    varchar(12) NOT NULL,                  -- 'sandbox' | 'production'
  queue_id       varchar(64),                           -- BOLD queueId
  request_id     varchar(64),
  aeat_state     varchar(12) NOT NULL DEFAULT 'pending',-- pending | sent | error
  error_code     varchar(32),
  error_text     text,
  qr_png         text,                                  -- data URL
  verify_url     text,
  chain_hash     varchar(128),
  record_xml     text,                                  -- base64; kept as insurance
  submitted_at   timestamptz,
  state_checked_at timestamptz,
  submitted_by   bigint
);
CREATE INDEX IF NOT EXISTS verifactu_records_invoiceid_idx ON verifactu_records (invoiceid);

-- invoice lifecycle lock
ALTER TABLE invoicesdetails ADD COLUMN IF NOT EXISTS issued_at   timestamptz;
ALTER TABLE invoicesdetails ADD COLUMN IF NOT EXISTS issued_by   bigint;
-- (draft = issued_at IS NULL)

-- per-entity Veri*Factu config + secret (never returned to the frontend; expose only "hasKey")
ALTER TABLE entity ADD COLUMN IF NOT EXISTS verifactu_enabled  boolean NOT NULL DEFAULT false;
ALTER TABLE entity ADD COLUMN IF NOT EXISTS verifactu_api_key  text;      -- server-only
ALTER TABLE entity ADD COLUMN IF NOT EXISTS invoice_series     varchar(16); -- prefix, e.g. 'HITT'

-- recipient fiscal id type
ALTER TABLE taxcompanies ADD COLUMN IF NOT EXISTS fiscalidtype varchar(4); -- NULL => infer 'nif' when ES

-- VAT-type → Veri*Factu classification
ALTER TABLE invoices_vattypes ADD COLUMN IF NOT EXISTS verifactu_vatoperation varchar(4);
ALTER TABLE invoices_vattypes ADD COLUMN IF NOT EXISTS verifactu_vatkey       varchar(4) DEFAULT '01';
ALTER TABLE invoices_vattypes ADD COLUMN IF NOT EXISTS verifactu_exemption_note text;
```

Per-deployment (`server/.env.example`):

```
# [per-instance] Veri*Factu (Spain). Leave FEATURE off for non-Spanish customers.
FEATURE_VERIFACTU=false
VERIFACTU_PROVIDER=bold
VERIFACTU_ENV=sandbox                     # sandbox | production
VERIFACTU_BASE_URL=https://vf1.boldsoftware.es/v1
# API keys are per issuing entity — stored on entity.verifactu_api_key via Settings,
# NOT here. This file only carries provider/env/URL + the feature flag.
```

`public/js/config.js` → `FEATURES.verifactu` mirrors `FEATURE_VERIFACTU` so the frontend can
hide the tab and the "Issue" button on non-Spanish instances.

---

## 6 · Provider abstraction

```
server/lib/verifactu/
  index.js      # getProvider(entity) -> adapter; buildAltaPayload(invoice) -> {invoice:{…}}
  bold.js       # register(payload,{apiKey,issuerNif}) / cancel(queueId,…) / state(id,…) / data(id,…)
  mapping.js    # Ops invoice row  ->  BOLD `invoice` object (type, recipient, vatLines, totals)
  errors.js     # BOLD `{code,message}` -> typed error + user-facing message (ES)
```

Rationale: BOLD is a young company (founded 2025). Everything they return that has compliance
value (`queueId`, QR, URL, `chain_hash`, `record_xml`) is persisted in `verifactu_records`, so
a provider switch is an adapter swap plus continuing the hash chain — not a rebuild, and not a
compliance gap.

---

## 7 · Settings → new "Veri\*Factu" tab

New tab in [`public/pages/settings.html`](../public/pages/settings.html) /
[`public/js/settings.js`](../public/js/settings.js), admin-only, **hidden unless
`FEATURES.verifactu`**. Backed by a new `server/routes/verifactu.js` (admin-gated) +
additions to `server/routes/entities.js`. i18n keys in all three languages
([`public/js/i18n-dict.js`](../public/js/i18n-dict.js)).

**Status panel (read-only)**
- Provider, environment (sandbox / **production**), per-entity "API key configured ✓/✗"
- License / POA state — inferred from a cheap probe call (`953443` / `953444` → warn)
- Link to Ops' *declaración responsable* (configurable text/URL via `appconfig`)
- Link to BOLD's *declaración responsable* + support contact

**Per entity (table)**
- Veri\*Factu enabled — toggle
- NIF (from `entity.vatnumber`, shown + syntactically validated)
- Invoice series prefix (`invoice_series`)
- Set / replace API key (write-only field; never echoed back)
- Last submission result / count pending / count errored

**Behaviour options (per deployment, `appconfig`)**
| Option | Default | Notes |
|---|---|---|
| Register automatically when an invoice is issued | **on** | this is the **per-invoice** default (checkbox in the invoice modal, checked); no global override needed |
| If BOLD/AEAT is unreachable at issue time | **issue anyway + queue** | not configurable — the AEAT requires issuing to continue; the record retries in the background (V0 decision, 2026-09-03) |
| Show QR + Veri\*Factu legend on invoice PDFs | **on** | warn if turned off |
| Pre-check recipient NIF via `/id_check` before issuing | off | |
| Background status-poll interval | 30 min | polls `pending` records via `/invoice_state` |

**Log** — link into Settings → Auditing filtered to `kind LIKE 'verifactu.%'`.

Secrets policy: the API key lives in `entity.verifactu_api_key` (server-only, like the entity
logo is gated); the tab shows only presence, never the value — consistent with how Graph/SMTP
credentials are treated.

---

## 8 · Phased delivery

### Phase V0 — Commercial & legal groundwork  *(no code; blocks production only)*
- [ ] Sign BOLD production agreement; provide POA / *justificante de alta* for **each** issuing
      NIF (HiTT, FHiTT, HiTT-OSM?). Confirm: one API-Key per NIF; pricing per licence/NIF; DPA
      / GDPR terms + hosting location; data retention + **bulk export** of records; SLA /
      maintenance windows; enabling the `invoice_state` error fields for our account.
- [ ] Engage a tax advisor: scope (which entities; are any in **SII** → then Veri\*Factu not
      required); invoice types in use (F1 only?); VAT/operation & exemption mapping table;
      cancel-vs-rectify policy; exact PDF legend wording.
- [ ] Draft & publish **Ops' *declaración responsable***.
- [x] Decide auto-submit vs manual; unreachable-at-issue behaviour — see *V0 decisions locked* above.

### Phase V1 — Foundations  *(sandbox only, no user-visible change)*
- [x] `server/lib/verifactu/*` — `bold.js` adapter, `mapping.js` payload transform, `errors.js`
      translation, `index.js` feature gate + per-entity config
- [x] Schema migration `1788448547623_verifactu-foundations.sql`; `FEATURE_VERIFACTU` +
      `FEATURES.verifactu` flags wired through `.env.example` / `config.example.js`
- [x] `taxcompanies.fiscalidtype`, `invoices_vattypes.verifactu_*` columns + seed defaults *(the
      BP/Settings **UI** for editing them is V1-follow-up / folded into V5)*
- [x] Mapping test suite (`npm run verifactu:test`, 17 cases: F1, R1 por diferencias, exempt,
      foreign recipient, derived VAT, date/rate guards) + a sandbox smoke script
      (`npm run verifactu:smoke`)
- [ ] Decide + implement **per-entity numbering** with prefixes; finance sign-off; cutover plan
      *(carried into V2 — it touches the issue path)*

### Phase V2 — Issue flow

**V2a — backend** (`server/lib/verifactu/issue.js`, migration `1788449400114_verifactu-issue-flow.sql`):
- [x] `draft` / `issued` lifecycle — `issued_at`; `POST /api/invoicing/invoices/:id/issue`
- [x] On issue: assign the fiscal number, lock, then (feature + entity on, autosubmit true)
      build payload → `POST /invoice` → persist `verifactu_records` → audit
- [x] Block `PATCH` / `DELETE` on issued invoices (409 `invoice_issued` + guidance)
- [x] Failure UX (API): local `buildAltaPayload` validation keeps a bad invoice a **draft**
      (422); a BOLD outage issues anyway with a `pending` record; a hard BOLD rejection issues
      with an `error` record + message. `POST /invoices/:id/verifactu/retry` (isFix).
- [x] Timezone hardening — `issuedDate` / `operationDate` via `Intl` pinned to `Europe/Madrid`
- [x] **Per-entity numbering** — `invoices.entityid` + `entity.invoice_series` prefix (e.g.
      `HITT-2026-014`), gap-free per (entity, year, corrective). Legacy pooled numbering is
      unchanged for an entity with no series set. *(Finance sign-off on the prefixes + cutover
      date still pending — V0.)*

**V2b — frontend** (`public/js/invoicing.js` / `invoicing.html` / `invoicing.css` / i18n ×3),
gated on `FEATURES.verifactu`:
- [x] Project invoice list — Veri*Factu chip on issued rows (sent / pending / error), "Issue"
      button on drafts, "Retry AEAT" on errored, delete hidden once issued
- [x] Invoice modal — draft: "Issue invoice" + auto-submit checkbox; issued: form locked,
      Save/Delete hidden, a status box (AEAT state, queueId, verify link, error + retry)
- [x] `GET /projects/:id/invoices/verifactu` (bulk state) + `issuedAt`/`autosubmit` on the
      per-invoice endpoint; both tolerate an un-migrated DB
- [ ] The cross-project "Invoice view" list still has no chip — folded into **V4** (needs an
      all-invoices state endpoint); the modal there already shows full state

> VAT-exemption classification (0% → `E1`) is **settled — no advisor sign-off needed**
> (confirmed 2026-09-03). Exports / reverse charge / intra-community still get their code
> per case (roadmap §4.4).

### Phase V3 — Cancel & rectify
- [x] "Cancel invoice" — `POST /api/invoicing/invoices/:id/cancel` → `issue.js` `cancelInvoice`:
      status → 6, and (feature + registered) `POST /invoice_cancel(queueId)` → `anulacion`
      `verifactu_records` row + audit. An outage queues it; a genuine AEAT rejection (not
      "already cancelled") blocks the cancel and is surfaced. UI: "Cancel invoice" button on an
      issued invoice + a "Cancelled at the AEAT" / "cancel pending" chip.
- [x] Rectificativa — `type R1` + `creditNote` was already produced by V2a's `toOpsInvoice`;
      V3 stops the **silent source auto-cancel** when the source is an issued Veri\*Factu
      invoice (a rectificativa "por diferencias" leaves the original valid). Legacy / draft /
      non-Veri\*Factu path unchanged.
- [x] Rejected-registration → `isFix: true` resend (`retryRecord`, from V2a; V3 extends it to
      also retry a queued/failed `anulacion`).

### Phase V4 — Visibility
- [ ] Invoice PDF: QR + verification URL + legend (from stored record)
- [ ] Invoice list + detail: Veri\*Factu state badge (pending / sent / error), error text, resubmit
- [ ] "Refresh AEAT status" (manual) + optional interval poll of `pending` via `/invoice_state`
- [ ] Optional `/id_check` pre-flight in the invoice modal

### Phase V5 — Settings tab + go-live
- [ ] Settings → Veri\*Factu tab (§7) + `server/routes/verifactu.js` + entity API-key field + i18n ×3
- [ ] Full sandbox E2E; cross-check QRs against the AEAT sandbox validator
      (`prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR`)
- [ ] Switch one entity to a production key; issue one real invoice; verify on the AEAT prod
      validator; then enable the rest
- [ ] Update [`docs/0B-config-inventory.md`](0B-config-inventory.md) + `.env.example` + deploy notes

---

## 9 · Open questions

**For BOLD**
1. One API-Key per NIF, or can one key serve several issuing NIFs?
2. Record retention on their side + a **bulk** export (only `invoice_data/{id}` one-at-a-time today)?
3. Rate limits / expected throughput; behaviour + our retry policy on `503`.
4. Enable `error_code` / `error_text` / `aeat_registered` on `invoice_state` for our account.
5. Production onboarding checklist & POA format; typical time to activate.
6. Is `issuedBy.type: "T"` (self-billing by third parties) going to be needed by us? (currently disabled server-side)
7. Status page / maintenance-window notifications?

**For the tax advisor**
1. Are any of our entities in SII (which removes the Veri\*Factu obligation)?
2. VAT/operation + exemption mapping table (§4.4) — sign-off.
3. Cancel-vs-rectify policy (§4.5); does a rectificativa "por diferencias" leave the original valid?
4. Exact required QR/legend wording on the PDF.
5. Our *declaración responsable* wording.

**For finance**
1. The real historic Access numbering rule; acceptable per-entity prefixes; cutover date.

---

## 10 · Risks

| Risk | Mitigation |
|---|---|
| BOLD is a 2025 startup; vendor risk / lock-in | Provider abstraction (§6); persist `queueId` + QR + URL + `chain_hash` + `record_xml` for every record so we can migrate and evidence compliance independently |
| Non-compliant pooled numbering ships to production | Per-NIF series is a **Phase V1 blocker**, finance sign-off required |
| Invoices edited/deleted after registration | Lifecycle lock (§4.2), API-layer 409s |
| Wrong VAT/operation codes → AEAT rejections | Advisor-signed mapping table; sandbox test matrix; surface `error_text` per invoice |
| No webhooks → stale "pending" state | Manual refresh + interval poll; badge makes stale state visible |
| "Immediatez" expectation | Long-lived drafts are fine; once **issued**, submit synchronously (or queue+retry within minutes) |
| Server clock / TZ pushes `issuedTime` to the future | Pin to `Europe/Madrid`; validate before submit |
| Multi-customer: feature leaks to non-Spanish instances | `FEATURE_VERIFACTU` gates server + UI; default off |
