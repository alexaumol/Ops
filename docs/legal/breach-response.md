# Personal data breach — response procedure

_Internal. Owner: [NAME]. Last reviewed 2026-09-03._

A "personal data breach" is any breach of security leading to accidental or
unlawful destruction, loss, alteration, unauthorised disclosure of, or access
to personal data — in **any** instance, the Zitadel broker, backups, or our
own systems. When in doubt, treat it as a breach and start the clock.

## Clocks

| clock | starts | deadline |
|---|---|---|
| Internal triage | on becoming **aware** of a possible breach | assess within **24 hours** |
| Notify the affected controller(s) | on confirming a breach affecting their data | **without undue delay, and within 24 hours** of confirmation — they have their own 72h clock to the DPA and to data subjects |
| Regulator (if we are ever controller — e.g. Zitadel account data) | on awareness | **72 hours** to the AEPD unless the breach is unlikely to risk individuals' rights |

We are the **processor** for instance data: our GDPR duty (Art. 33(2)) is to
notify the **controller** without undue delay — the controller notifies the
regulator. We do **not** notify the AEPD for a customer's instance breach
unless acting as controller.

## Steps

### 1. Contain (immediately)

- Identify affected instance(s) / system(s). Isolate: stop the affected
  `ops@<slug>` unit, block the source (ufw / fail2ban), rotate exposed
  credentials (DB passwords via re-provision, API keys, Zitadel PAT,
  rclone keys, Zitadel masterkey if exposed).
- Preserve evidence: snapshot logs (`journalctl`), take a DB dump, note
  timestamps. Do not "clean up" before recording state.

### 2. Assess (within 24h of awareness)

Record in the register:
- What happened, when, how discovered.
- Which instances / controllers, which data categories, roughly how many
  data subjects and records.
- Root cause (or "under investigation").
- Likely consequences for data subjects and the risk level
  (low / medium / high).

### 3. Notify the controller(s) (within 24h of confirmation)

Email the account contact for each affected customer. Include, to the extent
known (Art. 33(3)): nature of the breach; categories and approximate numbers
of data subjects and records; our contact point; likely consequences;
measures taken and proposed. Send follow-ups as facts firm up — don't wait
for the full picture to make first contact.

Template: `templates/breach-notice-to-controller.md` _(to write)_.

### 4. Remediate & document

- Fix the root cause; verify.
- Post-incident note: timeline, cause, fix, and what changes to prevent
  recurrence. Link it from the register entry.
- If the same class of issue could affect other instances, check and patch
  them.

### 5. Review

Within 2 weeks: what detection / control would have caught this earlier?
Feed into `docs/security-baseline.md`.

## Contacts

| role | who |
|---|---|
| Incident owner | [NAME] |
| Backup owner | [NAME] |
| Legal (data protection) | [LAWYER — name, firm, phone] |
| AEPD breach notification | sede.aepd.gob.es (electronic filing) |

## Breach register

Keep every entry, even those not notified (Art. 33(5) — the regulator can ask
to see the full log).

| # | detected (UTC) | summary | instances / controllers | data categories | ~subjects | risk | controller notified | regulator notified | root cause | status | post-incident note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| _none yet_ | | | | | | | | | | | |
