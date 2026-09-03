# Sub-processors

_Last updated: 2026-09-03_

[PROVIDER LEGAL NAME] ("we", the processor) engages the sub-processors below
to deliver the Ops service. Each is bound by a written contract with
data-protection terms no less protective than our DPA with you, and each is
instructed to process personal data only as needed to provide its function.

We will give customers **at least 30 days' notice** before adding or
replacing a sub-processor (via [email to the account contact / this page's
change log / status page — pick one]). A customer may object on reasonable
data-protection grounds within that window; if we cannot resolve the
objection, the customer may terminate the affected service.

## Current sub-processors

| sub-processor | role | data processed | location of processing | transfer mechanism |
|---|---|---|---|---|
| **IONOS SE** | Cloud/VPS hosting — compute, block storage, managed DNS | All customer data stored in the instance database and uploaded files; DNS query metadata | Germany (EU) | N/A — EU |
| **IONOS SE — Object Storage** | Encrypted off-site backup storage | Full database backups, **client-side encrypted** before upload (we hold the keys; IONOS sees only ciphertext) | EU region (e.g. `eu-central`) | N/A — EU |
| **Resend (Plusdocs, Inc. / "Resend")** | Transactional email delivery — login one-time codes, service notifications | Recipient email address, name, message content (verification codes, notifications) | Processing via Amazon SES, **EU region (eu-west-1, Ireland)** | Resend is US-incorporated: EU SCCs + AWS EU-region processing |
| **Microsoft Ireland Operations Ltd** | _Only if the customer enables it_ — Microsoft Graph send-as for invoice email; Entra ID as an upstream identity provider | Sender/recipient email metadata; for Entra, the authenticating user's directory identifiers | EU (Microsoft EU Data Boundary) | N/A — EU; customer-controlled tenant |

### Not sub-processors

- **Zitadel** — the identity broker runs on **our own IONOS infrastructure**
  (self-hosted), not as a third-party service. It is covered by the IONOS
  hosting entry above, not a separate sub-processor.
- **Let's Encrypt** — issues TLS certificates; processes only the domain
  name, no personal data.
- **The customer's own identity provider** (their Microsoft/Google tenant) —
  the customer controls this; it is not our sub-processor.
- **The customer's own outbound mail server** — when invoice mail uses the
  customer's SMTP/Graph credentials, that mail path is the customer's, not
  ours.

## Change log

| date | change |
|---|---|
| 2026-09-03 | Initial list. |

---

_Publish this at a stable URL (e.g. `https://theaumol.com/legal/subprocessors`)
and reference that URL from the DPA. Confirm each vendor's current legal
entity name and processing locations before publishing — they change._
