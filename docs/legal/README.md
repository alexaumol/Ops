# Legal & commercial pack (0I)

Drafts and templates for running Ops as a SaaS. **Not legal advice.** The
documents marked _lawyer review_ must be reviewed by a Spanish
data-protection / commercial lawyer before they go in front of a customer —
they encode choices (liability caps, sub-processor consent model, governing
law, audit rights) that are decisions, not defaults.

The point of these drafts is to make the lawyer engagement a **review**, not
a write-from-scratch: everything factual about the architecture and data
flows is already filled in.

## What's here

| file | what | status |
|---|---|---|
| [subprocessors.md](subprocessors.md) | the sub-processor list (public page + DPA annex) | **near-final** — keep updated as the stack changes |
| [security-overview.md](security-overview.md) | one-page security & privacy summary for customer procurement | **near-final** |
| [ropa.md](ropa.md) | Ops's Art. 30(2) processor record + a controller RoPA template for customers | **near-final** |
| [breach-response.md](breach-response.md) | internal breach procedure + the breach register template | **near-final** |
| [dpa.md](dpa.md) | Data Processing Agreement, Art. 28(3) clauses | **lawyer review** |
| [privacy-policy.md](privacy-policy.md) | public privacy policy, incl. the identity-broker controller note | **lawyer review** |
| [terms-of-service.md](terms-of-service.md) | SaaS subscription agreement / ToS skeleton | **lawyer review** |
| [pricing-v1.md](pricing-v1.md) | tiered pricing proposal | **your decision** |

## Placeholders to fill once

These appear across the documents — set them in one place and substitute:

- `[PROVIDER LEGAL NAME]` — the registered entity name (the one on invoices)
- `[PROVIDER ADDRESS]` — registered address
- `[PROVIDER NIF]` — tax ID
- `[PRIVACY CONTACT]` — e.g. `privacy@theaumol.com` (create the mailbox)
- `[SECURITY CONTACT]` — e.g. `security@theaumol.com`
- `[DPO]` — a DPO is **not** mandatory here (no large-scale special-category
  or systematic-monitoring processing), but name a responsible person
- `[GOVERNING LAW]` — proposed: Spain, courts of Barcelona

## The data-protection shape (established, see docs the rest of Phase 0)

- **Customer = controller.** They decide what project/financial/HR data goes
  into their instance and why.
- **Ops (the provider) = processor.** Hosts and operates the instance; acts
  only on the customer's documented instructions (the DPA + the product's
  configuration).
- **Identity data in the shared Zitadel broker** — email, display name, IdP
  subject id, MFA state — is the one grey area. Ops decides that
  infrastructure, so Ops is likely **controller** for that limited account
  data. The privacy policy carries this note; confirm the characterisation
  with the lawyer.
- **On-prem deployments** (if ever): Ops is a **software vendor**, not a
  processor — no DPA, the customer runs everything. Out of scope for these
  SaaS documents.

## Sequence before the first paying customer

1. Fill the placeholders; create `privacy@` / `security@` mailboxes.
2. Decide pricing ([pricing-v1.md](pricing-v1.md)).
3. Publish `subprocessors.md` and the privacy policy at stable URLs
   (`theaumol.com/legal/...`).
4. Lawyer review of `dpa.md`, `privacy-policy.md`, `terms-of-service.md` —
   one engagement, all three together, localised for Spain / AEPD.
5. Adopt `ropa.md` and `breach-response.md` internally (they don't need
   external review, but the lawyer can sanity-check the breach clock).
6. Update `docs/phase-0-issues.md` §I and the §J gate.

## Keeping it current

- **subprocessors.md** — update on any change to hosting, email, or a new
  third party that touches customer data; the DPA requires notice to
  customers before adding one.
- **ropa.md** — review on any new data flow or processing purpose.
- **security-overview.md** — review when the architecture changes.
