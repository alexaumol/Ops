-- Up Migration
-- ==========================================================================
-- Rename the "Business partners" module key to "customers-partners" in
-- modulerestrictions (the block-list of who's denied a module — see
-- server/lib/permissions.js MODULE_KEYS). Data-only: no schema change.
--
-- Part of the module rename (docs/customers-crm-roadmap.md §4). Without
-- this, every existing restriction against the old key stops matching once
-- the code switches to the new one — silently *granting back* access to
-- whoever was restricted, which is the wrong direction to fail in.
-- ==========================================================================
UPDATE public.modulerestrictions
SET modulekey = 'customers-partners'
WHERE modulekey = 'business-partners';

-- Down Migration
UPDATE public.modulerestrictions
SET modulekey = 'business-partners'
WHERE modulekey = 'customers-partners';
