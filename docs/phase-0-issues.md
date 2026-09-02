# Phase 0 — GitHub issues

Everything that must be true before onboarding a second customer, as a set of
GitHub issues for `alexaumol/Ops`.

**Model:** one milestone, nine workstream issues (A–I), one tracking issue (J).
Each workstream issue carries a GitHub task list so sub-items render as
checkboxes with a progress bar; convert any line to its own issue later with
one click. Bulk-create them with [`scripts/create-phase-0-issues.sh`](../scripts/create-phase-0-issues.sh).

**Milestone:** `Phase 0: SaaS foundations`
**Labels used:** `phase-0`, `saas-platform`, `identity`, `infra`, `security`, `legal`, `migrations`, `tracking`

**Dependency graph**

```
G ─┐
   ├─> A ─┐
B ─┼──────┼─> D ─┐
C ─┤      │      │
E ─┘      │      ├─> J
F ────────┼──────┤
H ────────┤      │
I ────────┴──────┘
```

---

## A · Identity broker: stand up Zitadel, cut Ops over to generic OIDC

**Labels:** `phase-0`, `identity`, `saas-platform`
**Depends on:** G (SMTP + templates) · **Blocks:** D, J

Replace the hardcoded single-tenant Entra ID auth with a Zitadel identity
broker at `auth.theaumol.com` that every tenant instance trusts. Zitadel
federates to Microsoft, Google, or a customer's own SSO, with an email
one-time code for users who have none of those.

- [ ] Deploy Zitadel on the VPS — its own `zitadel` Postgres database, nginx vhost at `auth.theaumol.com`, TLS
- [ ] Register a multi-tenant Microsoft Entra app in our directory; start publisher verification
- [ ] Create a Google OAuth client; add Microsoft + Google as external IdPs in Zitadel
- [ ] Enable email one-time-code login; keep Zitadel username/password disabled
- [ ] Configure Zitadel outbound SMTP, from-address, and branded email/login templates
- [ ] Decide the tenant model — one Zitadel Organization per customer — and the email-domain → org mapping
- [ ] Replace MSAL in `public/js/auth.js` + `public/js/config.js` with a standard OIDC/PKCE flow against Zitadel
- [ ] Rewrite `server/lib/entraToken.js` as a generic OIDC verifier (discovery, JWKS, issuer/audience/expiry) for `auth.theaumol.com`
- [ ] Map verified email / `sub` → `employees` row; define invited-user and first-login behaviour
- [ ] Pass the login test matrix — M365 user, Google user, email-code user, deactivated user, unknown user

---

## B · Externalise per-deployment configuration

**Labels:** `phase-0`, `saas-platform`
**Blocks:** D

Ops hardcodes deployment-specific values in source. Make every per-instance
value config-driven so the provisioning script can template it.

- [ ] Grep the tree for hardcoded values — `fhitt.org`, `ops.fhitt.org`, CORS origins, `public.` table qualifiers
- [ ] Move invoice-mail transport selection from entity *name* to a per-entity config field (transport + credentials)
- [ ] Template `public/js/config.js` — API base, OIDC issuer/client, feature flags — rendered at provision time
- [ ] Template `server/.env` — document every variable, flag which are per-instance
- [ ] Remove `null` / `file://` CORS allowances from the production template
- [ ] Confirm `public.`-qualified queries are safe under silo (one schema per database) and document it

---

## C · Adopt a migration framework

**Labels:** `phase-0`, `migrations`
**Blocks:** D, J

Runtime `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` has no version record and
no ordering guarantee — unworkable across a fleet.

- [ ] Choose a tool — `node-pg-migrate` fits the stack
- [ ] Capture the current production schema as `0001_baseline`
- [ ] Convert every runtime `ensure*Schema()` / `server/db/schema-changes.sql` block into ordered migrations
- [ ] Add `migrate up` as a deploy step; record the applied version per database
- [ ] Keep the `ensure*` calls one more release as a safety net, then delete them

---

## D · Provisioning script

**Labels:** `phase-0`, `infra`, `saas-platform`
**Depends on:** A, B, C, E · **Blocks:** J

One command to stand up a new customer instance end to end. `provision <slug>
<name> <admin-email>` must:

- [ ] Create database `ops_<slug>` + a scoped role + the `GRANT`
- [ ] Render `.env` and `config.js`, copy `/public`
- [ ] Load the baseline schema, run `migrate up`
- [ ] Install the `ops@<slug>` systemd unit + nginx server block (`nginx -t` first)
- [ ] Create the `<slug>.ops.theaumol.com` DNS record via the IONOS API
- [ ] Create the Zitadel organisation + admin user, send the invite
- [ ] Seed the admin `employees` row, default entities, current work-calendar year
- [ ] Run a smoke check (`/api/health` + a login); register the instance in the control-plane record
- [ ] Be idempotent; roll back a partial failure

---

## E · Wildcard TLS + DNS automation

**Labels:** `phase-0`, `infra`
**Blocks:** D

- [ ] Issue the `*.ops.theaumol.com` wildcard via Let's Encrypt DNS-01 + the IONOS plugin
- [ ] Cover `auth.theaumol.com` and `console.theaumol.com` too — separate certs, or a `*.theaumol.com` wildcard
- [ ] Auto-renew timer + nginx reload hook; test a dry-run renewal
- [ ] Store the IONOS DNS API token with least privilege, outside the repo

---

## F · Backups & disaster recovery

**Labels:** `phase-0`, `infra`, `security`
**Blocks:** J

- [x] Nightly `pg_dump` per database with a retention policy, copied off-box — `backup/backup.sh` + `ops-backup.timer`, client-side encrypted to object storage, auto-discovers new silos
- [x] Alert on backup failure — healthcheck dead-man's-switch (`<url>/start|/fail`) + systemd `OnFailure=`
- [x] Write the rebuild-from-zero runbook — `docs/backups.md`
- [x] Object-storage bucket + rclone crypt remote + timer on the Ops VPS — first `ops-backup.service` run OK, healthcheck green *(HITT VPS still to do)*
- [ ] One full restore test — run `backup/restore.sh` against a dump, record RTO / RPO in `docs/backups.md` *(only remaining 0F blocker)*
- [ ] Same backup setup on the HITT VPS
- [ ] WAL archiving to object storage — pgBackRest or WAL-G *(fast-follow, Phase 1)*

---

## G · Email infrastructure & deliverability

**Labels:** `phase-0`, `infra`
**Blocks:** A (SMTP tasks)

One-time-code logins and notifications must land, not spam-folder.

- [x] Set up a transactional sender — **Resend**, domain-authenticated for `theaumol.com`
- [x] SPF + DKIM for `theaumol.com` — added as part of Resend domain verification
- [x] Route Zitadel through it — Zitadel SMTP → Resend, verification-code delivery tested OK
- [ ] Add a **DMARC** record (`_dmarc.theaumol.com`, start at `p=none` with `rua=`)
- [ ] Route **invoice mail** (the Ops app's own sender) through Resend too, or confirm the per-entity SMTP/Graph transport is the intended path for customer instances
- [ ] Score deliverability (mail-tester.com) and turn on Resend bounce / complaint webhooks

---

## H · Security baseline for the host & control plane

**Labels:** `phase-0`, `security`

- [ ] SSH key-only, password auth disabled, `fail2ban`
- [ ] Unattended security upgrades enabled
- [ ] One least-privilege DB role per instance — no shared superuser in any app `.env`
- [ ] Disk encryption at rest (LUKS), or a written plan and date for it
- [ ] Ship audit / syslog off-box
- [ ] Provisioning secrets in a secret store, not plaintext in the repo

---

## I · Legal & commercial pack

**Labels:** `phase-0`, `legal`

- [ ] DPA template with the Art. 28(3) clauses — drafted, then reviewed by a Spanish data-protection lawyer
- [ ] Public sub-processor list page
- [ ] Privacy policy — including the Zitadel account-data controller note
- [ ] Your Records of Processing, plus a customer-facing ROPA template
- [ ] Written breach-response procedure + breach register (24 h internal clock)
- [ ] SaaS subscription agreement / Terms of Service
- [ ] Pricing v1 — two or three flat tiers by headcount band, written down
- [ ] One-page security & privacy overview for procurement

---

## J · [Tracking] Phase 0 done — the acceptance gate

**Labels:** `phase-0`, `tracking`
**Depends on:** A, B, C, D, E, F, G, H, I

Phase 0 is complete when every workstream issue is closed **and** the gate
checks pass. Fill in the issue numbers after creation.

- [ ] #A · Identity broker
- [ ] #B · Config externalisation
- [ ] #C · Migration framework
- [ ] #D · Provisioning script
- [ ] #E · Wildcard TLS + DNS
- [ ] #F · Backups & DR
- [ ] #G · Email infrastructure
- [ ] #H · Security baseline
- [ ] #I · Legal & commercial pack
- [ ] A throwaway `demo.ops.theaumol.com` provisioned end to end by the script in under 15 minutes
- [ ] All three login paths work; a deactivated user is blocked
- [ ] A restore test has passed and is documented
- [ ] A schema change deployed to two instances via migrate fan-out
- [ ] DPA, privacy policy, and sub-processor list are live
- [ ] The demo instance tears down cleanly through the offboard path
