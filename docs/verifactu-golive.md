# Veri*Factu — go-live checklist

Everything code-side (phases V1–V5) is merged. What's left is operational:
real BOLD credentials, a systemd timer, the *declaración responsable*, and
switching entities from sandbox to production. Work top to bottom.

Reference: [`verifactu-integration-roadmap.md`](verifactu-integration-roadmap.md) ·
API contract: [`verifactu-boldsoftware-openapi.yaml`](verifactu-boldsoftware-openapi.yaml)

---

## 1 · Before the first sandbox test

- [ ] `server/.env` on the instance: `FEATURE_VERIFACTU=true`, `VERIFACTU_PROVIDER=bold`,
      `VERIFACTU_ENV=sandbox`, `VERIFACTU_BASE_URL=https://vf1.boldsoftware.es/v1`
- [ ] `public/js/config.js` on the instance: `FEATURES.verifactu = true`
- [ ] `cd server && npm run migrate` — applies `1788448547623_verifactu-foundations` and
      `1788449400114_verifactu-issue-flow`
- [ ] `npm run verifactu:test` passes (23 cases)
- [ ] `VERIFACTU_API_KEY=<sandbox key> npm run verifactu:smoke` — prints a `queueId`, QR and a
      `prewww2.aeat.es/...ValidarQR` URL; open it and confirm the invoice shows
- [ ] Settings → Veri\*Factu tab is visible; the status banner is sensible
- [ ] Per entity in that tab: paste the **sandbox** BOLD API key, set the environment to
      `Sandbox`, set an invoice-series prefix (confirm the prefixes + a cutover date with
      finance first — §4.1 of the roadmap), enable it
- [ ] BP → tax companies: set `fiscalidtype` / country on a couple of real clients (Spanish +
      one foreign) so both recipient forms are exercised

### The sandbox issuer NIF

Our BOLD sandbox account is the shared test company **EMPRESA DE PRUEBAS (PI4)**, NIF
**`A39200019`** (given by BOLD). The `Verify-Issuer-Id` guard compares the *entity's* VAT
number against the NIF on the API-Key, so in sandbox one of these must be true, or every
issue fails with `000007`:

- **`VERIFACTU_VERIFY_ISSUER=false`** in `server/.env` — the guard is never sent (records keep
  the entity's real NIF; harmless in the sandbox). Simplest for a quick pass. *(The default —
  blank — only sends the guard in `production`, but a per-entity Environment set to
  `Production` by mistake re-enables it.)*
- or set the test entity's VAT number to `A39200019` so the guard matches and every artifact
  (record XML, QR, verify URL) is consistent with the test company.

Do **not** put `A39200019` on a real billing entity on an instance that emails real invoices —
use a throwaway "… — Veri\*Factu sandbox" entity + a test project, or the `false` override.
Drop the override and use the real per-entity NIF for the production cutover (§5).

## 2 · Sandbox end-to-end (against *EMPRESA DE PRUEBAS (PI4)*, NIF `A39200019`)

> BOLD's sandbox auto-prefixes every invoice number with `PI4-`, so `chainInfo.number` and the
> verification URL will read `PI4-<your number>`. Expected.

- [ ] Create a draft invoice → **Issue** it → the row shows a `Sent to AEAT` chip, the modal
      shows a `queueId` + verify link
- [ ] Open the invoice PDF → the QR + `VERI*FACTU` legend + verify URL are on it; scan the QR
- [ ] Cross-check the QR / CSV on `https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR`
- [ ] Try to **edit** and **delete** the issued invoice → both are blocked (409)
- [ ] **Cancel** it → status goes to Cancelled, an `anulación` record appears
- [ ] Create a **corrective** for a (fresh) issued invoice → it registers as `R1`; the source
      is *not* auto-cancelled
- [ ] Foreign recipient: issue an invoice to the non-Spanish tax company → `recipient` uses the
      `id` + `idType` + `country` form (check the stored `record_xml`)
- [ ] Kill network / use a bad base URL briefly, issue an invoice → it still issues, the record
      is `pending`; restore, run `npm run verifactu:poll` → it flips to `sent`
- [ ] (optional) turn on **Pre-check recipient NIF** in Settings → issuing to a wrong-name
      client is blocked with a clear message; the "Check recipient" button works on a draft

## 3 · The status-poll timer

```bash
sudo cp /opt/ops/backup/systemd/ops-verifactu-poll.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ops-verifactu-poll.timer
sudo systemctl start ops-verifactu-poll.service
journalctl -u ops-verifactu-poll.service -f
```

- [ ] Timer active (`systemctl list-timers | grep verifactu`); a manual run logs a JSON summary

## 4 · Legal / commercial (blocks production, not development)

- [ ] BOLD **production** agreement signed; POA / *justificante de alta* accepted for **every**
      issuing NIF (HiTT, FHiTT, HiTT-OSM?)
- [ ] Confirm with BOLD: one API-Key per NIF; enable the `invoice_state` `error_code` /
      `error_text` / `aeat_registered` fields for our account; record retention + bulk export;
      SLA / maintenance windows
- [ ] Tax advisor: which entities are in scope (any in **SII** → Veri\*Factu not required);
      invoice types in use; the exact PDF legend wording; cancel-vs-rectify policy
- [ ] **Ops' *declaración responsable*** drafted and published at a stable URL → paste that URL
      in Settings → Veri\*Factu
- [ ] Finance: the per-entity series prefixes + the cutover date are agreed and recorded

## 5 · Production cutover (one entity at a time)

- [ ] Remove `VERIFACTU_VERIFY_ISSUER=false` from `server/.env` (and revert any test NIF on a
      real entity back to its real VAT number) — the issuer guard should be live in production
- [ ] Settings → Veri\*Factu → for the first entity: replace the key with the **production**
      key, switch Environment to `Production`
- [ ] Confirm that entity's VAT number (Settings → Entities) exactly matches the NIF BOLD
      registered against its production API-Key — a mismatch is `000007` on every issue
- [ ] Issue **one real invoice** for that entity → confirm `sent`, verify the QR on the
      **production** validator (`www2.agenciatributaria.gob.es/.../ValidarQR`)
- [ ] Watch `ops-verifactu-poll` for a day — no unexpected `error` records
- [ ] Repeat for the remaining entities
- [ ] `VERIFACTU_ENV=production` in `.env` (the per-entity setting already overrides it, but
      keep the default honest)

## 6 · Housekeeping

- [ ] `docs/0B-config-inventory.md` — add `FEATURE_VERIFACTU` + `VERIFACTU_*` to the
      per-instance env list; note the `ops-verifactu-poll` timer as a per-Spanish-instance unit
- [ ] Confirm backups cover `verifactu_records` (it's in the app DB → already included)
- [ ] Tell the team: issued invoices are immutable — corrections go through Cancel / corrective
