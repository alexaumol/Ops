# Business partners → Customers CRM — roadmap

Status: **draft / proposal** · Owner: Alex
Scope: evolve the `Business partners` module into a real CRM, starting with a
rename to **Customers & partners** (*"Clientes y colaboradores"*).

> **Partly superseded (2026-09) by [`docs/customers-crm-alignment.md`](customers-crm-alignment.md)**,
> which reconciles this plan with the customer's (Julia's) CRM brief. Julia has
> now answered all 7 open questions (alignment doc §4.4) — where the two docs
> differ, the alignment doc wins. Headline changes: module name is
> **Customers & partners** / *Clientes y colaboradores* (confirmed); **Phase C3
> is restored but reshaped** — a lightweight `crm_opportunities` covers only the
> *pre-project* funnel (Julia confirmed she needs to track deals before they're
> a project at all), then converts into a project that rides the existing
> Lead/Oferta/Guanyat board; **tasks become their own platform-wide module**
> promoted to Phase 1; **people become first-class records** in C1; per-owner
> visibility is on by default with a Settings override; opportunity/deal
> amounts reuse `invoicecurrencies`. Two new tracks, both confirmed: **C6
> Relationship Map** and **Phase P Programme Operations** (patient recruitment
> / expert network), neither pulled into Phase 1. See the alignment doc §5 for
> the updated phase table.

---

## 1 · Goal and approach

Today [`server/routes/businessPartners.js`](../server/routes/businessPartners.js)
is a directory: a partner record with one address, a `contacts` list, a
`businesspartnersnotes` list, `taxcompanies` for invoicing, a
`businesspartnerchangelog` history feed, and a link to `projects` via
`projects.busspartnerid`. That is a solid address book but not a CRM — there is
nowhere to record *what happened* with an account, *what happens next*, or
*whether a deal is going to close*.

The plan adds those three things on top of what exists, in this order:

1. **Rename + account fields** — Customers, with a role/status/owner so the
   record means something commercially. Mostly UI over existing data.
2. **Activities + tasks** — log interactions, set follow-ups. Two new tables,
   highest daily value.
3. **Opportunities + pipeline** — deals with stages, a kanban, win → project.
4. **Segmentation + data quality** — tags, saved segments, dedupe/merge, import.
5. **Communication + dashboards + assistant** — email templates/sending, sales
   reports, `chatTools` coverage.

### Guiding constraints

- **Don't break the invoicing/project joins.** `businesspartners`,
  `taxcompanies`, `contacts` keep their table names and PKs; the rename is a
  product/API/UI rename, not a schema rename. `projects.busspartnerid` and
  `invoicesdetails.busspartnertoinvoiceid` are untouched.
- **A partner is not always a customer.** `taxcompanies` and the
  invoicing-partner picker point at records that may be suppliers,
  subcontractors, or billing-only entities. A `role` field (multi-value) keeps
  one table and lets the Customers view filter to the commercial subset. A
  wholesale "these are all customers now" rename would mislabel them.
- **Follow the repo's patterns** — `node-pg-migrate` for every schema change
  (see [`docs/migrations.md`](migrations.md); never `schema-changes.sql` or an
  `ensure*` function again), `requireModuleAccess()` gating, `logAudit({kind})`
  for every mutation, the `businesspartnerchangelog` "human-readable summary per
  change" convention, i18n keys in all three languages
  ([`public/js/i18n-dict.js`](../public/js/i18n-dict.js)).
- **Feature-flag the CRM surface** so an instance that only wants the address
  book can keep it. `FEATURES.crm` in [`public/js/config.js`](../public/js/config.js).

---

## 2 · Where this plugs into Ops today

| Ops concept | File | Relevance |
|---|---|---|
| Module list / permission key `business-partners` | [`server/lib/permissions.js:68`](../server/lib/permissions.js) `MODULE_KEYS` | Rename to `customers`; add finer rights (view-own vs view-all, edit-pipeline) |
| List + detail + create + update | [`server/routes/businessPartners.js`](../server/routes/businessPartners.js) | Becomes `server/routes/customers.js`, mounted at `/api/customers` (keep `/api/business-partners` as an alias for one release) |
| Contacts subform | `businessPartners.js` `/:id/contacts` + `contacts` table | Extend with role/decision-maker/LinkedIn/DNC; primary-contact flag |
| Notes subform | `/:id/notes` + `businesspartnersnotes` | Folds into the unified activity timeline as `kind='note'` |
| Change log / history | `/:id/history` + `businesspartnerchangelog` | Same feed powers the timeline's "field changed" entries |
| Projects link | `/:id/projects` + `projects.busspartnerid` | Feeds the Customer 360 panel; win-an-opportunity can create a project |
| Tax companies | `/:id/tax-companies` + `taxcompanies` | Unchanged; shown on the 360 panel; AR/overdue snapshot joins from here |
| Front page | [`public/pages/business-partners.html`](../public/pages/business-partners.html) + [`public/js/business-partners.js`](../public/js/business-partners.js) + [`public/css/business-partners.css`](../public/css/business-partners.css) | Rename files → `customers.*`; add pipeline board + timeline UI |
| Menu tile + nav | [`public/welcome.html`](../public/welcome.html), every `pages/*.html` header | Relabel "Business partners" → "Customers" |
| Kanban prior art | [`public/js/projects.js`](../public/js/projects.js) | The opportunity pipeline board reuses this drag-and-drop pattern |
| Assistant tools | [`server/lib/chatTools.js`](../server/lib/chatTools.js) `get_business_partner` | Rename tool; add `get_customer_timeline`, `list_opportunities`, `pipeline_forecast` |
| Reports | [`server/routes/reports.js`](../server/routes/reports.js) + [`public/pages/reports.html`](../public/pages/reports.html) | New pipeline / activity / new-customers reports, CSV export like the rest |
| Audit kinds | [`server/lib/audit.js`](../server/lib/audit.js) | `bp.*` kinds become `customer.*`; new `opportunity.*`, `activity.*`, `task.*` |

---

## 3 · Data model changes

All via `npm run migrate:create` (see [`docs/migrations.md`](migrations.md)).
Grouped by phase.

### Phase C1 — account fields

```sql
-- Up Migration
-- commercial classification: an array so one record can be e.g. {customer,partner}
ALTER TABLE businesspartners ADD COLUMN roles           text[] NOT NULL DEFAULT '{}';
ALTER TABLE businesspartners ADD COLUMN lifecycle_stage varchar(16) NOT NULL DEFAULT 'none';
  -- none | lead | prospect | customer | dormant | lost
ALTER TABLE businesspartners ADD COLUMN owner_employeeid bigint REFERENCES employees(id);
ALTER TABLE businesspartners ADD COLUMN lead_source     varchar(32);
ALTER TABLE businesspartners ADD COLUMN industry        varchar(64);
ALTER TABLE businesspartners ADD COLUMN archived_at     timestamptz;

CREATE TABLE businesspartner_stage_history (
  id                bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  businesspartnerid bigint NOT NULL,
  from_stage        varchar(16),
  to_stage          varchar(16) NOT NULL,
  changedat         timestamptz NOT NULL DEFAULT now(),
  changedby         bigint,
  reason            text
);
CREATE INDEX businesspartner_stage_history_bpid_idx
  ON businesspartner_stage_history (businesspartnerid);

-- contact enrichment
ALTER TABLE contacts ADD COLUMN is_primary       boolean NOT NULL DEFAULT false;
ALTER TABLE contacts ADD COLUMN is_decision_maker boolean NOT NULL DEFAULT false;
ALTER TABLE contacts ADD COLUMN linkedin_url     varchar(255);
ALTER TABLE contacts ADD COLUMN do_not_contact   boolean NOT NULL DEFAULT false;
ALTER TABLE contacts ADD COLUMN languageid       bigint;
```

### Phase C2 — activities & tasks

```sql
-- Up Migration
CREATE TABLE crm_activities (
  id                bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  businesspartnerid bigint NOT NULL,
  opportunityid     bigint,            -- optional narrower link
  contactid         bigint,
  kind              varchar(16) NOT NULL,  -- call | meeting | email | note | site_visit | other
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  summary           text NOT NULL,
  outcome           varchar(16),           -- positive | neutral | negative | null
  logged_by         bigint,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_activities_bpid_idx        ON crm_activities (businesspartnerid, occurred_at DESC);
CREATE INDEX crm_activities_opportunity_idx ON crm_activities (opportunityid);

CREATE TABLE crm_tasks (
  id                bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  businesspartnerid bigint,
  opportunityid     bigint,
  contactid         bigint,
  title             varchar(255) NOT NULL,
  due_date          date,
  assignee_employeeid bigint,
  status            varchar(12) NOT NULL DEFAULT 'open',  -- open | done | cancelled
  completed_at      timestamptz,
  created_by        bigint,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_tasks_assignee_open_idx
  ON crm_tasks (assignee_employeeid, due_date) WHERE status = 'open';
```

The customer timeline is a `UNION` view over `crm_activities`,
`businesspartnerchangelog`, `businesspartner_stage_history`, completed
`crm_tasks`, and (read-only) linked project status changes and issued invoices.

### Phase C3 — opportunities

```sql
-- Up Migration
CREATE TABLE crm_pipeline_stages (
  id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name        varchar(48) NOT NULL,
  sort_order  int NOT NULL,
  probability int NOT NULL DEFAULT 0,       -- 0..100, for the weighted forecast
  is_won      boolean NOT NULL DEFAULT false,
  is_lost     boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true
);

CREATE TABLE crm_opportunities (
  id                bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  businesspartnerid bigint NOT NULL,
  name              varchar(255) NOT NULL,
  stageid           bigint NOT NULL REFERENCES crm_pipeline_stages(id),
  amount            numeric(14,2),
  currencyid        bigint,                 -- reuse the invoicing currency table
  expected_close    date,
  owner_employeeid  bigint,
  primary_contactid bigint,
  source            varchar(32),
  lost_reason       varchar(64),
  projectid         bigint,                 -- set when a win spawns / links a project
  created_by        bigint,
  created_at        timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz
);
CREATE INDEX crm_opportunities_bpid_idx  ON crm_opportunities (businesspartnerid);
CREATE INDEX crm_opportunities_stage_idx ON crm_opportunities (stageid);

CREATE TABLE crm_opportunity_stage_history (
  id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  opportunityid bigint NOT NULL,
  from_stageid  bigint,
  to_stageid    bigint NOT NULL,
  changedat     timestamptz NOT NULL DEFAULT now(),
  changedby     bigint
);
```

Seed `crm_pipeline_stages` in the same migration (New / Qualified / Proposal /
Negotiation / Won / Lost with sensible probabilities).

### Phase C4 — tags & segments

```sql
-- Up Migration
CREATE TABLE crm_tags (
  id    bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  label varchar(48) NOT NULL UNIQUE,
  color varchar(16)
);
CREATE TABLE crm_partner_tags (
  businesspartnerid bigint NOT NULL,
  tagid             bigint NOT NULL REFERENCES crm_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (businesspartnerid, tagid)
);
CREATE TABLE crm_saved_segments (
  id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name       varchar(64) NOT NULL,
  owner_employeeid bigint,
  shared     boolean NOT NULL DEFAULT false,
  filter_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

### Phase C5 — communication

```sql
-- Up Migration
CREATE TABLE crm_email_templates (
  id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name       varchar(64) NOT NULL,
  subject    text NOT NULL,
  body       text NOT NULL,             -- {{contact.name}}, {{company}}, {{project}} merge fields
  languageid bigint,
  active     boolean NOT NULL DEFAULT true,
  created_by bigint
);
CREATE TABLE crm_attachments (
  id                bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  businesspartnerid bigint,
  opportunityid     bigint,
  filename          varchar(255) NOT NULL,
  stored_path       varchar(255) NOT NULL,   -- UPLOAD_DIR/crm, mirrors expenses evidence
  content_type      varchar(128),
  size_bytes        bigint,
  uploaded_by       bigint,
  uploaded_at       timestamptz NOT NULL DEFAULT now()
);
```

Outbound email reuses the per-entity transport work from Phase 0B (see
[`docs/phase-0-issues.md`](phase-0-issues.md#b--externalise-per-deployment-configuration))
and whatever invoice-emailing lands first — CRM send should not build its own
SMTP path.

---

## 4 · The rename — concrete checklist

Product rename, not a schema rename. One PR, behind no flag (the address book
is just called Customers now); the CRM features that follow are flagged.

- [ ] `MODULE_KEYS`: `business-partners` → `customers`; migration to update
      existing `employee_module_access` / permission rows
- [ ] `server/routes/businessPartners.js` → `customers.js`; mount `/api/customers`;
      keep `/api/business-partners` as a 308-alias for one release
- [ ] `public/pages/business-partners.html` → `customers.html`;
      `public/js/business-partners.js` → `customers.js`;
      `public/css/business-partners.css` → `customers.css`
- [ ] Nav label + menu tile in `welcome.html` and every `pages/*.html` header
- [ ] i18n: rename keys `businessPartners.*` → `customers.*` in all three langs,
      update the visible strings ("Business partner" → "Customer")
- [ ] `chatTools.js`: `get_business_partner` → `get_customer` (keep old name
      registered as an alias so in-flight chats don't break)
- [ ] Audit: map `bp.*` kinds → `customer.*`; the audit page filter label
- [ ] `businesspartnerchangelog` summaries: "Business partner created" →
      "Customer created" for new rows (leave historic rows as-is)
- [ ] README "Business partners" bullet + Status section
- [ ] Grep for user-facing "business partner" / "BP" strings missed above

Tables, columns (`bpname`, `businesspartnerid`, `bpid`), and the
`businesspartnerchangelog` name **stay** — renaming them touches invoicing,
projects, chat tools, and the Access-era import and buys nothing.

---

## 5 · Phased delivery

### Phase C0 — decisions  *(no code)*
- [ ] Confirm the module name is **Customers** (vs "Accounts", "Clients")
- [ ] `roles` vocabulary — customer / prospect / partner / supplier / other?
- [ ] `lifecycle_stage` vocabulary and the rules for auto-advancing it
      (e.g. first issued invoice → `customer`)
- [ ] Pipeline stages + probabilities — with whoever owns sales
- [ ] Ownership model: is every customer owned? can a non-owner edit? does
      "view-own-only" exist as a permission, or is all-visible fine at this size?
- [ ] Lead sources list
- [ ] Does an opportunity **win** always create a Project, offer to, or neither?

### Phase C1 — Customers + account fields + 360 panel
- [ ] The rename PR (§4)
- [ ] Migration: `roles`, `lifecycle_stage`, `owner`, `lead_source`, `industry`,
      `archived_at`, `businesspartner_stage_history`, contact enrichment (§3 C1)
- [ ] List view: owner + stage + role columns, filters, "My customers" toggle,
      "no owner" and "no activity in 90d" quick filters
- [ ] Detail view: **Customer 360** panel — projects (alive/dead, already
      computed in the list query), tax companies, open opportunities (stub until
      C3), overdue-invoice count + amount from `invoicesdetails`, last activity,
      total invoiced vs budgeted (the `budget_vs_invoiced` chat-tool math)
- [ ] Stage transitions logged to `businesspartner_stage_history` + audit
- [ ] Archive/deactivate instead of delete (mirrors the tax-company delete guard)

### Phase C2 — Activities & tasks
- [ ] Migration: `crm_activities`, `crm_tasks` (§3 C2)
- [ ] "Log activity" action on customer / contact / opportunity
- [ ] Unified **timeline** on the detail view (UNION view, §3 C2) — replaces the
      separate Notes tab; old notes appear as `kind='note'`
- [ ] "Add task" + due/overdue list; complete a task → timeline entry + audit
- [ ] Personal **dashboard** widget: my open tasks, overdue, due this week
- [ ] "Last contacted / next action" rollup columns on the list
- [ ] Optional: email/Teams reminder for tasks due today (reuse notification infra)

### Phase C3 — Opportunities & pipeline
- [ ] Migration: `crm_pipeline_stages` (+ seed), `crm_opportunities`,
      `crm_opportunity_stage_history` (§3 C3)
- [ ] Opportunity CRUD, linked to a customer + optional primary contact
- [ ] **Pipeline kanban** — drag across stages, reusing the `projects.js` board
- [ ] Win → set stage, `closed_at`; prompt to create/link a Project
      (`crm_opportunities.projectid` ↔ existing `projects.busspartnerid`)
- [ ] Lose → `lost_reason` from a fixed list
- [ ] Weighted forecast view — `sum(amount × stage.probability)` by stage / owner
      / expected-close month
- [ ] 360 panel "open opportunities" goes live

### Phase C4 — Segmentation & data quality
- [ ] Migration: `crm_tags`, `crm_partner_tags`, `crm_saved_segments` (§3 C4)
- [ ] Tag management + tag chips on the list and detail
- [ ] Saved segments (`filter_json`) — personal + shared
- [ ] Bulk actions on the list: reassign owner, add/remove tag, change stage
- [ ] **Merge duplicates** — pick survivor, re-point `contacts`, `taxcompanies`,
      `businesspartnersnotes`, `crm_activities`, `crm_opportunities`,
      `projects.busspartnerid`, `businesspartnerchangelog`; archive the loser;
      audit the merge with both ids
- [ ] Dedupe check on create (name / VAT / contact-email near-match warning)
- [ ] CSV import for customers + contacts (the `importid` column is the Access
      precedent); dry-run + error report before commit

### Phase C5 — Communication, dashboards, assistant
- [ ] Migration: `crm_email_templates`, `crm_attachments` (§3 C5)
- [ ] Attach files to a customer / opportunity (`UPLOAD_DIR/crm`, multer, like
      expense evidence)
- [ ] Email templates with merge fields; "log this email" manual capture
- [ ] Send email from the app (once invoice-emailing transport exists) → timeline
- [ ] Reports: pipeline dashboard (value by stage, win rate, avg cycle, by
      owner/source), activity report (interactions per employee per week),
      new customers/leads by month, account-coverage report — all with CSV
- [ ] `chatTools.js`: `get_customer_timeline`, `list_opportunities`,
      `pipeline_forecast`; update the system prompt

---

## 6 · Permissions

| Right | Who | Notes |
|---|---|---|
| `customers` module access | as today for `business-partners` | migrated 1:1 |
| View all vs. own accounts | new | skip in C1 if "all visible" is acceptable at current headcount; add the column now, enforce later |
| Edit pipeline / opportunities | new | sales-facing subset |
| Manage tags / templates / stages | admin | Settings |
| Merge / bulk-delete | admin | irreversible-ish |

Add the keys to [`server/lib/permissions.js`](../server/lib/permissions.js) and
the Settings → Permissions matrix.

---

## 7 · Open questions

**Product / sales**
1. Module name — Customers, Accounts, or Clients?
2. Is there a real sales pipeline today, or is this greenfield process?
3. Should closing an opportunity as Won always create a Project?
4. Do we need per-owner visibility restrictions, or is the team small enough
   that everything is shared?

**Technical**
1. Keep `/api/business-partners` alias for one release or hard-cut? (bookmarks,
   the Access-era import scripts)
2. Timeline as a DB view vs. assembled in the route — view is cleaner but mixes
   five sources with different id types (`double precision` legacy columns).
3. Reuse the invoicing `currencies` table for opportunity amounts, or keep
   opportunities single-currency for v1?
4. i18n key rename vs. add-new-keep-old — a rename is cleaner but churns all
   three dictionaries in one PR.

---

## 8 · Risks

| Risk | Mitigation |
|---|---|
| Rename breaks the invoicing / projects / chat joins | Product rename only; table + column names frozen; alias the old API route |
| CRM features bloat the address-book use case for instances that don't want them | `FEATURES.crm` gates the pipeline, timeline, tasks UI; C1 rename ships unflagged |
| "Business partner" ≠ "customer" — supplier/billing-only records get mislabeled | `roles[]` column; Customers view filters to the commercial subset by default |
| Timeline UNION over legacy `double precision` fk columns is fragile | Cast explicitly (the existing routes already do `::bigint` everywhere); cover with a query test |
| Adoption — activities only pay off if people log them | Activity report as an adoption metric; keep "log activity" one click from every screen |
| Merge/dedupe corrupts referential links | Do it in one transaction, enumerate every referencing table in §5 C4, audit both ids, no hard delete (archive the loser) |
| Migrations fan-out across the fleet | Standard `npm run migrate` deploy step (advisory-locked); every change has a Down section |
