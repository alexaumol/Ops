# Email (0G)

Two senders, deliberately separate:

| sender | domain / host | carries | auth |
|---|---|---|---|
| **Microsoft 365** | MX `theaumol-com.mail.protection.outlook.com` | human mailboxes (`aat@`, `noreply@` mailbox) | apex SPF `include:spf.protection.outlook.com`; M365 DKIM |
| **Resend** | return-path `send.theaumol.com` (SES eu-west-1 under the hood) | Zitadel verification codes; control-plane alerts | `send.theaumol.com` SPF `include:amazonses.com`; DKIM `resend._domainkey.theaumol.com` |
| **per-entity SMTP / Graph** | the customer's own mail server | **invoice mail** (see below) | the customer's own SPF/DKIM/DMARC |

## DNS — current state

```
theaumol.com            MX     0 theaumol-com.mail.protection.outlook.com
theaumol.com            TXT    "v=spf1 include:spf.protection.outlook.com ~all"
_dmarc.theaumol.com     TXT    "v=DMARC1; p=none; rua=mailto:<reports>; fo=1; adkim=r; aspf=r"
send.theaumol.com       TXT    "v=spf1 include:amazonses.com ~all"
send.theaumol.com       MX     10 feedback-smtp.eu-west-1.amazonses.com
resend._domainkey       TXT    "p=<RSA key>"                 # Resend DKIM
selector1._domainkey    CNAME  selector1-theaumol-com._domainkey.<tenant>.onmicrosoft.com   # M365 DKIM
selector2._domainkey    CNAME  selector2-...                                                # M365 DKIM
```

### Alignment — why each sender passes DMARC

- **M365** — From `@theaumol.com`, MX `@theaumol.com` → SPF aligned (relaxed). DKIM aligned once selector1/2 are enabled.
- **Resend** — From `noreply@theaumol.com`. SPF authenticates `send.theaumol.com` (not aligned to the From org domain under strict, **aligned under relaxed** — same org domain). DKIM signs `d=theaumol.com` via `resend._domainkey` → **DKIM aligned**. DMARC needs only one; DKIM alignment carries it.
- **Zitadel** sends `From: noreply@theaumol.com` — confirmed. Do not change it to a `resend.dev` address or alignment breaks.

## DMARC ramp

Start: `p=none` with a working `rua=` (a digest service — Postmark DMARC, dmarcian, URIports — not a raw mailbox; aggregate reports are daily XML from every receiver).

1. **`p=none`** — 2–4 weeks. Confirm from the reports: only M365 + Resend send as `theaumol.com`, and both pass alignment.
2. **`p=quarantine; pct=25`** → `pct=100` over ~2 weeks.
3. **`p=reject`**.

Pre-req for step 2: **M365 DKIM enabled** (Defender portal → Email authentication settings → DKIM → `theaumol.com` → Enable, then add the two CNAMEs).

## Invoice mail

**Per-entity SMTP is the default.** Each `entity` row carries:

- `mailtransport` — `'smtp'` | `'graph'` | `NULL` (NULL = server default)
- `mailsender` — the From mailbox; NULL falls back to the entity's invoicing address

(`server/lib/entitySchema.js`, surfaced in Settings → Entities; consumed by `server/routes/invoicing.js` → `invoiceSenderFor()` / `invoiceMailChannel()`.)

Rationale: an invoice should come **from the customer's own domain** — better deliverability, the customer's brand, and replies go to the customer, not to us. Each customer configures their own SMTP host/creds (or Microsoft Graph) per legal entity, and manages the SPF/DKIM/DMARC for that domain themselves.

Resend is **not** in the invoice path. If a future customer has no mail infrastructure at all, the fallback would be a dedicated `invoices@<slug>.ops.theaumol.com` sender with its own SPF/DKIM under the `ops.theaumol.com` zone — not built yet, add only on demand.

`DEFAULT_INVOICE_SENDER` (`GRAPH_MAIL_SENDER` / `SMTP_FROM` env) is the last-resort From when an entity has neither `mailsender` nor an invoicing address — keep it empty on customer instances so a misconfigured entity fails loudly instead of sending as the wrong identity.

## Monitoring

- **Resend dashboard** — bounces / complaints / delivery. Turn on email alerts now; a webhook to the control plane is a Phase 1 item.
- **DMARC digests** — weekly, from the `rua` service.
- **Deliverability score** — [mail-tester.com](https://www.mail-tester.com): trigger a Zitadel code to its address, target 9–10/10. Re-run after the M365 DKIM change.

## Per-customer checklist (for the onboarding runbook)

When a customer will send invoices from their own domain `example.com`:

1. Customer creates an SMTP credential (or an app registration for Graph) on their side.
2. In Ops: Settings → Entities → set `mailtransport` + `mailsender` (`invoices@example.com`) for each legal entity.
3. Customer confirms `example.com` has SPF authorising that host and, ideally, DKIM + DMARC.
4. Send one test invoice, check headers for `dkim=pass` / `spf=pass` / `dmarc=pass`.
