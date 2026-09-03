#!/usr/bin/env bash
#
# Create the Veri*Factu milestone, labels, and issues on GitHub.
# Requires the GitHub CLI (https://cli.github.com) authenticated with repo scope:
#     gh auth login
#
# Idempotent-ish: label / milestone creation failures (already exist) are ignored.
# Issues are NOT deduplicated — run this once. Re-running creates duplicates.
#
# Usage:
#     ./scripts/create-verifactu-issues.sh [owner/repo]
# Defaults to alexaumol/Ops.
#
# Plan: docs/verifactu-issues.md  (from docs/verifactu-integration-roadmap.md §8)

set -euo pipefail

REPO="${1:-alexaumol/Ops}"
MILESTONE="Veri*Factu: AEAT e-invoicing compliance"

echo "Repo:      $REPO"
echo "Milestone: $MILESTONE"
echo

# --- labels -------------------------------------------------------------------
create_label () {
  gh label create "$1" --repo "$REPO" --color "$2" --description "$3" 2>/dev/null \
    && echo "  + label $1" \
    || echo "  . label $1 (exists)"
}
echo "Labels:"
create_label verifactu  b60205 "Spain Veri*Factu / AEAT e-invoicing compliance"
create_label invoicing  0052cc "Invoicing module"
create_label compliance 5319e7 "Regulatory compliance"
create_label legal      c5def5 "GDPR, contracts, pricing"
create_label tracking   ededed "Umbrella / tracking issue"
echo

# --- milestone --------------------------------------------------------------
echo "Milestone:"
gh api "repos/$REPO/milestones" -f title="$MILESTONE" \
  -f description="Make Ops-issued invoices compliant with RD 1007/2023 (Veri*Factu) via BOLD Software's API as the SIF, without certifying Ops itself. Plan: docs/verifactu-issues.md" \
  >/dev/null 2>&1 && echo "  + $MILESTONE" || echo "  . $MILESTONE (exists)"
echo

# --- issues ----------------------------------------------------------------
new_issue () {
  local title="$1" labels="$2" body="$3"
  local url
  url=$(gh issue create --repo "$REPO" --title "$title" --label "$labels" \
        --milestone "$MILESTONE" --body "$body")
  echo "  + $url  $title"
}

echo "Issues:"

new_issue "Veri*Factu V0 — Commercial & legal groundwork" \
  "verifactu,legal,compliance" \
"$(cat <<'EOF'
No code. The provider relationship and advisor sign-offs that everything downstream assumes. See `docs/verifactu-integration-roadmap.md` §1, §4, §9.

**Depends on:** — — **Blocks:** V5

- [ ] Sign the BOLD production agreement; provide a POA / *justificante de alta* for **each** issuing NIF (HiTT, FHiTT, HiTT-OSM?)
- [ ] Confirm with BOLD: one API-Key per NIF vs one key for several; pricing per licence/NIF; DPA / GDPR terms + data-hosting location; record retention + a **bulk** export (only `invoice_data/{id}` one-at-a-time today); SLA / maintenance windows; enable `error_code` / `error_text` / `aeat_registered` on `invoice_state` for our account
- [ ] Engage a tax advisor: which entities are in scope; is any entity in **SII** (removes the obligation); invoice types actually used (F1 only?); the VAT/operation + exemption mapping table (§4.4); the cancel-vs-rectify policy (§4.5); the exact QR/legend wording for the PDF (§4.6)
- [ ] Draft & publish **Ops' own *declaración responsable*** (with the advisor), at a stable URL
- [ ] Decide: auto-submit on issue vs manual "Send to AEAT"; behaviour when BOLD/AEAT is unreachable at issue time
- [ ] Confirm the real historic Access invoice-numbering rule with finance; agree per-entity prefixes + a cutover date (§4.1)
EOF
)"

new_issue "Veri*Factu V1 — Foundations" \
  "verifactu,invoicing" \
"$(cat <<'EOF'
Sandbox only, no user-visible change. See `docs/verifactu-integration-roadmap.md` §5, §6, §4.1, §4.3, §4.4.

**Depends on:** — — **Blocks:** V2

- [ ] `server/lib/verifactu/` — provider adapter (`bold.js`: `register` / `cancel` / `state` / `data`), payload mapping (`mapping.js`), error translation (`errors.js`), `getProvider(entity)` (§6)
- [ ] Schema top-ups (§5), runtime-idempotent + mirrored in `server/db/schema-changes.sql`: `verifactu_records`; `invoicesdetails.issued_at` / `issued_by`; `entity.verifactu_enabled` / `verifactu_api_key` / `invoice_series`; `taxcompanies.fiscalidtype`; `invoices_vattypes.verifactu_*`
- [ ] `FEATURE_VERIFACTU` flag through the server (`.env.example`) and `public/js/config.js` -> `FEATURES.verifactu`
- [ ] Recipient fiscal-id typing (§4.3): `taxcompanies.fiscalidtype` + number normalisation (strip `ES`, uppercase); field on the BP -> tax-company form
- [ ] VAT -> Veri*Factu classification (§4.4): seed `invoices_vattypes.verifactu_*` defaults; admin editing UI
- [ ] **Per-entity invoice numbering** with prefixes (§4.1); finance sign-off; cutover plan
- [ ] Mapping test harness: real Ops invoice rows -> BOLD **sandbox** (test NIF `B13674197`), covering F1, R1 (por diferencias), exempt, foreign recipient, multi-rate
EOF
)"

new_issue "Veri*Factu V2 — Issue flow" \
  "verifactu,invoicing" \
"$(cat <<'EOF'
See `docs/verifactu-integration-roadmap.md` §4.2, §4.7, §3.

**Depends on:** V1 — **Blocks:** V3, V4

- [ ] `draft` / `issued` lifecycle + `issued_at`; an explicit **"Issue invoice"** action in the invoice modal (§4.2)
- [ ] On issue: build payload -> `POST /invoice` -> persist a `verifactu_records` row (`queueId`, QR, URL, `chain_hash`, XML, state) -> `logAudit({ kind: "verifactu.register" })`
- [ ] Block `PATCH` / `DELETE` on issued invoices at the API layer (409 + guidance) (§3)
- [ ] Failure UX: keep the invoice as draft/failed, surface the BOLD `message`, "Retry" (with `isFix: true` when the record already exists)
- [ ] Timezone hardening: `issuedTime` / `operationDate` pinned to `Europe/Madrid`, validated not-future and `>= 2024-07-01` before submit (§4.7)
- [ ] Send `Verify-Issuer-Id` (the entity NIF) on every call
EOF
)"

new_issue "Veri*Factu V3 — Cancel & rectify" \
  "verifactu,invoicing" \
"$(cat <<'EOF'
See `docs/verifactu-integration-roadmap.md` §4.5.

**Depends on:** V2 — **Blocks:** V5

- [ ] "Cancel invoice" -> `POST /invoice_cancel(queueId)` -> `status 6` + a cancellation `verifactu_records` row + `logAudit({ kind: "verifactu.cancel" })`
- [ ] Rectificativa -> `type: R1` + `creditNote.style: "I"` + `creditNote.ids: [source]`; register as its own record
- [ ] Stop the silent source auto-cancel on corrective creation; make cancelling the source an explicit AEAT event per the advisor's policy
- [ ] Rejected-registration resend path (`isFix: true`)
EOF
)"

new_issue "Veri*Factu V4 — Visibility" \
  "verifactu,invoicing" \
"$(cat <<'EOF'
See `docs/verifactu-integration-roadmap.md` §4.6, §2.

**Depends on:** V2 — **Blocks:** V5

- [ ] Invoice PDF: QR image + verification URL + Veri*Factu legend, from the stored record (§4.6)
- [ ] Invoice list + detail: Veri*Factu state badge (`pending` / `sent` / `error`), error text, resubmit control
- [ ] "Refresh AEAT status" (manual) + optional background poll of `pending` records via `POST /invoice_state/{id}` — there are **no webhooks** (§2)
- [ ] Optional recipient NIF pre-check via `POST /id_check` in the invoice modal
EOF
)"

new_issue "Veri*Factu V5 — Settings tab + go-live" \
  "verifactu,invoicing,compliance" \
"$(cat <<'EOF'
See `docs/verifactu-integration-roadmap.md` §7, §8.

**Depends on:** V0, V3, V4 — **Blocks:** J

- [ ] Settings -> **"Veri*Factu"** tab (admin-only, hidden unless `FEATURES.verifactu`): status panel, per-entity table, behaviour options (§7)
- [ ] `server/routes/verifactu.js` (admin-gated) + a write-only entity API-key field ("hasKey" only, never echoed) in `routes/entities.js`
- [ ] i18n keys x3 (en / es / ca) in `public/js/i18n-dict.js`
- [ ] Full sandbox E2E; cross-check QRs against the AEAT sandbox validator (`prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR`)
- [ ] Switch one entity to a **production** API key; issue one real invoice; verify on the AEAT production validator
- [ ] Enable the remaining entities
- [ ] Update `docs/0B-config-inventory.md` + `server/.env.example` + deploy notes
EOF
)"

new_issue "Veri*Factu J — [Tracking] Veri*Factu live: the acceptance gate" \
  "verifactu,tracking" \
"$(cat <<'EOF'
Complete when every workstream issue is closed **and** the gate checks pass. Edit this issue to link the real issue numbers once created.

- [ ] Veri*Factu V0 · Commercial & legal groundwork
- [ ] Veri*Factu V1 · Foundations
- [ ] Veri*Factu V2 · Issue flow
- [ ] Veri*Factu V3 · Cancel & rectify
- [ ] Veri*Factu V4 · Visibility
- [ ] Veri*Factu V5 · Settings tab + go-live
- [ ] Ops' *declaración responsable* is published at a stable URL
- [ ] BOLD production agreement signed; POA accepted for every issuing NIF
- [ ] Per-NIF gap-free numbering is live; cutover done; finance signed off
- [ ] A real invoice for each entity has been issued, registered, and confirmed `sent` on the AEAT validator
- [ ] A cancellation and a rectificativa have round-tripped against the AEAT
- [ ] Issued invoices are immutable in the UI and the API (edit / delete blocked)
- [ ] The invoice PDF shows the QR + legend; non-Spanish instances still hide the feature entirely
EOF
)"

echo
echo "Done. Review the milestone: https://github.com/$REPO/milestones"
echo "Then edit issue J to replace the 'Veri*Factu VX' bullets with '#<number>' cross-links."
