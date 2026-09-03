# Records of Processing Activities (RoPA)

Two records:

1. **Ours, as processor** (GDPR Art. 30(2)) — required; keep current.
2. **A controller template** (Art. 30(1)) — hand to customers so they can
   maintain their own record for the data they put in Ops.

---

## 1. Processor record — [PROVIDER LEGAL NAME]

_Art. 30(2). Last reviewed 2026-09-03._

### Controller & processor

| | |
|---|---|
| Processor | [PROVIDER LEGAL NAME], [PROVIDER ADDRESS], [PROVIDER NIF] |
| Processor contact | [PRIVACY CONTACT] |
| Controllers | Each Ops customer (per the signed DPA / order form) |
| DPO | Not appointed (Art. 37 threshold not met); responsible person: [NAME] |

### Categories of processing carried out for controllers

| processing activity | categories of data subjects | categories of personal data |
|---|---|---|
| Hosting & operating the customer's Ops instance | The customer's employees; the customer's clients / project contacts; invoice recipients | Names, work contact details, job roles; project records; time / calendar data; invoice and payment records; free-text notes; uploaded documents (expense evidence etc.) |
| Brokered authentication (Zitadel) | Users the customer authorises to sign in | Email address, display name, identity-provider subject identifier, MFA enrolment status, authentication timestamps |
| Transactional email (via Resend) | Recipients of login codes and service notifications | Email address, name, message content |
| Backups | As above (all instance data) | As above, encrypted |
| Support (on request) | As above | Whatever is visible in the instance while handling the request |

### Transfers to third countries

- No transfers outside the EEA in the ordinary course.
- **Resend** (US entity) delivers via AWS SES in **Ireland (EU)**; the
  contractual relationship is covered by **EU Standard Contractual Clauses**.
- No other third-country transfers.

### Sub-processors

See [subprocessors.md](subprocessors.md). All process in the EU.

### Retention

- Instance data: for the life of the subscription; on termination, exported
  to the controller, deleted from active systems within [30] days and from
  backups within the retention window ([31] days).
- Zitadel account data: for the life of the user's authorisation; removed on
  deactivation.
- Email delivery logs (Resend): per Resend's retention ([confirm], typically
  short).
- Our own operational logs: [X] days.

### Technical & organisational measures (Art. 32)

Summarised in [security-overview.md](security-overview.md): per-tenant
isolation, encryption in transit and at rest, encrypted off-site backups,
key-based admin access, host firewall + fail2ban, least-privilege database
roles, security patching, secrets kept out of source control, tested restore.

---

## 2. Controller record — template for customers

_Give this to each customer. They complete and keep it; you don't hold it._

> ### Record of processing — [CUSTOMER NAME], use of Ops
>
> | | |
> |---|---|
> | Controller | [CUSTOMER NAME], [address], [contact] |
> | Processor | [PROVIDER LEGAL NAME] (Ops SaaS) — DPA dated [ ] |
> | Purposes of processing | Managing the project lifecycle, resourcing, and client invoicing for our organisation |
> | Categories of data subjects | Our employees; our clients and their contacts; project participants; invoice recipients |
> | Categories of personal data | Names, work contact details, roles; project assignments and time records; calendar data; invoicing and payment records; notes; uploaded supporting documents |
> | Special-category data | None expected. Do not enter health, union, or other Art. 9 data into free-text fields. |
> | Recipients | [PROVIDER] as processor and its EU sub-processors (hosting, email); our own accountants / authorities as required by law |
> | Third-country transfers | None (EU-hosted). Transactional email delivered within the EU under SCCs. |
> | Retention | For the duration of the business relationship + [our statutory retention, e.g. 6 years for invoicing under Spanish commercial/tax law]; then deleted or anonymised |
> | Security measures | As provided by the processor (see its Security Overview) plus our own access controls: we grant Ops access only to authorised staff and review that list [quarterly] |
> | Lawful basis | [Legitimate interests / contract / legal obligation for invoicing — the customer decides and documents] |
