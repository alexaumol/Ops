-- Up Migration
-- ==========================================================================
-- Remove the retired "OneDrive — employee documents base folder" setting.
-- --------------------------------------------------------------------------
-- The Settings "Paths" tab is now "Sync" and no longer offers this key; the
-- server dropped it from CONFIG_KEYS and stopped deriving
-- employeesinfo.employeedocumentpath from it. Drop the stored value so a
-- stale row doesn't linger in appconfig.
--
-- employeesinfo.employeedocumentpath (the column) and any values already in
-- it are left untouched — just no longer written.

DELETE FROM public.appconfig WHERE configkey = 'onedrive.employee_docs_base';

-- Down Migration
-- ==========================================================================
-- Nothing to restore (the value was a plain config string). No-op.
SELECT 1;
