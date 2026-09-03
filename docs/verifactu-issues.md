# Veri*Factu — GitHub issues

The delivery plan from [`verifactu-integration-roadmap.md`](verifactu-integration-roadmap.md)
(§8), as a set of GitHub issues for `alexaumol/Ops`.

**Model:** one milestone, six workstream issues (V0–V5), one tracking issue (J).
Each workstream issue carries a GitHub task list so sub-items render as checkboxes
with a progress bar; convert any line to its own issue later with one click.
Bulk-create them with [`scripts/create-verifactu-issues.sh`](../scripts/create-verifactu-issues.sh).

**Milestone:** `Veri*Factu: AEAT e-invoicing compliance`
**Labels used:** `verifactu`, `invoicing`, `compliance`, `legal`, `tracking`

**Dependency graph**

```
V0 ───────────────────────┐
                          │
V1 ──> V2 ──┬──> V3 ──────┼──> V5 ──> J
            └──> V4 ──────┘
```

`V0` (commercial + legal) blocks **go-live**, not development — `V1`/`V2` can proceed
in parallel with it. `V5` needs `V0`, `V3`, and `V4`.

---

## V0 · Commercial & legal groundwork

**Labels:** `verifactu`, `legal`, `compliance`
**Depends on:** — · **Blocks:** V5

No code. The provider relationship and the advisor sign-offs that everything downstream
assumes. See roadmap §1, §4, §9.

- [ ] Sign the BOLD production agreement; provide a POA / *justificante de alta* for **each** issuing NIF (HiTT, FHiTT, HiTT-OSM?)
- [ ] Confirm with BOLD: one API-Key per NIF vs one key for several; pricing per licence/NIF; DPA / GDPR terms + data-hosting location; record retention on their side + a **bulk** export (only `invoice_data/{id}` one-at-a-time today); SLA / maintenance windows; enable `error_code` / `error_text` / `aeat_registered` on `invoice_state` for our account
- [ ] Engage a tax advisor: which entities are in scope; is any entity in **SII** (which removes the Veri*Factu obligation); invoice types actually used (F1 only?); the VAT/operation + exemption mapping table (§4.4); the cancel-vs-rectify policy (§4.5); the exact QR/legend wording for the PDF (§4.6)
- [ ] Draft & publish **Ops' own *declaración responsable*** (with the advisor), at a stable URL
- [ ] Decide: auto-submit on issue vs manual "Send to AEAT"; behaviour when BOLD/AEAT is unreachable at issue time
- [ ] Confirm the real historic Access invoice-numbering rule with finance; agree per-entity prefixes + a cutover date (§4.1)

---

## V1 · Foundations

**Labels:** `verifactu`, `invoicing`
**Depends on:** — · **Blocks:** V2

Sandbox only, no user-visible change. Roadmap §5, §6, §4.1, §4.3, §4.4.

- [ ] `server/lib/verifactu/` — provider adapter (`bold.js`: `register` / `cancel` / `state` / `data`), payload mapping (`mapping.js`), error translation (`errors.js`), `getProvider(entity)` (§6)
- [ ] Schema top-ups (§5), runtime-idempotent + mirrored in `server/db/schema-changes.sql`: `verifactu_records`; `invoicesdetails.issued_at` / `issued_by`; `entity.verifactu_enabled` / `verifactu_api_key` / `invoice_series`; `taxcompanies.fiscalidtype`; `invoices_vattypes.verifactu_*`
- [ ] `FEATURE_VERIFACTU` flag through the server (`.env.example`) and `public/js/config.js` → `FEATURES.verifactu`
- [ ] Recipient fiscal-id typing (§4.3): `taxcompanies.fiscalidtype` + number normalisation (strip `ES`, uppercase); field on the BP → tax-company form
- [ ] VAT → Veri*Factu classification (§4.4): seed `invoices_vattypes.verifactu_*` defaults; admin editing UI
- [ ] **Per-entity invoice numbering** with prefixes (§4.1); finance sign-off; cutover plan
- [ ] Mapping test harness: real Ops invoice rows → BOLD **sandbox** (test NIF `B13674197`), covering F1, R1 (por diferencias), exempt, foreign recipient, multi-rate

---

## V2 · Issue flow

**Labels:** `verifactu`, `invoicing`
**Depends on:** V1 · **Blocks:** V3, V4

Roadmap §4.2, §4.7, §3.

- [ ] `draft` / `issued` lifecycle + `issued_at`; an explicit **"Issue invoice"** action in the invoice modal (§4.2)
- [ ] On issue: build payload → `POST /invoice` → persist a `verifactu_records` row (`queueId`, QR, URL, `chain_hash`, XML, state) → `logAudit({ kind: "verifactu.register" })`
- [ ] Block `PATCH` / `DELETE` on issued invoices at the API layer (409 + guidance) (§3)
- [ ] Failure UX: keep the invoice as draft/failed, surface the BOLD `message`, "Retry" (with `isFix: true` when the record already exists)
- [ ] Timezone hardening: `issuedTime` / `operationDate` pinned to `Europe/Madrid`, validated not-future and `>= 2024-07-01` before submit (§4.7)
- [ ] Send `Verify-Issuer-Id` (the entity NIF) on every call

---

## V3 · Cancel & rectify

**Labels:** `verifactu`, `invoicing`
**Depends on:** V2 · **Blocks:** V5

Roadmap §4.5.

- [ ] "Cancel invoice" → `POST /invoice_cancel(queueId)` → `status 6` + a cancellation `verifactu_records` row + `logAudit({ kind: "verifactu.cancel" })`
- [ ] Rectificativa → `type: R1` + `creditNote.style: "I"` + `creditNote.ids: [source]`; register as its own record
- [ ] Stop the silent source auto-cancel on corrective creation; make cancelling the source an explicit AEAT event per the advisor's policy
- [ ] Rejected-registration resend path (`isFix: true`)

---

## V4 · Visibility

**Labels:** `verifactu`, `invoicing`
**Depends on:** V2 · **Blocks:** V5

Roadmap §4.6, §2.

- [ ] Invoice PDF: QR image + verification URL + Veri*Factu legend, from the stored record (§4.6)
- [ ] Invoice list + detail: Veri*Factu state badge (`pending` / `sent` / `error`), error text, resubmit control
- [ ] "Refresh AEAT status" (manual) + optional background poll of `pending` records via `POST /invoice_state/{id}` — there are **no webhooks** (§2)
- [ ] Optional recipient NIF pre-check via `POST /id_check` in the invoice modal

---

## V5 · Settings tab + go-live

**Labels:** `verifactu`, `invoicing`, `compliance`
**Depends on:** V0, V3, V4 · **Blocks:** J

Roadmap §7, §8.

- [ ] Settings → **"Veri*Factu"** tab (admin-only, hidden unless `FEATURES.verifactu`): status panel, per-entity table, behaviour options (§7)
- [ ] `server/routes/verifactu.js` (admin-gated) + a write-only entity API-key field ("hasKey" only, never echoed) in `routes/entities.js`
- [ ] i18n keys ×3 (en / es / ca) in `public/js/i18n-dict.js`
- [ ] Full sandbox E2E; cross-check QRs against the AEAT sandbox validator (`prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR`)
- [ ] Switch one entity to a **production** API key; issue one real invoice; verify on the AEAT production validator
- [ ] Enable the remaining entities
- [ ] Update `docs/0B-config-inventory.md` + `server/.env.example` + deploy notes

---

## J · [Tracking] Veri*Factu live — the acceptance gate

**Labels:** `verifactu`, `tracking`
**Depends on:** V0, V1, V2, V3, V4, V5

Complete when every workstream issue is closed **and** the gate checks pass. Fill in the
issue numbers after creation.

- [ ] #V0 · Commercial & legal groundwork
- [ ] #V1 · Foundations
- [ ] #V2 · Issue flow
- [ ] #V3 · Cancel & rectify
- [ ] #V4 · Visibility
- [ ] #V5 · Settings tab + go-live
- [ ] Ops' *declaración responsable* is published at a stable URL
- [ ] BOLD production agreement signed; POA accepted for every issuing NIF
- [ ] Per-NIF gap-free numbering is live; cutover done; finance signed off
- [ ] A real invoice for each entity has been issued, registered, and confirmed `sent` on the AEAT validator
- [ ] A cancellation and a rectificativa have round-tripped against the AEAT
- [ ] Issued invoices are immutable in the UI and the API (edit / delete blocked)
- [ ] The invoice PDF shows the QR + legend; non-Spanish instances still hide the feature entirely
