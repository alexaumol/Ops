-- Resync every identity / serial sequence in public to max(id) of its table.
-- Runs after loading rows with explicit ids (reference-data.sql +
-- seed-instance.sql); without it the next app INSERT collides at id 1.
--
-- Uses pg_get_serial_sequence() to get the sequence name so mixed-case /
-- quoted names (e.g. "actionsaudit_Id_seq") resolve correctly.
DO $$
DECLARE
  r record;
  seqname text;
BEGIN
  FOR r IN
    SELECT tbl.relname AS tblname, col.attname AS colname
    FROM pg_class seq
    JOIN pg_depend dep ON dep.objid = seq.oid AND dep.classid = 'pg_class'::regclass
    JOIN pg_class tbl ON tbl.oid = dep.refobjid
    JOIN pg_attribute col ON col.attrelid = tbl.oid AND col.attnum = dep.refobjsubid
    WHERE seq.relkind = 'S'
      AND dep.deptype IN ('a', 'i')
      AND tbl.relnamespace = 'public'::regnamespace
  LOOP
    seqname := pg_get_serial_sequence('public.' || quote_ident(r.tblname), r.colname);
    CONTINUE WHEN seqname IS NULL;
    EXECUTE format(
      'SELECT setval(%L, GREATEST((SELECT COALESCE(max(%I), 0) FROM public.%I), 1), (SELECT count(*) FROM public.%I) > 0)',
      seqname, r.colname, r.tblname, r.tblname
    );
  END LOOP;
END $$;
