-- ==========================================================================
-- INSTANCE SEED — the minimum for a new instance to be usable
-- --------------------------------------------------------------------------
-- Run by provision/provision.js after the schema + reference data, with:
--   psql -v ON_ERROR_STOP=1 \
--        -v display_name="Acme Corp" \
--        -v admin_email=jane.doe@acme.com \
--        -v admin_first=Jane -v admin_last=Doe \
--        -f seed-instance.sql "<instance DB URL>"
--
-- Creates: the first admin employee (+ admins row), one default billing
-- entity, and the current work-calendar year. Everything else the customer
-- fills in through the app.
-- ==========================================================================

BEGIN;

-- First user, as an admin.
INSERT INTO public.employees (username, employeefirstname, employeelastname, emailid, deactivated)
VALUES (split_part(:'admin_email', '@', 1), :'admin_first', :'admin_last', :'admin_email', false);

INSERT INTO public.admins (employeeid, grantedat)
SELECT id, now() FROM public.employees WHERE lower(emailid) = lower(:'admin_email');

INSERT INTO public.employeesinfo (empid, onboarddate)
SELECT id, now() FROM public.employees WHERE lower(emailid) = lower(:'admin_email');

-- One billing entity so invoicing has a valid issuer. The customer edits its
-- letterhead / bank / logo in Settings -> Entities.
INSERT INTO public.entity (entitydesc)
VALUES (left(:'display_name', 255));

-- Current work-calendar year (company-wide leave allowance + working hours).
-- Placeholder values — the customer adjusts them in Settings -> Calendar.
INSERT INTO public.corporateworkcalendar (workyear, labourhoursperyear, holidaysamount, corporateholidaysamount, updatedat)
VALUES (EXTRACT(YEAR FROM now()), 1720, 23, 0, now());

COMMIT;
