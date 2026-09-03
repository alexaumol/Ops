# Privacy Policy (skeleton)

> ⚠ **LAWYER REVIEW REQUIRED.** This covers the structure and the Ops-specific
> substance (especially the identity-broker controller note). A lawyer must
> complete the lawful-basis analysis, retention periods, and the AEPD-specific
> wording, and confirm the controller/processor split.

This policy has **two audiences** — keep them distinct or split into two
pages:

1. **Website visitors & prospective customers** — people browsing
   `theaumol.com`, contacting sales. Here [PROVIDER] is the **controller**.
2. **End users of a customer's Ops instance** — for the business data in the
   instance, the **customer is the controller** and this policy points them
   to their employer; for the **authentication account** in the shared
   Zitadel broker, [PROVIDER] is likely the controller.

---

## 1. Who we are

[PROVIDER LEGAL NAME], [PROVIDER ADDRESS], [PROVIDER NIF]. Contact for privacy
matters: **[PRIVACY CONTACT]**. [DPO / responsible person: [NAME].]

## 2. Website visitors and prospects

| what | data | lawful basis | retention |
|---|---|---|---|
| Contact / demo requests | Name, email, company, message | [Pre-contractual steps / legitimate interest] | [24 months after last contact] |
| Website analytics | [Only if used — specify tool, whether cookie-based, IP handling] | [Consent, if non-essential] | [ ] |
| Server logs | IP, request metadata | Legitimate interest (security) | [X days] |

Cookies: [list essential vs non-essential; non-essential require a consent
banner with reject-all as prominent as accept-all — AEPD guidance].

## 3. End users of an Ops instance

### 3a. Business data inside the instance — your employer is the controller

If you use Ops because your employer or organisation subscribes, **they**
decide what personal data goes into the instance and why. For that data,
contact your organisation's privacy contact to exercise your rights. We
process it only as their processor, under a Data Processing Agreement.

### 3b. Your authentication account — we are the controller

To sign you in, we operate a shared identity service (Zitadel). For the
limited account data below, **[PROVIDER] is the controller**:

| data | source | purpose | lawful basis | retention |
|---|---|---|---|---|
| Email address, display name | Your identity provider (Microsoft/Google) or your registration | Authenticating you to your organisation's instance; account security | [Legitimate interest in providing secure access / performance of the contract with your organisation] | Until your organisation removes your access, then deleted within [30] days |
| Identity-provider subject identifier | Your identity provider | Linking your sign-in to your account | as above | as above |
| MFA enrolment (method, not secrets) | Your enrolment | Securing your account | as above | as above |
| Sign-in timestamps, IP at sign-in | Automatic | Security, abuse detection | Legitimate interest (security) | [X days] |

We do **not** receive or store your identity-provider password.

> _Lawyer: confirm whether 3b is [PROVIDER]-as-controller, joint controllership
> with the customer, or processor. The product design — [PROVIDER] chooses and
> runs the broker for its own operational reasons — points to controller for
> this slice, but it is arguable._

## 4. Who we share data with

- **Sub-processors** that help run the service — hosting, backup storage,
  transactional email. Current list: **[subprocessors URL]**. All process
  within the EU.
- **Authorities**, where legally required.
- We do **not** sell personal data or use it for advertising or model
  training.

## 5. International transfers

Customer and account data is hosted in the **EU (Germany)**. Transactional
email is delivered within the **EU (Ireland)**. Where a sub-processor is a
non-EU entity, transfers are covered by **EU Standard Contractual Clauses**.

## 6. Your rights

You have the rights of access, rectification, erasure, restriction,
portability, and objection, and to lodge a complaint with the **Agencia
Española de Protección de Datos** (www.aepd.es). To exercise rights over data
we control, contact **[PRIVACY CONTACT]**. For business data in an instance,
contact the organisation that provides you the account.

## 7. Security

Summarised in our Security Overview: single-tenant isolation, encryption in
transit and at rest, encrypted off-site backups, key-based administrative
access, and a documented breach-response procedure.

## 8. Changes

We post changes here and, for material changes affecting account holders,
notify the subscribing organisations.

_Last updated: [date]. Version: [ ]._
