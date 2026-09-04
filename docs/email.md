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

**Transports are managed in the app — Settings → Email**, not in `.env`. Each
row in `email_transports` is one of:

- **Microsoft Graph** — an app registration (`tenant id` / `client id` /
  `client secret`) with the `Mail.Send` application permission, ideally scoped
  to the sender mailbox by an application access policy.
- **SMTP** — `host` / `port` / `user` / `password` / implicit-TLS flag.

The `client secret` and the SMTP `password` are stored **AES-256-GCM-encrypted**
(`server/lib/secrets.js`, key `APP_ENCRYPTION_KEY` in the instance env — 32 bytes
base64/hex). Rotating that key invalidates every stored secret; back it up with
the DB backup. The API never returns a secret — only a "set / not set" flag —
and updating a transport leaves its secret alone unless you type a new one.

Each `entity` row carries:

- `mail_transport_id` → an `email_transports` row (Settings → Entities →
  "Invoice email" → Transport). `NULL` → the app-level default in `appconfig`
  `email.default_transport_id` (Settings → Email → "Default transport").
- `mailsender` — optional From override; `NULL` → the transport's `from_address`.
- `mailtransport` (`'graph'`/`'smtp'`) — **legacy, no longer read.**

Resolved by `server/lib/emailTransport.js` (`resolveForEntity`), consumed by
`server/routes/invoicing.js`. If neither the entity nor the default names a
transport, the "email invoice" endpoint returns **503** with a clear message —
nothing is sent as the wrong identity.

Rationale: an invoice should come **from the customer's own domain** — better
deliverability, the customer's brand, replies go to the customer. Each customer
configures their own transports per legal entity and manages the
SPF/DKIM/DMARC for that domain.

Resend is **not** in the invoice path. If a future customer has no mail
infrastructure at all, the fallback would be a dedicated
`invoices@<slug>.ops.theaumol.com` sender with its own SPF/DKIM under the
`ops.theaumol.com` zone — not built yet, add only on demand.

### Migrating from the old env vars

The old `GRAPH_MAIL_*` / `SMTP_*` / `GRAPH_MAIL_SENDER` vars are **not**
auto-imported (a secret can't be read back out to seed a row). On each instance:

1. Set `APP_ENCRYPTION_KEY` in the env file, `npm run migrate`, restart.
2. Settings → Email → **+ Add transport** — re-enter the Graph app or SMTP
   account. Use **Send test** to confirm it works.
3. Settings → Email → set the **Default transport** (or assign per entity in
   Settings → Entities).
4. Remove the now-dead `GRAPH_MAIL_*` / `SMTP_*` vars from the env file.

## Monitoring

- **Resend dashboard** — bounces / complaints / delivery. Turn on email alerts now; a webhook to the control plane is a Phase 1 item.
- **DMARC digests** — weekly, from the `rua` service.
- **Deliverability score** — [mail-tester.com](https://www.mail-tester.com): trigger a Zitadel code to its address, target 9–10/10. Re-run after the M365 DKIM change.

## Per-customer checklist (for the onboarding runbook)

When a customer will send invoices from their own domain `example.com`:

1. Customer creates an SMTP credential (or an app registration for Graph) on their side.
2. In Ops: Settings → Email → add the transport, **Send test** to a mailbox you control.
3. Settings → Email → set it as the default, or Settings → Entities → assign it per legal entity (+ `mailsender` `invoices@example.com` if the From should differ from the transport's own).
4. Customer confirms `example.com` has SPF authorising that host and, ideally, DKIM + DMARC.
5. Send one test invoice, check headers for `dkim=pass` / `spf=pass` / `dmarc=pass`.
