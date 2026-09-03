# Pricing v1 — proposal

> **Your decision.** This lays out a structure and the reasoning; you set the
> actual numbers. Write the final version down and put it behind the sales
> conversation (not necessarily a public page yet).

## Shape: flat tiers by headcount band

Not per-seat metering. Reasons:

- The customers are 4–5 to 20+ people; a handful of bands covers everyone.
- Flat pricing is predictable for the customer and trivial to bill (one
  annual invoice), which matters when you're the whole billing department.
- Per-seat invites seat-counting disputes and mid-term true-ups you don't
  want to administer yet.

## Cost floor (so you know the margin)

Per instance, roughly: a share of one IONOS VPS (~€15–25/mo for the box,
10–20 instances on it) + backup storage (cents) + your time. Marginal infra
cost per customer is **~€2–5/mo**. Pricing is therefore **value-based**, not
cost-plus — the tool replaces spreadsheets / a manual invoicing process and
should be priced against that, not against the server bill.

## Proposed bands

| tier | users | monthly (billed annually) | monthly (billed monthly) | notes |
|---|---|---|---|---|
| **Starter** | up to 5 | € [99] | € [119] | full product; email support |
| **Team** | up to 15 | € [199] | € [239] | + priority support |
| **Business** | up to 30 | € [349] | € [419] | + onboarding assistance, custom entity/invoice setup |
| **Enterprise / on-prem** | 30+ or self-hosted | custom | — | signed order form; on-prem = licence + support, not SaaS |

Placeholders in `[ ]`. Anchoring thoughts if you want a starting point:
- €99 Starter ≈ €20/user at 5 users — defensible for a vertical tool that
  does project tracking **and** compliant invoicing.
- ~2x step between tiers keeps the ladder simple and nudges growing
  customers up.
- Annual ≈ 10–15% cheaper than monthly to pull cash forward.

## What's included in every tier

- Dedicated instance, your subdomain, EU hosting.
- SSO (Microsoft / Google) or email + MFA.
- Nightly encrypted backups, the DPA, the sub-processor list.
- Product updates.

## Add-ons / not included (decide later)

- Data migration from the customer's existing system — one-off fee.
- A custom domain (`ops.customer.com` instead of `customer.ops.theaumol.com`)
  — small setup fee, needs a per-customer cert.
- Sandbox / test instance alongside production.
- On-prem: separate licence + support contract; scope per deal.

## Discounts

- [Founding customers: X% off for life, in exchange for a reference / logo.]
- [Non-profit / academic: X%.]  (Relevant if the customer base skews toward
  tech-transfer offices and university spin-outs.)

## Mechanics

- Currency: EUR. Prices exclude VAT/IGIC.
- Billing: annual invoice, [net 15]. Monthly option at the higher rate.
- Trial: [14–30 days on a real provisioned instance, or a shared demo].
- Price changes: only at renewal, [60] days' notice.

## Revisit

After 3–5 customers: check whether the bands match real headcounts, whether
anyone's pushing the 30-user ceiling, and whether Starter is leaving money on
the table. Adjust v2.
