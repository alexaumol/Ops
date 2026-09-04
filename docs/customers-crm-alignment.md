# Julia's CRM brief vs. Ops — alignment

Status: **decided** (2026-09-04 — Julia answered all 7 questions in §4.3; see §4.4) · Owner: Alex
Inputs:
- Customer brief: *"Stakeholder CRM, Tasks & Programme Operations Platform —
  Business Requirements | UX Concept"*, v1.0, 1 Sep 2026 (AI-drafted, business-led,
  from Julia).
- Our plan: [`docs/customers-crm-roadmap.md`](customers-crm-roadmap.md).
- Current code: [`server/routes/businessPartners.js`](../server/routes/businessPartners.js),
  [`public/js/projects.js`](../public/js/projects.js), the `businesspartners` /
  `contacts` / `projects` / `projectstatus` schema.

---

## 1 · The short version

**Julia's Phase 1 is, structurally, the sales CRM we want** — organizations,
people, a communication timeline, relationship status, and a task manager. The
vocabulary is "stakeholders / partners / sponsors / advocacy", not "sales /
deals / quota", but the data model underneath is the same one. Building her
Phase 1 *is* building our primary goal.

Where it diverges:

| Julia wants | Reality for our primary (sales) goal |
|---|---|
| **Task Manager as a top-level module** spanning tasks, cohorts, projects, people | We have no task entity at all. Worth building — but as a general module, not nested under CRM. |
| **Organization Relationship Map** (her "signature feature") — drag decision-roles, reporting lines, known-vs-unknown-person placeholders | Genuinely novel, no analog in Ops. High effort, custom canvas UI. Not a sales-CRM must-have; it's *her* differentiator. Her Phase 2. |
| **Programme Operations** — applications, cohorts, participant→alumnus lifecycle, Patient Expert Network, health-data | A separate module the size of the CRM itself. Her Phase 3, explicitly "not first priority". |
| **Disease-area taxonomy**, consent tracking, field-level access to health data | Domain-specific to patient work. The generic hooks (a taxonomy table, a consent flag, row-level visibility) are cheap; the patient-specific content is not our primary goal. |
| **Microsoft 365 calendar / To Do / Planner** creation from records | We have Entra **sign-in only** — no Graph calendar/mail scopes. New integration, and it collides with the Phase 0 identity migration (Zitadel). Her Phase 2. |
| A **simple relationship pipeline** (list ⇄ kanban) — including deals that aren't yet a project | The Projects board (`Lead · Oferta · Guanyat · …`) covers deals once they're real; a small `crm_opportunities` stage now covers the pre-project part Julia confirmed she needs (§3.5, §4.4 Q2). |

**"Does patient recruitment fit?"** — The *foundation* fits cleanly if we make
one decision now (§4.1: promote people to first-class records). The Programme
Operations *module* does not come for free — it's a Phase 3 project of its own.
Nothing in Julia's brief forces an architecture we'd regret, provided we take
that one decision.

---

## 2 · Terminology map

Her brief and our system name the same things differently. One glossary avoids
cross-talk:

| Julia's term | Ops term | Notes |
|---|---|---|
| Stakeholder / Organization | Business partner → **Customers & partners** (module), one *customer/partner* record | Same record. Her "several tags, one primary category" = our `roles[]` + primary category. |
| Sponsor / Industry, Patient Org, HTA Body, Academic, Expert, Healthcare | `roles[]` values + category card | Structured list, config-driven per instance. |
| Person / Contact / Participant | `contacts` — **to be promoted to first-class** (§4.1) | Today a contact only exists *inside* one partner. Julia needs standalone people. |
| Relationship status (New / In Discussion / Active Partner / On Hold / Closed / Former Partner) | `businesspartners.lifecycle_stage` (roadmap C1) | Adjust the vocabulary to hers. |
| Warm / Hot | new `businesspartners.temperature` | She's explicit: keep **separate** from status; only meaningful while "In Discussion". |
| Simple relationship pipeline (kanban) | **`crm_opportunities` (pre-project) → Projects board** (`Lead / Oferta / Guanyat`) as one continuous flow | Projects board already exists in [`projects.js`](../public/js/projects.js); opportunities are the new stage before a project exists — see §3.5. |
| "Guanyat" (Won) | `projectstatus` id 2 | Per Alex: customer accepted project + budget, kick-off imminent. |
| Opportunity | **Two different meanings** — see §3.4, §3.5, §3.7 | Julia's IA also uses "Opportunity" for a *future expert request* (Programme Operations, §3.7) — unrelated to the sales `crm_opportunities` of §3.5. Keep the two apart in naming (`crm_opportunities` vs. a future `expert_requests`). |
| Interaction (email / call / meeting / note / document / completed task) | `crm_activities` (roadmap C2) | Feeds the unified timeline. |
| Task | new `tasks` table + module (§3.1) | |
| Cohort / Application / Participant Profile / Patient Expert Network | none — Programme Operations, new (§3.5) | |

---

## 3 · Section-by-section

Verdict key: **HAVE** (in Ops today) · **PLANNED** (in the roadmap as written) ·
**ADJUST** (planned, but reshape to match Julia) · **NEW** (not planned) ·
**LATER/SECONDARY** (real, but not the primary goal).

### 3.1 · Task Manager (her Module 01)

> One shared task database; list / Kanban / calendar; my vs team tasks;
> reminders and owners; every task stays linked to its source record.
> Fields: Title, Description, Status, Owner, Collaborators, Due date, Reminder,
> Priority, Linked organization/contact/cohort/person, Source interaction,
> Attachments.

- **Ops today:** nothing. No task/todo entity anywhere. (Projects have
  *deliverables*, which are not tasks.)
- **Roadmap:** `crm_tasks`, but scoped to CRM and thinner (no collaborators,
  priority, reminder, source-interaction link).
- **Verdict: ADJUST → build a standalone `tasks` module.** Julia wants tasks on
  cohorts and projects too, and a global "Task Manager" view. A CRM-nested
  table can't serve that. Recommendation:
  - `tasks` table with a polymorphic link (`entity_type`, `entity_id`) so a task
    can attach to a partner, contact, project, cohort, or nothing.
  - `task_collaborators` join; `priority`, `reminder_at`, `source_activityid`.
  - New `server/routes/tasks.js`, a `tasks` module key + page with List / Kanban
    / Calendar views (Kanban reuses the [`projects.js`](../public/js/projects.js)
    board pattern).
  - This also finally gives Projects a real task surface — a win beyond CRM.
- **Effort:** medium. **Belongs in Phase 1** alongside Customers & partners.

### 3.2 · Stakeholder List — categories, search, filters (her Modules 02, 04, 05)

> Category landing cards (6) with counts, not one master table. Inside a
> category: searchable list, switchable to a kanban. Filters: category, disease
> area, country, region, city, geographic scope, relationship status, warm/hot,
> owner, next-action date.

- **Ops today:** BP list is name-search only, single flat table
  ([`businessPartners.js:71`](../server/routes/businessPartners.js)). `countries`
  lookup exists; `addresses` has city/state.
- **Roadmap:** C1 adds owner + stage + role columns and some quick filters;
  `crm_tags`; `industry` as a free field.
- **Verdict: ADJUST.**
  - **Category cards + counts** — `roles[]` gets a designated *primary* category;
    landing page shows one card per category with `count` / `active count`.
    Repurpose/extend `companytypes` or a new `crm_categories` lookup.
  - **Filters** — build the full set. `owner`, `lifecycle_stage`, `temperature`,
    `countryid` are columns; `disease area` / `scope` / `region` need §3.3.
  - **List ⇄ Kanban toggle on relationship status** — small board, reuse the
    projects board. NB this is the *relationship* kanban (New→Active Partner),
    distinct from the *deal* kanban (=projects Lead/Oferta/Guanyat).
  - **"An organization may have several tags but one primary category"** and
    **"operational suppliers stay secondary tags"** → exactly the `roles[]` +
    primary-category + `crm_tags` model. Aligned.

### 3.3 · Stakeholder data — taxonomy & lifecycle (her Module 06)

> Disease area: hierarchical, multi-select taxonomy + one optional free tag.
> Geography: country / region / city / scope (Local…Global).
> Relationship lifecycle: 6 stages + separate Warm/Hot; store date + reason for
> Closed / Former Partner; preserve status history.

- **Disease-area taxonomy** — **NEW / LATER.** This is patient-domain content,
  not sales. Cheap generic version: a `crm_focus_areas` self-referential
  taxonomy table (hierarchical, multi-select via a join, plus a free-text
  fallback tag), seeded per instance — "sectors" for a sales instance, "disease
  areas" for Julia's. Config-driven, not hardcoded.
- **Geography** — **ADJUST (small).** Have country + city. Add
  `businesspartners.geo_scope` enum and an optional `region` field (or lean on
  `addresses.state`). Low effort.
- **Relationship lifecycle** — **ADJUST.** Roadmap already has
  `lifecycle_stage` + `businesspartner_stage_history`. Changes:
  - vocabulary → `new | in_discussion | active_partner | on_hold | closed |
    former_partner`
  - add `temperature` (`warm | hot | null`)
  - `stage_history` already carries `changedat` + `reason` — matches her "date +
    short reason" and "preserve status history". **Aligned.**

### 3.4 · Organization & contact records (her Modules 07, 08)

> Organization page = operational centre: contacts, communication timeline, next
> actions, documents, relationship map.
> Contact = linked to an org but keeps its own history, decision role, influence,
> reports-to, relationship ("supportive / potential champion"), last interaction,
> next step.
> Interaction entry: date, participants, author, summary, attachments, agreed
> next step, linked records. Manual logging now; M365 auto-capture later; after a
> meeting, prompt for notes + next action.

- **Contacts list / notes / history / linked projects** — **HAVE** (BP detail
  modal today).
- **Unified communication timeline** — **PLANNED** (roadmap C2 `crm_activities`
  + UNION view). **ADJUST:** add `participants` (M2M to contacts + employees),
  `attachments`, `agreed_next_step`, and the polymorphic "linked records".
- **Documents on the record** — **PLANNED** (roadmap C5 `crm_attachments`,
  reusing the expenses upload mechanism).
- **"Next actions" panel** — **PLANNED** = the `tasks` module filtered to this
  record (§3.1).
- **Contact enrichment** — **ADJUST.** Roadmap C1 adds is_primary /
  is_decision_maker / linkedin / DNC. Add Julia's: `decision_role` enum
  (influencer / decision-maker / gatekeeper / user / unknown), `influence`
  level, `champion_status`, `reports_to_contactid` (self-FK — this is what
  powers the relationship map).
- **Post-meeting prompt** ("log a meeting → prompt to add notes + create the
  next action") — **NEW**, small UX addition on top of C2.
- **Relationship map** — **NEW**, see §3.6.

### 3.5 · The deal / sales pipeline  *(revised — see §4.4 Q2)*

- Alex, first pass: *"There is not a real sales pipeline. Project status `Lead`
  (and maybe `Oferta`) is the best effort in Ops."* → proposed dropping a
  separate opportunities entity and treating Lead/Oferta/Guanyat projects as
  the whole pipeline.
- Julia's answer to Q2: **she needs to track potential opportunities that
  aren't yet a project at all** — first contact, a possible fit, before there's
  anything resembling a project (a name, a scope, a number). That's a real gap
  a project-status-only pipeline can't cover: creating a placeholder `projects`
  row just to represent "we talked, might be something here" would pollute the
  Projects module with things that are 5:1 or worse likely to go nowhere.
- **Verdict: bring back a lightweight `crm_opportunities`, but as a genuinely
  pre-project stage — not a parallel deal-tracking system.**
  - `crm_opportunities`: `businesspartnerid`, `name`, `stage` (small, linear:
    `identified → qualifying → proposal_pending → converted / lost`),
    `estimated_value numeric(14,2)`, `currencyid` → **`invoicecurrencies`**
    (per Alex), `owner_employeeid`, `expected_close`, `source`, `lost_reason`,
    `projectid` (nullable — set on conversion).
  - **"Convert to project"** is the one action that matters: creates a
    `projects` row at status `Lead` (or `Oferta` if a quote is already in
    hand), copies name/value/currency, links back via `projectid`, and the
    opportunity's stage flips to `converted`. From that point on the **project**
    is the record of truth and rides the existing Lead → Oferta → Guanyat board
    — no duplicate tracking of the same deal in two places.
  - Pipeline view = **one continuous board**: opportunity stages feed left of
    the existing Projects columns; dragging past "Proposal pending" prompts the
    conversion action instead of just changing a status.
  - A lost pre-project opportunity → `stage = lost` + `lost_reason`, no
    project ever created. A lost *converted* deal still moves the project to
    `Cancelled` as before.
  - Weighted forecast = `sum(estimated_value × stage weight)` across
    opportunities **and** Lead/Oferta/Guanyat projects, by owner / month —
    the two feed one number now.
  - This restores most of the original roadmap's Phase C3 shape (see
    [`customers-crm-roadmap.md`](customers-crm-roadmap.md) §3 C3), scoped down
    to the linear 3-stage pre-project funnel Julia actually needs rather than a
    full configurable pipeline-stage system.

### 3.6 · Organization Relationship Map (her Module 09 — "signature feature")

> A canvas: drag decision-roles, connect reporting lines, cards for known people
> and dashed cards for "role known, person unknown". Research notes/tasks on
> unknown roles. Convert a placeholder into a real contact without losing
> position, links or notes.

- **Ops today / roadmap:** nothing remotely like it.
- **Verdict: NEW, and it's the single largest custom build in the brief.**
  - Needs: `reports_to_contactid` on contacts (§3.4); a `crm_role_placeholders`
    table (org, role title, importance, research note, optional resolved
    contactid); a canvas/graph UI (node positions, edges) — no existing pattern
    in this codebase, which is deliberately framework-free vanilla JS.
  - It is **not required for a working sales CRM.** It is Julia's differentiator
    for stakeholder mapping.
  - Recommendation: **Julia's Phase 2.** Keep the data hooks (`reports_to`,
    placeholders) in mind during Phase 1 so we don't block it, but don't build
    the canvas until the core is in daily use.

### 3.7 · Programme Operations (her Modules 11–13)

> Applications (review candidates, decisions), Cohorts (per-cohort page:
> schedule, attendance, docs, notes), Participant Profiles (one record
> applicant→participant→alumnus), Patient Expert Network (searchable
> consent-based alumni network for future HTA/advisory/speaking requests).
> Participant lifecycle: Applied → Under Review → Accepted → Docs Pending →
> Enrolled → Completed (+ Waitlisted / Declined / Withdrawn).
> "Opportunity" in her IA = a *future expert request*, matched against profiles.

- **Ops today:** nothing. There is a **"Patient programme CRM" tile already
  stubbed** as "Coming soon" in [`welcome.html:175`](../public/welcome.html) —
  but its blurb is *patient-support* (enrolment, outcomes). Julia's is
  *recruitment + expert network*. Different thing; the tile name will need to
  disambiguate.
- **Roadmap:** nothing (the roadmap is sales-only).
- **Verdict: LATER / SECONDARY — a separate module, Phase 3, comparable in size
  to the CRM.** What makes it *possible without a rewrite later*:
  - **§4.1 — people as first-class records.** A participant is a person with no
    employer org, whose profile persists across cohorts. If `contacts` stays a
    child of `businesspartners`, this needs a migration later that touches every
    contact query. Decide now.
  - Consent + health data → `people.consent_future_contact`,
    `people.consent_recorded_at`, and **row/field-level visibility** (Ops only
    has module-level permissions today — a real gap, §3.9).
  - Cohorts / applications / attendance are then **additive tables** hanging off
    `people` — no disruption to the CRM.
- Her "expert request → filter profiles → check consent → contact" workflow is a
  saved-search over `people` with consent gating. Reuses `crm_saved_segments`.

### 3.8 · Home dashboard (her Module 03)

> Three large module cards + small summary counts + "my next actions" + a
> "relationship snapshot" (active partners / hot discussions / overdue
> follow-ups). "No dense dashboard."

- **Ops today:** [`welcome.html`](../public/welcome.html) is a plain module menu
  (cards, no counts).
- **Verdict: ADJUST (moderate).** Add per-module summary counts, a "my open /
  overdue tasks" list, and a few relationship KPIs. Fits the existing card grid;
  no new concepts. Do it once `tasks` + `lifecycle_stage` exist so the numbers
  are real.

### 3.9 · Permissions & safeguards (her Module 15)

> Role-based access, "especially for health-related and consent information".
> Preserve history. Avoid duplicates. Privacy review before launch.

- **Per-owner visibility** — Alex: *on by default, with a Settings override.*
  **ADJUST roadmap §6:** `businesspartners.owner_employeeid` drives a
  "see only my accounts" default; an `appconfig` flag (`crm.visibility = all |
  own`) flips the whole instance to all-visible. Admins always see all.
- **Field-level / health-data access** — **NEW / GAP.** Ops permissions are
  module-level ([`permissions.js`](../server/lib/permissions.js) `MODULE_KEYS`).
  Julia's Programme Operations needs "sensitive fields visible only where
  needed". That's row+field-level authz — a design task in its own right, tied
  to Phase 3, and overlapping the Phase 0 legal pack (DPA, privacy policy —
  [`docs/phase-0-issues.md`](phase-0-issues.md) workstream I).
- **History preservation** — **HAVE / ALIGNED.** `projectstatushistory`,
  `businesspartnerchangelog` today; roadmap adds `businesspartner_stage_history`.
- **De-duplication** — **PLANNED** (roadmap C4 merge/dedupe).
- **Privacy review before launch** — a gate, not a feature. Track it with the
  Phase 0 legal work.

### 3.10 · Microsoft 365 integration (her Module 14)

> Create an Outlook calendar event from an org / contact / task, prefill
> attendees, keep the event + notes + follow-up task linked to the CRM record.
> Consider Microsoft To Do / Planner for task sync.

- **Ops today:** Entra ID **sign-in only** (MSAL, token verified server-side).
  No Graph API scopes, no calendar/mail access.
- **Verdict: NEW / LATER.** Needs Graph `Calendars.ReadWrite` (+ maybe
  `Tasks.ReadWrite`), incremental consent, a token path for Graph calls.
  **Collides with Phase 0A** (auth moving to a Zitadel broker — see
  [`docs/phase-0-issues.md`](phase-0-issues.md#a--identity-broker) — Graph
  tokens would need to survive that change). Her Phase 2. Manual timeline
  logging (C2) covers the need until then; "log a meeting" + reminder tasks give
  ~80% of the value with zero integration.

---

## 4 · Decisions to lock now

### 4.1 · Promote people to first-class records  *(the one that matters)*

Today `contacts.businesspartnerid` makes a contact a child of exactly one
partner. Julia needs:
- people who belong to **no** organization (independent participants),
- one profile that persists **applicant → participant → alumnus** across cohorts,
- people linked to **several** organizations over time.

**Decision:** make the person the primary entity now.
- `contacts` becomes standalone (`businesspartnerid` nullable), **or** a
  `contact_org_roles` join (person ↔ org, with role + date range).
- Every existing contact query in [`businessPartners.js`](../server/routes/businessPartners.js)
  updated; migration back-fills one `contact_org_roles` row per current contact.
- Do this in **Phase C1**. Deferring it means re-plumbing contacts after the CRM
  is live and after Programme Operations assumes the new shape.

### 4.2 · Confirmed decisions from Alex  *(first pass — see §4.4 for what Julia's answers changed)*

| Question | Decision | Roadmap change |
|---|---|---|
| Module name | ~~Customer/Partners~~ → **Customers & partners** (§4.4 Q1) | rename target `customers-partners`, i18n root `customersPartners.*` |
| Sales-opportunity entity | ~~None~~ → **`crm_opportunities`, pre-project only** (§4.4 Q2) | Phase C3 **restored, reshaped** — see §3.5 |
| Opportunity currency | **`invoicecurrencies`** table | §3 C3 SQL, unchanged |
| i18n | **Full key rename** (most maintainable) | §4 checklist |
| Per-owner visibility | **On by default + Settings override** (`appconfig` flag) | §6 — enforced from C1, not deferred |

### 4.3 · Questions sent to Julia

1. **Naming.** We'll call it **Customer/Partners** (it also holds suppliers,
   academics, sponsors — not only customers). OK?
2. **Pipeline.** We won't build a separate "deals" list. A deal in flight = a
   project at status *Lead / Oferta / Guanyat*, which we already track on the
   Projects board. The CRM will show those per partner and as a filtered
   pipeline view. Does that match how you think about opportunities?
3. **Task Manager scope.** We'll build it as a platform-wide module (tasks on
   partners, contacts, projects, and later cohorts), not a CRM-only feature.
   Agreed?
4. **Relationship Map.** Confirmed as your Phase 2 — we'll keep the data model
   ready for it but build the core list/record/timeline/tasks first. OK to
   sequence it that way?
5. **Programme Operations & Patient Expert Network.** These are a distinct Phase
   3 module. For Phase 1 we only commit to making *people* first-class so the
   later module drops in cleanly. Is there any Phase-1 patient-recruitment need
   that can't wait? (e.g. a first cohort starting before Phase 3.)
6. **M365 calendar.** Deferred to Phase 2 and dependent on our identity work.
   Phase 1 gives you manual meeting logging + reminder tasks. Acceptable for the
   first cohorts?
7. **Health data.** Field-level access control is new work we'd scope with Phase
   3 and the DPA/privacy review. Confirm no special-category (health) data is
   entered before that lands.

### 4.4 · Julia's answers (2026-09-04) — final decisions

| # | Answer | Effect |
|---|---|---|
| Q1 Naming | *"Customers & partners" is fine.* Spanish: **"Clientes y colaboradores"** — deliberately generic so it fits everybody. | Module display name **Customers & partners** / **Clientes y colaboradores**. Slug `customers-partners`, i18n root `customersPartners.*`. Supersedes the earlier "Customer/Partners" working name everywhere in this doc and the roadmap. |
| Q2 Pipeline | *"I need to track potential opportunities that aren't yet a project at all."* | **Reverses the first-pass decision.** `crm_opportunities` is back, scoped to the pre-project funnel only (§3.5, revised). Roadmap Phase C3 restored in reshaped form. |
| Q3 Task Manager scope | Agreed. | Platform-wide `tasks` module confirmed, Phase 1 (§3.1). |
| Q4 Relationship Map sequencing | Agreed. | Phase 2 confirmed; data hooks (`reports_to_contactid`, placeholders) kept in mind during Phase 1 (§3.6). |
| Q5 Programme Operations | Agreed with the suggestion; specific needs can wait to Phase 2 *(Julia's Phase numbering — i.e. after the CRM core, before full build-out)*. | Phase 1 commitment stays limited to §4.1 (first-class people); no cohort/application work pulled forward. |
| Q6 M365 calendar | *"Enough."* | Manual meeting logging + reminder tasks confirmed sufficient through Phase 1; Graph calendar integration stays Phase 2, still gated on the identity migration (§3.10). |
| Q7 Health data | Confirmed — no special-category data before field-level access control lands. | No interim safeguard needed in Phase 1; field-level authz work stays scheduled with Phase 3 / the DPA review (§3.9). |

**Net change to lock in:** only Q1 (naming) and Q2 (opportunities restored) alter
the plan. Q3–Q7 confirm the first pass as written. §5 below reflects the final
state.

---

## 5 · Net effect on the roadmap  *(final, post-4.4)*

| Roadmap phase (as written) | After this alignment |
|---|---|
| C0 decisions | Add §4.1 (first-class people) + §4.2/§4.4 decision tables |
| C1 Customers + fields + 360 | → **Customers & partners** / *Clientes y colaboradores*; add `temperature`, category cards, full filter set, geo scope, first-class people, per-owner visibility + Settings override. Full i18n key rename to `customersPartners.*`. |
| C2 Activities & tasks | **Split**: (a) `crm_activities` + timeline stays here; (b) **`tasks` becomes its own module** with List/Kanban/Calendar, promoted to Phase 1. Add participants / attachments / next-step to activities; collaborators / priority / reminder / source-interaction to tasks. |
| C3 Opportunities & pipeline | **Restored, reshaped** (§4.4 Q2): `crm_opportunities` covers the **pre-project** funnel only (identified → qualifying → proposal pending → converted/lost); `projects.estimated_value` + `currencyid` (`invoicecurrencies`) carry the value once converted; the pipeline view is opportunities + Lead/Oferta/Guanyat projects as one continuous board. |
| C4 Segmentation & data quality | Unchanged. Add `crm_focus_areas` taxonomy (generic; seeded as disease areas for Julia). |
| C5 Comms, dashboards, assistant | Unchanged. Home dashboard enhancement (§3.8) lands here or earlier. M365 calendar added as a flagged, identity-dependent item, confirmed Phase 2 (§4.4 Q6). |
| — | **New: Phase C6 — Relationship Map** (Julia's Phase 2, confirmed §4.4 Q4). |
| — | **New: Phase P (Programme Operations)** — applications, cohorts, participant lifecycle, Patient Expert Network, field-level access. Separate track, depends on §4.1. Julia's Phase 3, confirmed no Phase-1 pull-forward (§4.4 Q5). |
