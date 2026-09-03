-- Up Migration
-- ==========================================================================
-- Purge orphan timeoffrequeststatus rows
-- --------------------------------------------------------------------------
-- timeoffrequeststatus is meant to hold one row per time-off request
-- (timeoffreqid -> timeoffrequests.id, statusid -> timeoffworkflowstatus.id).
-- The Access-derived import left behind status rows whose parent request was
-- never imported (or was later removed), so timeoffreqid points at nothing
-- — or is NULL.
--
-- These orphans are invisible in every request-scoped query (they all join
-- timeoffrequests) but were being counted by the approver notification
-- badge, which did a bare COUNT over this table (fixed in
-- server/routes/timeOff.js to join timeoffrequests). This removes the stale
-- rows so the data matches what the app can actually act on.
--
-- The app never hard-deletes a timeoffrequests row (approve / reject /
-- withdraw are status transitions), so this is a one-time cleanup, not a
-- recurring condition. No FK is added: timeoffreqid is `double precision`
-- here and timeoffrequests.id is `bigint`, so a real FK would need a column
-- type change first — out of scope for this fix.

DELETE FROM public.timeoffrequeststatus s
 WHERE NOT EXISTS (
   SELECT 1 FROM public.timeoffrequests r
    WHERE r.id = s.timeoffreqid
 );

-- Down Migration
-- ==========================================================================
-- Irreversible: the deleted rows referenced requests that do not exist, so
-- there is nothing to restore and no way to reconstruct them. This is a
-- deliberate no-op.
SELECT 1;
