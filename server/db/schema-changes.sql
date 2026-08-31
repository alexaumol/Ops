-- ==========================================================================
-- HITT Ops — incremental schema changes
-- --------------------------------------------------------------------------
-- This project has no migration framework. Changes to the existing
-- PostgreSQL schema are collected here and are also applied idempotently at
-- runtime by the code that needs them, so a deploy doesn't require running
-- this by hand. It's kept for anyone who prefers to apply changes
-- explicitly / review them in one place.
-- ==========================================================================

-- 2026-08 — Settings "Holidays" tab
-- --------------------------------------------------------------------------
-- Tag every holidays row with where it came from, so re-importing the
-- public-holiday feed (source = 'catalonia') never clobbers HR's own
-- HITT holidays (source = 'hitt') or pre-existing rows (source = 'legacy').
-- Applied at runtime by ensureSettingsSchema() in server/routes/settings.js.
ALTER TABLE public.holidays ADD COLUMN IF NOT EXISTS source varchar(32);
UPDATE public.holidays SET source = 'legacy' WHERE source IS NULL;

-- 2026-08 — Settings "Work calendar" tab
-- --------------------------------------------------------------------------
-- No column changes. corporateworkcalendar already has workyear,
-- holidaysamount (leave-day allowance), labourhoursperyear (working hours),
-- corporateholidaysamount, updatedat, updatedby. The Settings tab upserts
-- one row per year; the time-off balance view (server/routes/timeOff.js)
-- falls back to it when an employee has no employeeworkcalendar row.
-- (Optional) enforce one row per year if you want a hard guarantee:
-- CREATE UNIQUE INDEX IF NOT EXISTS corporateworkcalendar_workyear_uidx
--   ON public.corporateworkcalendar (workyear);

-- 2026-08 — Settings "Paths" tab + employee detail
-- --------------------------------------------------------------------------
-- appconfig is a small key/value store for configurable paths (currently
-- just onedrive.employee_docs_base). Created at runtime by
-- ensureSettingsSchema() in server/routes/settings.js.
CREATE TABLE IF NOT EXISTS public.appconfig (
    configkey   varchar(64) PRIMARY KEY,
    configvalue text,
    updatedat   timestamp without time zone,
    updatedby   bigint
);
-- The add/edit-user modal also reads/writes public.employeesinfo (a
-- pre-existing table, one row per employee via empid). No changes needed;
-- employeedocumentpath is set to <appconfig base>/<username> on save.

-- 2026-08 — BP edit form: tax companies + addresses
-- --------------------------------------------------------------------------
-- No schema changes. taxcompanies / taxcompaniesaddresses / addresses are
-- all pre-existing. The BP modal's Invoicing tab now does full CRUD on a
-- BP's tax companies; each tax-company address either mirrors the BP
-- address (taxcompaniesaddresses.sameaddress = true, kept in sync when the
-- BP address is edited) or holds its own. Deleting a tax company is blocked
-- while it's assigned to a project or referenced by an invoice.

-- 2026-08 — Expenses module
-- --------------------------------------------------------------------------
-- No schema changes. The module runs on the pre-existing public.expenses
-- and public.expensescategories tables:
--   expenses.comments          the description
--   expenses.projectid NULL    an internal expense
--   expenses.categoryid  ->    expensescategories.id
--   expenses.ticketurl         the stored evidence filename (one file per
--                              expense; images/PDF, <=15 MB, kept under
--                              UPLOAD_DIR/expenses which is gitignored)
--   expenses.picturetitle      the evidence file's original name
--   expenses.ticketfolderpath  'expenses' when a file is attached
--   expenses.invoiceable       re-billable to the client
-- MIME is inferred from the stored file's extension (no mime column).
-- expensescategories is managed on Settings → Expense categories.
--
-- An earlier build briefly created a separate public.companyexpenses
-- table; it is unused now. Drop it if it exists in your database:
DROP TABLE IF EXISTS public.companyexpenses;
--
-- Backend dependency: `npm install` now also pulls in `multer` (file
-- uploads). New optional env var: UPLOAD_DIR.

-- 2026-08 — Auditing (Settings → Auditing, admins only)
-- --------------------------------------------------------------------------
-- Every security-/data-relevant action is appended to public.actionsaudit
-- (the same table the Access app used). Its base columns already exist
-- (actionuserid, actiondesc, actionts, actioncomputer, actionenvironment,
-- loglevel). These extras are added at runtime by ensureAuditSchema() in
-- server/lib/audit.js:
ALTER TABLE public.actionsaudit ADD COLUMN IF NOT EXISTS actionusername varchar(255);
ALTER TABLE public.actionsaudit ADD COLUMN IF NOT EXISTS actionkind varchar(64);
ALTER TABLE public.actionsaudit ADD COLUMN IF NOT EXISTS actionip varchar(64);
CREATE INDEX IF NOT EXISTS actionsaudit_actionts_idx ON public.actionsaudit (actionts DESC);
CREATE INDEX IF NOT EXISTS actionsaudit_actionuserid_idx ON public.actionsaudit (actionuserid);

-- An earlier build briefly created a separate public.auditlog table; it is
-- unused now. Drop it if it exists in your database:
DROP TABLE IF EXISTS public.auditlog;

-- 2026-08 — Invoice modal: "last updated by / at"
-- --------------------------------------------------------------------------
-- The Access invoicesdetails table has no modification-tracking columns.
-- Added at runtime by ensureInvoicingSchema() in server/routes/invoicing.js
-- and shown in the invoice edit modal's header.
ALTER TABLE invoicesdetails ADD COLUMN IF NOT EXISTS updatedat timestamptz;
ALTER TABLE invoicesdetails ADD COLUMN IF NOT EXISTS updatedby bigint;

-- 2026-08 — Invoice line items + per-invoice currency
-- --------------------------------------------------------------------------
-- Invoices now hold one or more invoiceable items (description / qty /
-- unit price); the invoice amount is the sum of their subtotals. Each
-- invoice also carries a currency code (EUR by default). The currency list
-- is managed in Settings → Currencies. All created at runtime by
-- ensureInvoicingSchema() / ensureCurrencyTable().
ALTER TABLE invoicesdetails ADD COLUMN IF NOT EXISTS currency varchar(8) DEFAULT 'EUR';

CREATE TABLE IF NOT EXISTS invoicelineitems (
  id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  invoiceid   bigint NOT NULL,
  sortorder   int NOT NULL DEFAULT 0,
  description text,
  quantity    numeric(14,2) NOT NULL DEFAULT 1,
  unitprice   numeric(14,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS invoicelineitems_invoiceid_idx ON invoicelineitems (invoiceid);

CREATE TABLE IF NOT EXISTS invoicecurrencies (
  id     bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  code   varchar(8) NOT NULL UNIQUE,
  symbol varchar(8) NOT NULL DEFAULT '',
  label  varchar(64) NOT NULL DEFAULT ''
);
-- sortorder drives the order currencies appear in the invoice dropdown
-- (Settings → Currencies lets an admin reorder them).
ALTER TABLE invoicecurrencies ADD COLUMN IF NOT EXISTS sortorder int NOT NULL DEFAULT 0;
INSERT INTO invoicecurrencies (code, symbol, label, sortorder) VALUES ('EUR', '€', 'Euro', 0)
  ON CONFLICT (code) DO NOTHING;

-- 2026-08 — Company logo customization (Settings → Customizations)
-- --------------------------------------------------------------------------
-- The admin-uploaded company logo is stored as a base64 data URL in the
-- shared appconfig table under key 'branding.logo'. Kept in the DB (not a
-- file under public/) so it survives a `git pull` deploy. Served publicly
-- by GET /api/branding/logo (the sign-in page shows it too). The appconfig
-- table itself is created by ensureSettingsSchema() / ensureConfigTable().
CREATE TABLE IF NOT EXISTS public.appconfig (
  configkey   varchar(64) PRIMARY KEY,
  configvalue text,
  updatedat   timestamp without time zone,
  updatedby   bigint
);

-- 2026-08 — Invoice "Sent" tracking
-- --------------------------------------------------------------------------
-- Set when an invoice PDF is emailed from the app (POST /api/invoicing/
-- invoices/:id/email). Drives the "Sent" badge in the invoices list and is
-- also written to the audit log (kind = 'invoice.email'). Separate from
-- invoicesentdate, which feeds the date-derived invoice status.
-- Added at runtime by ensureInvoicingSchema() in server/routes/invoicing.js.
ALTER TABLE invoicesdetails ADD COLUMN IF NOT EXISTS emailedat timestamptz;
ALTER TABLE invoicesdetails ADD COLUMN IF NOT EXISTS emailedby bigint;
ALTER TABLE invoicesdetails ADD COLUMN IF NOT EXISTS emailedto text;
ALTER TABLE invoicesdetails ADD COLUMN IF NOT EXISTS emailedcount int NOT NULL DEFAULT 0;

-- 2026-08 — Default UI language (Settings → Customizations)
-- --------------------------------------------------------------------------
-- appconfig key 'app.language' holds the app-wide default UI language code
-- ('en' | 'es' | 'ca'), served publicly by GET /api/branding/language (the
-- sign-in page localises itself pre-auth). Each viewer can override it for
-- themselves; that choice lives in their browser (localStorage "hitt.lang"),
-- not the DB. appconfig table created by ensureConfigTable() in
-- server/routes/branding.js.

-- 2026-08 — Billing entities (Settings → Entities)
-- --------------------------------------------------------------------------
-- Multi-organization setup: each entity's letterhead, bank account and
-- invoice logo are stamped onto the invoice PDF. Added at runtime by
-- ensureEntitySchema() in server/lib/entitySchema.js (called by both
-- routes/entities.js and routes/invoicing.js). Bank details reuse the
-- existing bankaccts table (one row per entity, linked by bankaccts.entityid).
ALTER TABLE entity ADD COLUMN IF NOT EXISTS legalname      varchar(255);
ALTER TABLE entity ADD COLUMN IF NOT EXISTS vatnumber      varchar(64);
ALTER TABLE entity ADD COLUMN IF NOT EXISTS address        text;
ALTER TABLE entity ADD COLUMN IF NOT EXISTS emailinvoicing varchar(255);
ALTER TABLE entity ADD COLUMN IF NOT EXISTS webpage        varchar(255);
ALTER TABLE entity ADD COLUMN IF NOT EXISTS logo           text;   -- PNG/JPEG data URL

-- 2026-09 — Employee profile: birthday opt-in + avatar photo
-- --------------------------------------------------------------------------
-- Backs the "show my birthday in the team calendar" toggle and the avatar
-- photo upload (Profile modal + Settings → Users). avatarimage is a
-- data:image/... URL, auto square-cropped + downscaled client-side;
-- avatarusephoto false keeps the image on file as a rollback. Added at
-- runtime by ensureEmployeeProfileSchema() in server/lib/employeeProfile.js.
ALTER TABLE employeesinfo ADD COLUMN IF NOT EXISTS showbirthday   boolean NOT NULL DEFAULT false;
ALTER TABLE employeesinfo ADD COLUMN IF NOT EXISTS avatarimage    text;
ALTER TABLE employeesinfo ADD COLUMN IF NOT EXISTS avatarusephoto boolean NOT NULL DEFAULT false;

-- 2026-09 — Per-entity invoice-email delivery (Settings → Entities → "Invoice
-- email"). Replaces the old routing in routes/invoicing.js that switched the
-- sender mailbox + transport on the entity's DISPLAY NAME ("HiTT" -> Graph,
-- "FHiTT" -> SMTP). Added at runtime by ensureEntitySchema().
--   mailtransport  'graph' | 'smtp' | NULL  (NULL -> inferred from which
--                  transport is configured on the server)
--   mailsender     From mailbox; NULL -> entity.emailinvoicing, then
--                  GRAPH_MAIL_SENDER / SMTP_FROM
ALTER TABLE entity ADD COLUMN IF NOT EXISTS mailtransport  varchar(8);
ALTER TABLE entity ADD COLUMN IF NOT EXISTS mailsender     varchar(255);
