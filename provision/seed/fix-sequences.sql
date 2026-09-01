-- Resync every identity / serial sequence in public to max(id) of its table.
-- Runs after loading rows with explicit ids (reference-data.sql +
-- seed-instance.sql); without it the next app INSERT collides at id 1.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT seq.relname AS seqname, tbl.relname AS tblname, col.attname AS colname
    FROM pg_class seq
    JOIN pg_depend dep ON dep.objid = seq.oid AND dep.classid = 'pg_class'::regclass
    JOIN pg_class tbl ON tbl.oid = dep.refobjid
    JOIN pg_attribute col ON col.attrelid = tbl.oid AND col.attnum = dep.refobjsubid
    WHERE seq.relkind = 'S'
      AND dep.deptype IN ('a', 'i')
      AND tbl.relnamespace = 'public'::regnamespace
  LOOP
    EXECUTE format(
      'SELECT setval(%L, GREATEST((SELECT COALESCE(max(%I), 0) FROM public.%I), 1), (SELECT count(*) FROM public.%I) > 0)',
      'public.' || r.seqname, r.colname, r.tblname, r.tblname
    );
  END LOOP;
END $$;
