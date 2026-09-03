-- Up Migration
-- ==========================================================================
-- Veri*Factu (Spain) — issue flow (phase V2).
-- --------------------------------------------------------------------------
-- Supports the "Issue invoice" action: a draft invoice (issued_at IS NULL,
-- from V1) becomes a legal invoice — its fiscal number is assigned from a
-- per-entity gap-free series, it is locked against edit/delete, and (when
-- Veri*Factu is on for its entity and auto-submit is left checked) it is
-- registered with the AEAT via BOLD.
--
-- See docs/verifactu-integration-roadmap.md §4.1 / §4.2 and
-- server/lib/verifactu/issue.js.
-- ==========================================================================

-- Denormalise the issuing entity onto the invoice. Backfilled from the
-- project; set at create time from then on. Used for the per-NIF number
-- series and to resolve the BOLD API key / issuer NIF without a join.
ALTER TABLE public.invoices ADD COLUMN entityid bigint;

UPDATE public.invoices i
   SET entityid = p.entityid::bigint
  FROM public.projects p
 WHERE p.id = i.projectid::bigint
   AND i.entityid IS NULL;

CREATE INDEX invoices_entityid_year_idx ON public.invoices (entityid, invoiceyear, iscorrective);

-- Lookup index on the fiscal number. NOT unique: legacy Access data + the
-- old pooled numbering left some duplicate `invoicecode` values, and it is
-- not this migration's place to renumber historical invoices. New
-- Veri*Factu numbers are kept collision-free by the per-entity advisory
-- lock + MAX(invoiceseq)+1 in server/lib/verifactu/issue.js (nextInvoiceNumber).
CREATE INDEX invoices_invoicecode_idx
  ON public.invoices (invoicecode)
  WHERE invoicecode IS NOT NULL;

-- Recipient country for the foreign-identification form (BOLD
-- `recipient.country`). `countries` has no ISO code, and for a non-Spanish
-- fiscal id the code is mandatory, so it travels with the id on the tax
-- company. NULL is read as 'ES' when fiscalidtype is NULL/'nif'.
ALTER TABLE public.taxcompanies ADD COLUMN fiscalcountry varchar(2);

-- Down Migration

ALTER TABLE public.taxcompanies DROP COLUMN IF EXISTS fiscalcountry;
DROP INDEX IF EXISTS public.invoices_invoicecode_idx;
DROP INDEX IF EXISTS public.invoices_invoicecode_uidx;  -- older name, if a pre-fix run created it
DROP INDEX IF EXISTS public.invoices_entityid_year_idx;
ALTER TABLE public.invoices DROP COLUMN IF EXISTS entityid;
