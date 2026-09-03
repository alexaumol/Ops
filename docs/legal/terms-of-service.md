# SaaS Subscription Agreement / Terms of Service (skeleton)

> ⚠ **LAWYER REVIEW REQUIRED.** This is a clause checklist with drafting notes,
> not a contract. A commercial lawyer should draft the operative text and set
> the commercial positions (liability cap, warranties, SLA credits,
> termination). Decide first: a **click-through ToS** for all customers, or a
> **signed order form + master terms** for larger ones. Recommendation:
> signed order form referencing online master terms + the DPA.

## Structure

**Order form** (per customer, signed): parties, plan/tier, seat count, fees,
term, start date, any negotiated changes.
**Master Subscription Terms** (these): everything below.
**DPA** ([dpa.md](dpa.md)): data protection.
**Sub-processor list** ([subprocessors.md](subprocessors.md)): referenced by
the DPA.

## Clause checklist

### 1. Definitions
Service, Instance, Subscription Term, Users, Customer Data, Documentation,
Order Form, Fees.

### 2. The Service & access
- Grant: non-exclusive, non-transferable right to access during the term for
  the Customer's internal business use, up to the licensed User count.
- Provisioning: a dedicated instance at `<slug>.ops.theaumol.com`.
- Acceptable use: no unlawful content, no security circumvention, no resale,
  no entering Art. 9 special-category data into free-text fields.
- User accounts: Customer is responsible for its Users' acts and for
  managing access.

### 3. Customer Data
- Customer owns Customer Data.
- Customer grants [PROVIDER] a licence to host and process it to provide the
  Service.
- Customer is responsible for the accuracy and lawfulness of Customer Data
  and for having the right to put it in the Service.
- Data protection: governed by the DPA.

### 4. Fees & payment
- Fees per the Order Form; [annual / monthly] in advance.
- [Invoicing terms, e.g. net 15; late payment interest per Ley 3/2004 on
  late payment in commercial transactions.]
- Taxes: exclusive of VAT/IGIC.
- Price changes: on renewal, with [60] days' notice.
- [Seat true-up: how added Users mid-term are billed.]

### 5. Term & termination
- Initial term per the Order Form; auto-renews for successive [12-month]
  periods unless either party gives [30/60] days' notice.
- Termination for cause: material breach uncured after [30] days; insolvency.
- Effect of termination: access ends; data export window ([30] days) then
  deletion per the DPA; accrued fees payable.
- [Suspension rights for non-payment or security risk, with notice.]

### 6. Service levels
- Target availability: **[99.5%]** monthly, measured [how], excluding
  scheduled maintenance ([notified [48h] ahead, outside business hours]) and
  causes outside [PROVIDER]'s control.
- [Service credits as the sole remedy for missed SLA — table.]
- Support: [channel], [response targets by severity], business hours
  [CET, Mon–Fri].
- Backups & recovery: nightly; RPO ≤ 24h; RTO targets per the Security
  Overview. [Not a substitute for the Customer's own records.]

### 7. Warranties
- [PROVIDER]: the Service will perform materially per the Documentation;
  will not knowingly introduce malware; has the right to provide it.
- Mutual: authority to enter the agreement.
- Disclaimer: otherwise the Service is provided "as is"; no warranty of
  uninterrupted or error-free operation.

### 8. Intellectual property
- [PROVIDER] owns the Service, software, and Documentation.
- Feedback licence to [PROVIDER].
- No rights granted except as expressly stated.

### 9. Confidentiality
Mutual; standard carve-outs; term + [3] years.

### 10. Indemnities
- [PROVIDER] indemnifies Customer for third-party IP infringement claims
  against the Service [with the usual conduct-of-claim and mitigation
  rights: modify, replace, or refund].
- Customer indemnifies [PROVIDER] for claims arising from Customer Data or
  unlawful use.

### 11. Limitation of liability
- Exclude indirect / consequential loss, lost profits, lost data [beyond
  restoration from backup].
- Cap: **[fees paid in the 12 months before the claim]**.
- Carve-outs from the cap: [death/personal injury, fraud, breach of
  confidentiality, data-protection breach caused by [PROVIDER], Customer's
  payment obligations] — lawyer to set.

### 12. General
- Governing law: **[Spain]**; jurisdiction: **[courts of Barcelona]**.
- Assignment: not without consent, except to a successor of the business.
- Subcontracting: permitted (sub-processors per the DPA).
- Force majeure.
- Entire agreement; order of precedence (Order Form > these terms > DPA for
  non-data matters; DPA prevails on data protection).
- Notices.
- Changes to these terms: [on renewal / with [30] days' notice for
  non-material; material changes require consent].
- Publicity: [may/‑may not] name the Customer as a customer with prior
  approval.

## Commercial positions to decide before drafting

| item | options | note |
|---|---|---|
| Contract model | click-through / signed order form | order form recommended |
| Billing | monthly / annual / annual-only | annual simplifies cash flow |
| SLA | none / 99.5% / 99.9% | one shared VPS makes 99.9% hard to promise honestly |
| Liability cap | 12-month fees / 1x annual / fixed € | 12-month fees is market-standard for SMB SaaS |
| Trial | none / 14–30 day | |
| Minimum term | monthly rolling / 12 months | |
