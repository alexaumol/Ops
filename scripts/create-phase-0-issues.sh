#!/usr/bin/env bash
#
# Create the Phase 0 milestone, labels, and issues on GitHub.
# Requires the GitHub CLI (https://cli.github.com) authenticated with repo scope:
#     gh auth login
#
# Idempotent-ish: label / milestone creation failures (already exist) are ignored.
# Issues are NOT deduplicated — run this once. Re-running creates duplicates.
#
# Usage:
#     ./scripts/create-phase-0-issues.sh [owner/repo]
# Defaults to alexaumol/Ops.

set -euo pipefail

REPO="${1:-alexaumol/Ops}"
MILESTONE="Phase 0: SaaS foundations"

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
create_label phase-0       0e8a16 "Must ship before the second customer"
create_label saas-platform 1d76db "Multi-customer platform work"
create_label identity      5319e7 "Auth / Zitadel / OIDC"
create_label infra         fbca04 "Hosting, TLS, DNS, backups"
create_label security      d93f0b "Hardening and access control"
create_label legal         c5def5 "GDPR, contracts, pricing"
create_label migrations    006b75 "Database schema migrations"
create_label tracking      ededed "Umbrella / tracking issue"
echo

# --- milestone --------------------------------------------------------------
echo "Milestone:"
gh api "repos/$REPO/milestones" -f title="$MILESTONE" \
  -f description="Everything that must be true before onboarding a second customer." \
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

new_issue "Phase 0A — Identity broker: stand up Zitadel, cut Ops over to generic OIDC" \
  "phase-0,identity,saas-platform" \
"$(cat <<'EOF'
Replace the hardcoded single-tenant Entra ID auth with a Zitadel identity broker at `auth.theaumol.com` that every tenant instance trusts. Zitadel federates to Microsoft, Google, or a customer's own SSO, with an email one-time code for users who have none of those.

**Depends on:** 0G (SMTP + templates) — **Blocks:** 0D, 0J

- [ ] Deploy Zitadel on the VPS — its own `zitadel` Postgres database, nginx vhost at `auth.theaumol.com`, TLS
- [ ] Register a multi-tenant Microsoft Entra app in our directory; start publisher verification
- [ ] Create a Google OAuth client; add Microsoft + Google as external IdPs in Zitadel
- [ ] Enable email one-time-code login; keep Zitadel username/password disabled
- [ ] Configure Zitadel outbound SMTP, from-address, and branded email/login templates
- [ ] Decide the tenant model — one Zitadel Organization per customer — and the email-domain -> org mapping
- [ ] Replace MSAL in `public/js/auth.js` + `public/js/config.js` with a standard OIDC/PKCE flow against Zitadel
- [ ] Rewrite `server/lib/entraToken.js` as a generic OIDC verifier (discovery, JWKS, issuer/audience/expiry) for `auth.theaumol.com`
- [ ] Map verified email / `sub` -> `employees` row; define invited-user and first-login behaviour
- [ ] Pass the login test matrix — M365 user, Google user, email-code user, deactivated user, unknown user
EOF
)"

new_issue "Phase 0B — Externalise per-deployment configuration" \
  "phase-0,saas-platform" \
"$(cat <<'EOF'
Ops hardcodes deployment-specific values in source. Make every per-instance value config-driven so the provisioning script can template it.

**Blocks:** 0D

- [ ] Grep the tree for hardcoded values — `fhitt.org`, `ops.fhitt.org`, CORS origins, `public.` table qualifiers
- [ ] Move invoice-mail transport selection from entity *name* to a per-entity config field (transport + credentials)
- [ ] Template `public/js/config.js` — API base, OIDC issuer/client, feature flags — rendered at provision time
- [ ] Template `server/.env` — document every variable, flag which are per-instance
- [ ] Remove `null` / `file://` CORS allowances from the production template
- [ ] Confirm `public.`-qualified queries are safe under silo (one schema per database) and document it
EOF
)"

new_issue "Phase 0C — Adopt a migration framework" \
  "phase-0,migrations" \
"$(cat <<'EOF'
Runtime `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` has no version record and no ordering guarantee — unworkable across a fleet.

**Blocks:** 0D, 0J

- [ ] Choose a tool — `node-pg-migrate` fits the stack
- [ ] Capture the current production schema as `0001_baseline`
- [ ] Convert every runtime `ensure*Schema()` / `server/db/schema-changes.sql` block into ordered migrations
- [ ] Add `migrate up` as a deploy step; record the applied version per database
- [ ] Keep the `ensure*` calls one more release as a safety net, then delete them
EOF
)"

new_issue "Phase 0D — Provisioning script" \
  "phase-0,infra,saas-platform" \
"$(cat <<'EOF'
One command to stand up a new customer instance end to end.

**Depends on:** 0A, 0B, 0C, 0E — **Blocks:** 0J

`provision <slug> <name> <admin-email>` must:

- [ ] Create database `ops_<slug>` + a scoped role + the `GRANT`
- [ ] Render `.env` and `config.js`, copy `/public`
- [ ] Load the baseline schema, run `migrate up`
- [ ] Install the `ops@<slug>` systemd unit + nginx server block (`nginx -t` first)
- [ ] Create the `<slug>.ops.theaumol.com` DNS record via the IONOS API
- [ ] Create the Zitadel organisation + admin user, send the invite
- [ ] Seed the admin `employees` row, default entities, current work-calendar year
- [ ] Run a smoke check (`/api/health` + a login); register the instance in the control-plane record
- [ ] Be idempotent; roll back a partial failure
EOF
)"

new_issue "Phase 0E — Wildcard TLS + DNS automation" \
  "phase-0,infra" \
"$(cat <<'EOF'
**Blocks:** 0D

- [ ] Issue the `*.ops.theaumol.com` wildcard via Let's Encrypt DNS-01 + the IONOS plugin
- [ ] Cover `auth.theaumol.com` and `console.theaumol.com` too — separate certs, or a `*.theaumol.com` wildcard
- [ ] Auto-renew timer + nginx reload hook; test a dry-run renewal
- [ ] Store the IONOS DNS API token with least privilege, outside the repo
EOF
)"

new_issue "Phase 0F — Backups & disaster recovery" \
  "phase-0,infra,security" \
"$(cat <<'EOF'
**Blocks:** 0J

- [ ] WAL archiving to IONOS Object Storage — pgBackRest or WAL-G
- [ ] Nightly `pg_dump` per database with a retention policy, copied off-box
- [ ] One full restore test to a scratch host — record the resulting RTO / RPO
- [ ] Alert on backup failure
- [ ] Write the rebuild-from-zero runbook
EOF
)"

new_issue "Phase 0G — Email infrastructure & deliverability" \
  "phase-0,infra" \
"$(cat <<'EOF'
One-time-code logins and notifications must land, not spam-folder.

**Blocks:** 0A (SMTP tasks)

- [ ] Add SPF, DKIM, and DMARC records for `theaumol.com`
- [ ] Set up a transactional sender (SES / Postmark / Resend / IONOS SMTP) with domain authentication
- [ ] Route Zitadel, invoice mail, and control-plane alerts through it
- [ ] Score deliverability (mail-tester) and set up bounce / complaint monitoring
EOF
)"

new_issue "Phase 0H — Security baseline for the host & control plane" \
  "phase-0,security" \
"$(cat <<'EOF'
- [ ] SSH key-only, password auth disabled, `fail2ban`
- [ ] Unattended security upgrades enabled
- [ ] One least-privilege DB role per instance — no shared superuser in any app `.env`
- [ ] Disk encryption at rest (LUKS), or a written plan and date for it
- [ ] Ship audit / syslog off-box
- [ ] Provisioning secrets in a secret store, not plaintext in the repo
EOF
)"

new_issue "Phase 0I — Legal & commercial pack" \
  "phase-0,legal" \
"$(cat <<'EOF'
- [ ] DPA template with the Art. 28(3) clauses — drafted, then reviewed by a Spanish data-protection lawyer
- [ ] Public sub-processor list page
- [ ] Privacy policy — including the Zitadel account-data controller note
- [ ] Your Records of Processing, plus a customer-facing ROPA template
- [ ] Written breach-response procedure + breach register (24 h internal clock)
- [ ] SaaS subscription agreement / Terms of Service
- [ ] Pricing v1 — two or three flat tiers by headcount band, written down
- [ ] One-page security & privacy overview for procurement
EOF
)"

new_issue "Phase 0J — [Tracking] Phase 0 done: the acceptance gate" \
  "phase-0,tracking" \
"$(cat <<'EOF'
Phase 0 is complete when every workstream issue is closed **and** the gate checks pass. Edit this issue to link the real issue numbers once created.

- [ ] Phase 0A · Identity broker
- [ ] Phase 0B · Config externalisation
- [ ] Phase 0C · Migration framework
- [ ] Phase 0D · Provisioning script
- [ ] Phase 0E · Wildcard TLS + DNS
- [ ] Phase 0F · Backups & DR
- [ ] Phase 0G · Email infrastructure
- [ ] Phase 0H · Security baseline
- [ ] Phase 0I · Legal & commercial pack
- [ ] A throwaway `demo.ops.theaumol.com` provisioned end to end by the script in under 15 minutes
- [ ] All three login paths work; a deactivated user is blocked
- [ ] A restore test has passed and is documented
- [ ] A schema change deployed to two instances via migrate fan-out
- [ ] DPA, privacy policy, and sub-processor list are live
- [ ] The demo instance tears down cleanly through the offboard path
EOF
)"

echo
echo "Done. Review the milestone: https://github.com/$REPO/milestones"
echo "Then edit issue 0J to replace 'Phase 0X' bullets with '#<number>' cross-links."
