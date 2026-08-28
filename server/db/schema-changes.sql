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
