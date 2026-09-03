# Presence register — registro de jornada (RDL 8/2019)

Time allocation → **Presence** is HITT Ops's legal working-time register:
Real Decreto-ley 8/2019 (art. 34.9 of the Estatuto de los Trabajadores) plus
the monthly totalisation of art. 35.5 ET.

## What the law requires, and how this implements it

| Requirement | Implementation |
|---|---|
| Record the **concrete start and end times** of each worker's day, **pauses included** | Multi-segment clock in/out (`presence_events`, `kind` `in`/`out`). A break is an `out` then an `in`. |
| **Objective, reliable, non-manipulable after the fact, with traceability** | `presence_events` is append-only. A DB trigger blocks `UPDATE`/`DELETE`. A correction is a **new** row (`supersedes_id`); replacing a day inserts `void` rows for the old entries — originals are never destroyed. Each row is in a per-employee **SHA-256 hash chain** (`npm run presence:verify` detects tampering). Every write is in `actionsaudit` (`presence.*`). |
| **4-year retention**, then deletion | `presence.retention_months` (default 48). `npm run presence:purge` is the only code that can delete, inside a transaction that sets `app.presence_purge='on'`. It refuses to run while `presence.legal_hold='on'`. |
| Access for the **worker** (own entries), **legal representatives** and **Inspección de Trabajo** (all entries) | Three tiers. Everyone sees/exports their own. **Presence viewer** = read + export every register, no edit (assign to worker reps / a labour-inspector account). **Presence admin** = + configure + record entries on someone's behalf. Admins get both. Every cross-employee read/export is audited. |
| Register method **agreed after consulting worker representatives** | `presence.method_doc` config field — put the collective/company agreement or employer decision there; it prints on the PDF export. |
| Art. 35.5 — jornada **totalised** monthly, **copy of the summary delivered** to the worker | `presence_monthly` (worked / expected / overtime + a frozen snapshot). The worker acknowledges receipt in the tab ("He recibido este resumen"). |
| GDPR / LOPDGDD | Legal-obligation basis. Purpose limited to the register + payroll — **not** productivity monitoring. **No biometrics, no geolocation.** `location_label` is a self-declared chip (office/remote/client). `entered_ip` is audit metadata, admin-only, never shown as "location". `presence.privacy_notice` shows the notice to employees. |
| "Horario concreto" = Spain wall-clock, DST-aware | `timestamptz` everywhere + `AT TIME ZONE` `presence.timezone` (default `Europe/Madrid`). Never the server or browser timezone. |

## Configuration (Settings → Configuration, or a Presence admin via the API)

| Key | Default | Notes |
|---|---|---|
| `presence.timezone` | `Europe/Madrid` | IANA zone the day is recorded in. |
| `presence.default_daily_minutes` | `480` | Used when an employee has no `presence_contract` row. |
| `presence.workdays` | `1,2,3,4,5` | ISO weekday numbers (1 = Mon). |
| `presence.method_doc` | — | The consultation/agreement record. Printed on the PDF. |
| `presence.retention_months` | `48` | Purge window. Legal minimum 48. |
| `presence.legal_hold` | `off` | Set `on` during a dispute/inspection to freeze the purge. |
| `presence.privacy_notice` | — | Shown to employees from the Presence tab. |

Per-employee contracted hours (part-time, contract changes over time) are
effective-dated in `presence_contract` — `POST /api/presence/contract/:employeeId`.

## Setup checklist (before switching it on)

1. **Consult the worker representatives** on the method (this app, clock
   in/out, corrections with a logged reason). Record the outcome in
   `presence.method_doc`.
2. **Inform every employee** — fill `presence.privacy_notice` (purpose, legal
   basis, 4-year retention, their rights).
3. Set `presence.timezone`, `presence.default_daily_minutes`,
   `presence.workdays`; add `presence_contract` rows for anyone not on the
   default (part-timers, etc.).
4. Assign **Presence viewer** to the worker representatives (and, on request,
   to a dedicated Inspección account with a `presence_viewers.note` naming the
   expediente — remove it afterwards).
5. Install the retention timer (below).
6. Wire `npm run presence:verify` into monitoring — a non-zero exit means the
   register has been altered outside the app.

## Retention purge — deploy

```bash
cp backup/systemd/ops-presence-purge.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ops-presence-purge.timer
# dry run any time:
cd /opt/ops/server && npm run presence:purge -- --dry
```

## Producing an export for the Inspección de Trabajo

Any admin or Presence viewer: open the Presence tab → pick the person and the
period → **Exportar PDF** (or CSV). Or hit
`GET /api/presence/export?from=&to=&format=pdf&employeeId=` directly. The PDF
carries the legal basis, the method-doc, day-by-day times, and daily +
period totals; the CSV is the same data for spreadsheet analysis.

## Not built (deliberately)

Biometric / kiosk clock-in; geofencing; real-time push to an Inspección
endpoint (no such public API exists — the 2025/26 digital-register reform
that would require it is stalled); team-scoped viewer roles; automatic
handling of shifts that cross midnight beyond "the jornada belongs to the day
it started" (fix those with a manual correction).
