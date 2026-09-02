-- Up Migration
-- ==========================================================================
-- Reports → "My reports" (self-service report builder)
-- --------------------------------------------------------------------------
-- Five curated read-only views expose ONLY business-reporting columns — no
-- salaries (employeesinfo), bank details, audit log, or auth tables. They
-- are the security boundary: the builder never names a table or writes SQL,
-- it drags fields declared in server/lib/reportCatalog.js, which only ever
-- emits identifiers that resolve to columns of these views.
--
-- Join keys follow the casts already proven in server/lib/chatTools.js —
-- most FK columns in this (Access-derived) schema are `double precision`,
-- cast `::bigint` to match the `bigint` primary keys.
-- ==========================================================================

-- rpt_projects — one row per project ---------------------------------------
CREATE VIEW public.rpt_projects AS
SELECT
    p.id                                             AS project_id,
    p.projectnumber                                  AS project_code,
    p.projectname                                    AS project_name,
    ps.projectstatusdesc                             AS status,
    COALESCE(ent.entitydesc, '—')                    AS entity,
    COALESCE(own.owner_name, '—')                    AS owner,
    COALESCE(pt.projecttypedesc, '—')                AS project_type,
    COALESCE(bs.spectrumdesc, '—')                   AS biotech_spectrum,
    COALESCE(bp.bpname, '—')                          AS business_partner,
    EXTRACT(YEAR  FROM p.entrydate)::int             AS entry_year,
    EXTRACT(MONTH FROM p.entrydate)::int             AS entry_month,
    p.entrydate::date                                AS entry_date,
    CASE WHEN COALESCE(p.notinvoiceable, false) THEN 'No' ELSE 'Yes' END AS invoiceable,
    qt.finalquotation                               AS budget,
    COALESCE(inv.total, 0)                          AS invoiced_total,
    COALESCE(inv.cnt, 0)                            AS invoice_count,
    COALESCE(h.po, 0)                               AS po_hours,
    COALESCE(h.res, 0)                              AS res_hours,
    COALESCE(h.po, 0) + COALESCE(h.res, 0)          AS total_hours,
    COALESCE(ex.total, 0)                           AS expenses_total,
    1                                               AS project_count
FROM public.projects p
LEFT JOIN public.projectstatus   ps ON ps.id = p.projectstatusid::bigint
LEFT JOIN public.entity          ent ON ent.id = p.entityid::bigint
LEFT JOIN public.projecttypes    pt ON pt.id = p.projecttypeid::bigint
LEFT JOIN public.biotechspectrums bs ON bs.id = p.biospectrumid::bigint
LEFT JOIN public.businesspartners bp ON bp.id = p.busspartnerid::bigint
LEFT JOIN LATERAL (
    SELECT TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)) AS owner_name
    FROM public.projectowners po
    JOIN public.employees e ON e.id = po.projectownerid::bigint
    WHERE po.projectid = p.id
    ORDER BY po.id DESC
    LIMIT 1
) own ON true
LEFT JOIN LATERAL (
    SELECT finalquotation
    FROM public.projectquotations
    WHERE projectid = p.id
    ORDER BY quotationdate DESC NULLS LAST, id DESC
    LIMIT 1
) qt ON true
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(d.amount), 0) AS total, COUNT(*) AS cnt
    FROM public.invoices i
    LEFT JOIN public.invoicesdetails d ON d.invoiceid = i.id
    WHERE i.projectid = p.id::double precision
      AND i.invoicestatusid IS DISTINCT FROM 6
) inv ON true
LEFT JOIN LATERAL (
    SELECT SUM(projtimetrackhours) FILTER (WHERE po_res = 'PO')  AS po,
           SUM(projtimetrackhours) FILTER (WHERE po_res = 'RES') AS res
    FROM public.projectstimetracking
    WHERE projectid::bigint = p.id
) h ON true
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM public.expenses
    WHERE projectid::bigint = p.id
) ex ON true;

-- rpt_time_tracking — one row per logged time-tracking entry --------------
CREATE VIEW public.rpt_time_tracking AS
SELECT
    t.id                                     AS entry_id,
    p.projectnumber                          AS project_code,
    p.projectname                            AS project_name,
    COALESCE(ent.entitydesc, '—')            AS entity,
    ps.projectstatusdesc                     AS project_status,
    COALESCE(NULLIF(TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)), ''),
             'Employee #' || t.userid::bigint) AS employee,
    t.po_res                                 AS resource_type,
    EXTRACT(YEAR  FROM t.projtimetrackdate)::int AS track_year,
    EXTRACT(MONTH FROM t.projtimetrackdate)::int AS track_month,
    t.projtimetrackdate::date               AS track_date,
    COALESCE(t.projtimetrackhours, 0)       AS hours,
    1                                       AS entry_count
FROM public.projectstimetracking t
LEFT JOIN public.projects       p  ON p.id = t.projectid::bigint
LEFT JOIN public.projectstatus  ps ON ps.id = p.projectstatusid::bigint
LEFT JOIN public.entity         ent ON ent.id = p.entityid::bigint
LEFT JOIN public.employees      e  ON e.id = t.userid::bigint;

-- rpt_invoices — one row per invoice line (invoicesdetails) --------------
CREATE VIEW public.rpt_invoices AS
SELECT
    d.id                                    AS invoice_detail_id,
    i.invoicecode                           AS invoice_code,
    p.projectnumber                         AS project_code,
    p.projectname                           AS project_name,
    COALESCE(ent.entitydesc, '—')           AS entity,
    COALESCE(ist.statusdesc, '—')           AS status,
    CASE WHEN COALESCE(i.iscorrective, false) THEN 'Yes' ELSE 'No' END AS corrective,
    COALESCE(bp.bpname, '—')                AS business_partner,
    EXTRACT(YEAR  FROM d.invoicedate)::int  AS invoice_year,
    EXTRACT(MONTH FROM d.invoicedate)::int  AS invoice_month,
    d.invoicedate::date                     AS invoice_date,
    d.invoiceduedate::date                  AS due_date,
    COALESCE(d.amount, 0)                   AS amount,
    COALESCE(d.vatamount, 0)                AS vat_amount,
    1                                      AS invoice_count
FROM public.invoicesdetails d
LEFT JOIN public.invoices        i   ON i.id = d.invoiceid::bigint
LEFT JOIN public.invoicesstatus  ist ON ist.id = i.invoicestatusid::bigint
LEFT JOIN public.projects        p   ON p.id = i.projectid::bigint
LEFT JOIN public.entity          ent ON ent.id = p.entityid::bigint
LEFT JOIN public.businesspartners bp ON bp.id = d.busspartnerid::bigint;

-- rpt_expenses — one row per expense ------------------------------------
CREATE VIEW public.rpt_expenses AS
SELECT
    x.id                                    AS expense_id,
    COALESCE(c.categorydesc, '—')           AS category,
    p.projectnumber                         AS project_code,
    p.projectname                           AS project_name,
    COALESCE(NULLIF(TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)), ''), '—') AS employee,
    CASE WHEN COALESCE(x.invoiceable, false) THEN 'Yes' ELSE 'No' END AS invoiceable,
    CASE WHEN x.projectid IS NULL THEN 'Internal' ELSE 'Project' END AS expense_kind,
    EXTRACT(YEAR  FROM x.expensets)::int    AS expense_year,
    EXTRACT(MONTH FROM x.expensets)::int    AS expense_month,
    x.expensets::date                      AS expense_date,
    COALESCE(x.amount, 0)                  AS amount,
    1                                     AS expense_count
FROM public.expenses x
LEFT JOIN public.expensescategories c ON c.id = x.categoryid::bigint
LEFT JOIN public.projects          p ON p.id = x.projectid::bigint
LEFT JOIN public.employees         e ON e.id = x.employeeid::bigint;

-- rpt_business_partners — one row per business partner ------------------
CREATE VIEW public.rpt_business_partners AS
SELECT
    bp.id                                   AS business_partner_id,
    bp.bpname                               AS business_partner,
    COALESCE(ct.companytypedesc, '—')       AS company_type,
    COALESCE(ent.entitydesc, '—')           AS entity,
    COALESCE(l.languagedesc, '—')           AS language,
    COALESCE(pc.cnt, 0)                     AS project_count,
    COALESCE(iv.total, 0)                   AS invoiced_total,
    1                                      AS bp_count
FROM public.businesspartners bp
LEFT JOIN public.companytypes ct  ON ct.id = bp.companytypeid::bigint
LEFT JOIN public.entity       ent ON ent.id = bp.entityid::bigint
LEFT JOIN public.languages    l   ON l.id = bp.languageid
LEFT JOIN LATERAL (
    SELECT COUNT(*) AS cnt FROM public.projects WHERE busspartnerid::bigint = bp.id
) pc ON true
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(d.amount), 0) AS total
    FROM public.invoicesdetails d
    WHERE d.busspartnerid::bigint = bp.id
) iv ON true;

-- Grant SELECT to PUBLIC — the views themselves are the curated boundary
-- (no sensitive columns); the /api/reports/run endpoint is still gated by
-- requireModuleAccess("reports").
GRANT SELECT ON
    public.rpt_projects,
    public.rpt_time_tracking,
    public.rpt_invoices,
    public.rpt_expenses,
    public.rpt_business_partners
TO PUBLIC;

-- savedreports — one row per user-saved report -------------------------
CREATE TABLE public.savedreports (
    id        bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    ownerid   bigint NOT NULL,
    name      varchar(200) NOT NULL,
    config    jsonb NOT NULL,
    ispublic  boolean NOT NULL DEFAULT false,
    createdat timestamptz NOT NULL DEFAULT now(),
    updatedat timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX savedreports_ownerid_idx  ON public.savedreports (ownerid);
CREATE INDEX savedreports_ispublic_idx ON public.savedreports (ispublic) WHERE ispublic;

-- Down Migration
DROP TABLE IF EXISTS public.savedreports;
DROP VIEW IF EXISTS public.rpt_business_partners;
DROP VIEW IF EXISTS public.rpt_expenses;
DROP VIEW IF EXISTS public.rpt_invoices;
DROP VIEW IF EXISTS public.rpt_time_tracking;
DROP VIEW IF EXISTS public.rpt_projects;
