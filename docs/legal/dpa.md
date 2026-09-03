# Data Processing Agreement (template)

> ⚠ **LAWYER REVIEW REQUIRED.** This is a working template covering the GDPR
> Art. 28(3) mandatory elements. A Spanish data-protection lawyer must review
> and adapt it — particularly the sub-processor consent model, audit rights,
> international-transfer clauses, and how it plugs into the main subscription
> agreement. Bracketed `[ ]` items are choices.

---

**Data Processing Agreement**

This DPA forms part of the Agreement between **[PROVIDER LEGAL NAME]**
("Processor") and the customer identified in the order form ("Controller")
for the provision of the Ops service ("Service").

## 1. Definitions

"GDPR" means Regulation (EU) 2016/679. "Personal Data", "processing",
"controller", "processor", "data subject", "personal data breach" and
"supervisory authority" have the meanings in the GDPR. "Applicable Data
Protection Law" means the GDPR and Spanish Organic Law 3/2018 (LOPDGDD) and
implementing rules. "Sub-processor" means any processor engaged by the
Processor to process Personal Data under this DPA.

## 2. Roles and scope

2.1 The Controller is the controller and the Processor is the processor of
the Personal Data processed to provide the Service, as described in
**Annex I**.

2.2 The Processor processes Personal Data only on the Controller's documented
instructions, including regarding transfers, unless required otherwise by EU
or Member State law (in which case the Processor informs the Controller
before processing, unless that law prohibits it on important grounds of
public interest).

2.3 The Controller's instructions are: (a) this DPA and the Agreement;
(b) configuration and use of the Service through its documented features;
(c) any further written instructions the parties agree. The Processor informs
the Controller if, in its opinion, an instruction infringes Applicable Data
Protection Law.

2.4 The Controller warrants it has a lawful basis for the processing and for
disclosing the Personal Data to the Processor, and that its instructions
comply with Applicable Data Protection Law.

## 3. Confidentiality

The Processor ensures that persons authorised to process the Personal Data
are bound by confidentiality obligations and process the data only as
instructed.

## 4. Security (Art. 32)

4.1 The Processor implements appropriate technical and organisational
measures, described in **Annex II**, taking account of the state of the art,
costs, and the nature, scope, context and purposes of processing and the
risks to data subjects.

4.2 The Processor may update the measures provided the level of protection is
not reduced.

## 5. Sub-processors (Art. 28(2), 28(4))

5.1 The Controller gives **general authorisation** for the Processor to
engage the Sub-processors listed at **[subprocessors URL]** as at the
effective date.

5.2 The Processor gives the Controller **at least 30 days'** prior notice of
any intended addition or replacement of a Sub-processor [via email to the
account contact / the subprocessors page + status feed]. The Controller may
object on reasonable data-protection grounds within that period. If the
parties cannot resolve the objection, the Controller may terminate the
affected part of the Service [and receive a pro-rata refund of prepaid fees].

5.3 The Processor imposes on each Sub-processor, by written contract,
data-protection obligations no less protective than this DPA, and remains
fully liable to the Controller for the Sub-processor's performance.

## 6. Data subject rights (Art. 28(3)(e))

Taking account of the nature of the processing, the Processor assists the
Controller by appropriate technical and organisational measures, insofar as
possible, to respond to data subject requests (access, rectification,
erasure, restriction, portability, objection). Where a data subject contacts
the Processor directly, the Processor forwards the request to the Controller
and does not respond itself except to acknowledge. Self-service export and
deletion features in the Service satisfy this obligation for most requests.

## 7. Assistance to the Controller (Art. 28(3)(f))

The Processor assists the Controller in ensuring compliance with Art. 32–36
(security, breach notification, data protection impact assessments, prior
consultation), taking into account the nature of processing and the
information available to the Processor.

## 8. Personal data breach (Art. 33)

8.1 The Processor notifies the Controller **without undue delay, and in any
event within 24 hours**, after becoming aware of a personal data breach
affecting the Controller's Personal Data.

8.2 The notification includes, to the extent known: the nature of the breach;
categories and approximate number of data subjects and records concerned;
the likely consequences; the measures taken or proposed; and a contact point.
The Processor provides further information as it becomes available.

8.3 The Processor does not notify the supervisory authority or data subjects
on the Controller's behalf unless instructed in writing.

## 9. Return and deletion (Art. 28(3)(g))

On termination of the Service, the Processor, at the Controller's choice:
(a) makes the Personal Data available for export in a commonly used format
for [30] days; then (b) deletes the Personal Data from active systems within
[30] days and from backups within the backup retention cycle (currently [31]
days), unless EU or Member State law requires storage. The Processor confirms
deletion in writing on request.

## 10. Audit (Art. 28(3)(h))

10.1 The Processor makes available to the Controller information necessary to
demonstrate compliance with Art. 28, including this DPA, the Security
Overview, the sub-processor list, and [most recent penetration test summary /
compliance attestations, if any].

10.2 The Controller may audit no more than **once per 12 months** (or after a
breach affecting its data), on [30] days' written notice, during business
hours, without disrupting the Processor's operations, subject to
confidentiality. The Controller bears its own costs; the Processor bears its
own unless the audit reveals material non-compliance. On-site audits of
shared infrastructure may be satisfied by the Processor's documentation and
written responses.

## 11. International transfers

The Processor does not transfer Personal Data outside the EEA except as
disclosed in the sub-processor list. Where a Sub-processor is established
outside the EEA or processing occurs outside the EEA, the transfer is
governed by an adequacy decision or the EU **Standard Contractual Clauses**
with supplementary measures as needed.

## 12. Liability; order of precedence

Liability under this DPA is subject to the limitations and exclusions in the
Agreement. If there is a conflict between this DPA and the Agreement on
data-protection matters, this DPA prevails.

## 13. Governing law

[Spain; courts of Barcelona] — to match the Agreement.

---

## Annex I — Description of processing

| | |
|---|---|
| Subject matter | Provision of the Ops project-lifecycle and invoicing SaaS |
| Duration | The term of the Agreement, plus the return/deletion period |
| Nature and purpose | Hosting and operating the Controller's dedicated instance; brokered authentication; transactional email; backup; support |
| Types of Personal Data | Identification and contact data (names, work email, phone, role); project and resourcing data; calendar/time data; invoicing and payment data; free-text notes; documents uploaded by the Controller's users; authentication data (email, IdP subject id, MFA status, sign-in timestamps) |
| Categories of data subjects | The Controller's personnel; the Controller's clients and project contacts; invoice recipients |
| Special categories | None. The Controller undertakes not to enter Art. 9 data into free-text fields. |
| Frequency | Continuous, for the term |
| Sub-processors | See **[subprocessors URL]** |

## Annex II — Technical and organisational measures

Per the Security Overview ([security-overview.md](security-overview.md)),
which is incorporated by reference and kept current:

- Single-tenant isolation: dedicated process, database, and hostname per
  Controller; per-database scoped roles.
- Encryption in transit (TLS 1.2+); encryption at rest (provider AES-XTS);
  client-side-encrypted off-site backups.
- Key-based SSH administration; database not exposed to the internet; host
  firewall default-deny; fail2ban.
- Least-privilege access; access limited to named individuals; access logged.
- Automated security patching; secrets excluded from source control.
- Nightly backups; documented and tested restore; RPO ≤ 24h.
- Breach response procedure with a 24-hour controller-notification target.

## Annex III — Sub-processor list

Incorporated by reference from **[subprocessors URL]** (see
[subprocessors.md](subprocessors.md)).
