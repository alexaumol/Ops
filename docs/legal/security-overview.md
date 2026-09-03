# Ops — Security & Privacy Overview

_For customer security / procurement review. Last updated 2026-09-03._

Ops is a project-lifecycle and invoicing application delivered as a
single-tenant SaaS. This page summarises how customer data is protected.

## Tenancy & isolation

- **One instance per customer.** Each customer gets a dedicated application
  process, a dedicated PostgreSQL database, and a dedicated web hostname
  (`<customer>.ops.theaumol.com`). No customer data is co-mingled in a shared
  database or shared application memory.
- Each instance's database is owned by a **scoped database role** with access
  to that one database only. An instance cannot read another instance's data.
- Instances share only immutable application code and the front-end static
  assets.

## Hosting & data location

- Hosted on **IONOS** cloud infrastructure in the **EU (Germany)**.
- Block-storage volumes are **encrypted at rest** (AES-XTS 256-bit;
  provider-managed keys held outside the VM).
- All customer data — database and uploaded files — stays in the EU.

## Encryption in transit

- **TLS 1.2+** on all web and API traffic, HTTPS-only (HTTP redirects to
  HTTPS), via Let's Encrypt certificates with automated renewal.
- Administrative access to servers is over **SSH with key authentication
  only** (no passwords); the database is not exposed to the public internet.

## Authentication & access control

- End-user sign-in is brokered through a self-hosted **Zitadel** identity
  service. Customers federate their existing **Microsoft Entra ID** or
  **Google Workspace**, or use email + password with **multi-factor
  authentication**.
- Ops does not store end-user passwords; federated credentials never reach
  Ops.
- Application authorisation is role-based; a deactivated user is denied
  access on their next request.
- Provider administrative access is limited to [N] named individuals, over
  key-based SSH, and is logged.

## Backups & recovery

- **Nightly** encrypted database backups, retained 7 days locally and 31 days
  off-site in EU object storage.
- Backups are **client-side encrypted** before leaving our infrastructure —
  the storage provider cannot read them.
- Restore procedure is documented and tested; single-database recovery
  objective is minutes, full-environment rebuild target is under 4 hours.
- Recovery point objective: ≤ 24 hours (last nightly backup).

## Operational security

- Host firewall default-denies inbound traffic (only 80/443 and admin SSH
  open); `fail2ban` blocks brute-force attempts.
- Unattended **security** patching on all servers.
- Secrets (database passwords, API keys) are stored in root-only files on the
  host, never in source control.

## Data handling

- **You are the data controller; we are the processor.** We process personal
  data only on your documented instructions, per our Data Processing
  Agreement.
- Sub-processors are listed at [subprocessors.md](subprocessors.md); all
  process data in the EU (Resend delivers via AWS SES in Ireland under EU
  SCCs).
- On termination, your data is exported to you and then deleted from active
  systems within [30] days and from backups within the backup retention
  window ([31] days).

## Sub-processor & transfer summary

| provider | function | location |
|---|---|---|
| IONOS SE | hosting, storage, DNS, backups | Germany / EU |
| Resend (via AWS SES) | transactional email | Ireland / EU |
| Microsoft (optional) | Graph mail / Entra ID, if you enable it | EU |

## What we do **not** do

- We do not sell or share customer data.
- We do not use customer data to train machine-learning models.
- We do not access instance contents except as needed for support you
  request or to maintain the service, and such access is logged.

## Contact

Security questions and vulnerability reports: **[SECURITY CONTACT]**.

---

### Known gaps / roadmap (remove before sending to customers, or keep an honest "roadmap" section)

- Off-host log shipping — planned.
- Formal penetration test — planned before [date].
- Point-in-time (sub-24h) database recovery — planned.
- SOC 2 / ISO 27001 — not currently pursued; available on request as a
  roadmap discussion.
