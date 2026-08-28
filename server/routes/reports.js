/**
 * /api/reports
 * ---------------------------------------------------------------------------
 * New module (no direct Access precedent — closest analogue was
 * "TimeAllocationLog" report, a per-employee hours-by-week log, and the
 * "Holidays"/work-calendar admin forms). Reports:
 *
 *   GET /hours-per-project              Sums projectstimetracking.
 *                                        projtimetrackhours per project
 *                                        over an optional date range.
 *   GET /hours-per-project/:projectId   Same sum, broken down per
 *                                        employee, for one project
 *                                        (row-click drill-down).
 *   GET /resource-leaves                Company holidays + employee
 *                                        time-off requests overlapping a
 *                                        date range, for a calendar view.
 *   GET /projects-by-status-entity      Project counts per status,
 *                                        broken down by entity — bar chart.
 *   GET /project-years                  Distinct entrydate years, for the
 *                                        line chart's year dropdown.
 *   GET /projects-opened-by-month       Project counts by entrydate month,
 *                                        for a given year — line chart.
 *   GET /projects-by-month-detail       The actual projects behind one
 *                                        line-chart point (click a dot).
 *   GET /project-timeline               Every logged project status
 *                                        change (see projectstatushistory,
 *                                        written by
 *                                        routes/projects.js's
 *                                        logStatusChangeAndUpdate()) —
 *                                        paginated, with a project
 *                                        code/name search filter.
 *   GET /stale-projects                 Open (non-Closed/Cancelled)
 *                                        projects with the oldest (or no)
 *                                        logged status change — paginated.
 *

 * IMPORTANT schema note: corporateworkcalendar/employeeworkcalendar (named
 * by Alex as the source for resource-leaves) hold only ANNUAL TOTALS
 * (workyear, labourhoursperyear, holidaysamount, corporateholidaysamount) —
 * confirmed via information_schema, no date columns exist on either table.
 * They're already used for the time-off balance view (routes/timeOff.js
 * GET /balance) and are NOT usable for a calendar of actual dates. The real
 * dated records live in two other tables, used here instead:
 *   holidays          id, holidaycode, holidayyear, holidaydate,
 *                      holidaydesc, holidayweekday — company-wide bank/
 *                      corporate holidays (found via clsHolidays.bas /
 *                      "Manage calendar.frm"'s Holidays subform).
 *   timeoffrequests    already used by routes/timeOff.js — individual
 *                      employee leave date ranges.
 * ---------------------------------------------------------------------------
 */
const express = require("express");
const { pool } = require("../config/db");
const { requireModuleAccess } = require("../lib/permissions");

const router = express.Router();

// GET /api/reports/hours-per-project?startDate=&endDate=
// Both optional — omitted means no lower/upper bound on projtimetrackdate.
router.get("/hours-per-project", requireModuleAccess("reports"), async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT p.id AS "projectId", p.projectnumber AS code, p.projectname AS name,
              ps.projectstatusdesc AS "statusLabel",
              ent.entitydesc AS "entityLabel",
              owner."ownerName",
              COALESCE(SUM(t.projtimetrackhours), 0) AS "totalHours",
              COALESCE(SUM(t.projtimetrackhours) FILTER (WHERE t.po_res = 'PO'), 0) AS "poHours",
              COALESCE(SUM(t.projtimetrackhours) FILTER (WHERE t.po_res = 'RES'), 0) AS "resHours",
              COUNT(DISTINCT t.userid) AS "employeeCount"
       FROM projectstimetracking t
       JOIN projects p ON p.id = t.projectid::bigint
       LEFT JOIN projectstatus ps ON ps.id = p.projectstatusid::bigint
       LEFT JOIN entity ent ON ent.id = p.entityid::bigint
       LEFT JOIN LATERAL (
         SELECT TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)) AS "ownerName"
         FROM projectowners po
         JOIN employees e ON e.id = po.projectownerid::bigint
         WHERE po.projectid = p.id
         ORDER BY po.id DESC
         LIMIT 1
       ) owner ON true
       WHERE ($1::date IS NULL OR t.projtimetrackdate >= $1::date)
         AND ($2::date IS NULL OR t.projtimetrackdate <= $2::date)
       GROUP BY p.id, p.projectnumber, p.projectname, ps.projectstatusdesc, ent.entitydesc, owner."ownerName"
       HAVING COALESCE(SUM(t.projtimetrackhours), 0) > 0
       ORDER BY "totalHours" DESC`,
      [startDate || null, endDate || null]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/reports/hours-per-project] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/reports/hours-per-project/:projectId?startDate=&endDate=
// Drill-down: per-employee breakdown for one project, same date range
// semantics as the list above.
router.get("/hours-per-project/:projectId", requireModuleAccess("reports"), async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT t.userid AS "empId",
              COALESCE(TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)), 'Employee #' || t.userid) AS "employeeName",
              COALESCE(SUM(t.projtimetrackhours), 0) AS "totalHours",
              COALESCE(SUM(t.projtimetrackhours) FILTER (WHERE t.po_res = 'PO'), 0) AS "poHours",
              COALESCE(SUM(t.projtimetrackhours) FILTER (WHERE t.po_res = 'RES'), 0) AS "resHours"
       FROM projectstimetracking t
       LEFT JOIN employees e ON e.id = t.userid::bigint
       WHERE t.projectid::bigint = $1
         AND ($2::date IS NULL OR t.projtimetrackdate >= $2::date)
         AND ($3::date IS NULL OR t.projtimetrackdate <= $3::date)
       GROUP BY t.userid, e.employeefirstname, e.employeelastname
       ORDER BY "totalHours" DESC`,
      [req.params.projectId, startDate || null, endDate || null]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/reports/hours-per-project/:projectId] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/reports/resource-leaves?startDate=&endDate= (both required —
// this drives a calendar view, an unbounded range isn't a sensible query).
router.get("/resource-leaves", requireModuleAccess("reports"), async (req, res) => {
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).json({ error: "validation_error", message: "startDate and endDate are required" });
  }
  try {
    const holidays = await pool.query(
      `SELECT id, holidaydate AS date, holidaydesc AS description, holidaycode AS code
       FROM holidays
       WHERE holidaydate::date BETWEEN $1::date AND $2::date
       ORDER BY holidaydate`,
      [startDate, endDate]
    );

    const timeOff = await pool.query(
      `SELECT r.id, r.empid AS "empId",
              TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)) AS "employeeName",
              r.startdate AS "startDate", r.enddate AS "endDate", r.daysrequested AS "daysRequested",
              s.statusid, ws.workflowstatusdesc AS "statusLabel"
       FROM timeoffrequests r
       LEFT JOIN timeoffrequeststatus s ON s.timeoffreqid = r.id
       LEFT JOIN timeoffworkflowstatus ws ON ws.id = s.statusid
       LEFT JOIN employees e ON e.id = r.empid
       WHERE s.statusid IN (2, 3, 4)
         AND r.startdate <= $2::date AND r.enddate >= $1::date
       ORDER BY r.startdate`,
      [startDate, endDate]
    );

    res.json({ holidays: holidays.rows, timeOff: timeOff.rows });
  } catch (err) {
    console.error("[GET /api/reports/resource-leaves] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/reports/projects-by-status-entity
// GET /api/reports/projects-by-status-entity?year=YYYY
// Grouped-bar-chart data: every status x entity combo, including zero
// counts (CROSS JOIN, not just the combos that happen to exist), so the
// frontend doesn't have to guess which bars are legitimately empty. The 3
// projects with no entityid (confirmed via information_schema) land under
// a synthetic "Unassigned" bucket instead of being silently dropped.
// `year` is optional — omitted means all-time (the original behavior),
// filtered by entrydate to match project-years/opened-by-month's notion
// of "year" when given.
//
// Returns both `count` (project count) and `budget` (sum of each
// project's most recent projectquotations.finalquotation, via a LATERAL
// join) per row — the frontend's Total/Budgeted dropdown picks which
// field to plot, no separate request needed. Checked the real data before
// assuming "most recent": 255 projects each have exactly one quotation
// row; the only project*quotations grouping with a high count (176) turned
// out to be quotation rows with projectid IS NULL (orphaned, not one
// project with many revisions) — they simply don't match any project in
// this join, same as they wouldn't match anything meaningful anywhere
// else. `finalquotation` is NULL on ~40% of quotation rows, treated as 0.
router.get("/projects-by-status-entity", requireModuleAccess("reports"), async (req, res) => {
  const year = req.query.year ? Number(req.query.year) : null;
  try {
    const { rows } = await pool.query(
      `SELECT ps.id AS "statusId", ps.projectstatusdesc AS "statusLabel", ps.ordinal,
              ent.id AS "entityId", ent.label AS "entityLabel",
              COUNT(p.id) AS count,
              COALESCE(SUM(latestq.finalquotation), 0) AS budget
       FROM projectstatus ps
       CROSS JOIN (
         SELECT id, entitydesc AS label FROM entity
         UNION ALL
         SELECT NULL::bigint, 'Unassigned'
       ) ent
       LEFT JOIN projects p
         ON p.projectstatusid::bigint = ps.id
         AND (p.entityid::bigint = ent.id OR (p.entityid IS NULL AND ent.id IS NULL))
         AND ($1::int IS NULL OR EXTRACT(YEAR FROM p.entrydate) = $1)
       LEFT JOIN LATERAL (
         SELECT finalquotation
         FROM projectquotations q
         WHERE q.projectid = p.id
         ORDER BY q.quotationdate DESC NULLS LAST, q.id DESC
         LIMIT 1
       ) latestq ON true
       GROUP BY ps.id, ps.projectstatusdesc, ps.ordinal, ent.id, ent.label
       ORDER BY ps.ordinal NULLS LAST, ps.id, ent.label`,
      [year]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/reports/projects-by-status-entity] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/reports/project-years — distinct years present in
// projects.entrydate, for the "opened by month" chart's year dropdown.
router.get("/project-years", requireModuleAccess("reports"), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT EXTRACT(YEAR FROM entrydate)::int AS year
       FROM projects WHERE entrydate IS NOT NULL
       ORDER BY year DESC`
    );
    res.json(rows.map((r) => r.year));
  } catch (err) {
    console.error("[GET /api/reports/project-years] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/reports/projects-opened-by-month?year=YYYY
// Line-chart data: count of projects opened (entrydate) AND closed
// (projectstatushistory transitions into the "Closed" status) in each
// month of the given year. Always returns all 12 months (0-filled), same
// zero-isn't-missing reasoning as the bar chart above. `year` is optional
// — omitted aggregates every year together per calendar month (e.g. "how
// many projects have ever opened in a January"), same all-time meaning as
// the bar chart's "All years" option.
//
// The "closed" series can only be as complete as projectstatushistory —
// which only started logging when that table was added (see
// routes/projects.js logStatusChangeAndUpdate). Months before that will
// show 0 closures even for projects that really were closed then; there's
// no way to backfill that without data this schema never captured.
router.get("/projects-opened-by-month", requireModuleAccess("reports"), async (req, res) => {
  const year = req.query.year ? Number(req.query.year) : null;
  try {
    const { rows } = await pool.query(
      `WITH opened AS (
         SELECT EXTRACT(MONTH FROM entrydate)::int AS month, COUNT(*) AS cnt
         FROM projects
         WHERE ($1::int IS NULL OR EXTRACT(YEAR FROM entrydate) = $1)
         GROUP BY month
       ), closed AS (
         SELECT EXTRACT(MONTH FROM h.changedat)::int AS month, COUNT(*) AS cnt
         FROM projectstatushistory h
         WHERE ($1::int IS NULL OR EXTRACT(YEAR FROM h.changedat) = $1)
           AND h.newstatusid = (SELECT id FROM projectstatus WHERE projectstatusdesc = 'Closed' LIMIT 1)
         GROUP BY month
       )
       SELECT m.month,
              COALESCE(o.cnt, 0) AS "openedCount",
              COALESCE(c.cnt, 0) AS "closedCount"
       FROM generate_series(1, 12) AS m(month)
       LEFT JOIN opened o ON o.month = m.month
       LEFT JOIN closed c ON c.month = m.month
       ORDER BY m.month`,
      [year]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/reports/projects-opened-by-month] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/reports/projects-by-month-detail?year=&month=&type=opened|closed
// Drill-down for a single point on the opened/closed line chart — the
// actual list of projects behind that count. "opened" reads straight off
// projects.entrydate; "closed" reads projectstatushistory the same way
// projects-opened-by-month's closed series does (see its comment for the
// "only complete since this log started" caveat — a closed point clicked
// for a month before that will legitimately show an empty list). `year`
// is optional, same "All years" meaning as projects-opened-by-month — a
// point clicked while that chart has no year selected aggregates across
// every year for that calendar month.
router.get("/projects-by-month-detail", requireModuleAccess("reports"), async (req, res) => {
  const year = req.query.year ? Number(req.query.year) : null;
  const month = Number(req.query.month);
  const type = req.query.type === "closed" ? "closed" : "opened";
  if (!month || month < 1 || month > 12) {
    return res.status(400).json({ error: "validation_error", message: "month (1-12) is required" });
  }
  try {
    const { rows } = type === "opened"
      ? (await pool.query(
          `SELECT p.id, p.projectnumber AS code, p.projectname AS name, p.entrydate AS "entryDate",
                  ent.entitydesc AS "entityLabel"
           FROM projects p
           LEFT JOIN entity ent ON ent.id = p.entityid::bigint
           WHERE ($1::int IS NULL OR EXTRACT(YEAR FROM p.entrydate) = $1) AND EXTRACT(MONTH FROM p.entrydate) = $2
           ORDER BY p.entrydate`,
          [year, month]
        ))
      : (await pool.query(
          `SELECT DISTINCT p.id, p.projectnumber AS code, p.projectname AS name, p.entrydate AS "entryDate",
                  ent.entitydesc AS "entityLabel"
           FROM projectstatushistory h
           JOIN projects p ON p.id = h.projectid
           LEFT JOIN entity ent ON ent.id = p.entityid::bigint
           WHERE ($1::int IS NULL OR EXTRACT(YEAR FROM h.changedat) = $1) AND EXTRACT(MONTH FROM h.changedat) = $2
             AND h.newstatusid = (SELECT id FROM projectstatus WHERE projectstatusdesc = 'Closed' LIMIT 1)
           ORDER BY p.projectnumber`,
          [year, month]
        ));
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/reports/projects-by-month-detail] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/reports/project-timeline?projectId=&search=&startDate=&endDate=&page=&limit=
// Every logged status change (see logStatusChangeAndUpdate in
// routes/projects.js), newest first. All filters optional. `search`
// matches project code/name (ILIKE). Real pagination — `page` (1-based,
// default 1) and `limit` (default 50, capped at 1000 so a caller asking
// for "everything" for a CSV export still can't haul back the whole
// table). Response is { rows, total, page, limit } so the frontend can
// render Prev/Next controls and a "Page X of Y" label.
router.get("/project-timeline", requireModuleAccess("reports"), async (req, res) => {
  const { projectId, search, startDate, endDate } = req.query;
  const limit = Math.min(Number(req.query.limit) || 50, 1000);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const offset = (page - 1) * limit;
  try {
    const { rows } = await pool.query(
      `SELECT h.id, h.projectid AS "projectId", p.projectnumber AS "projectCode", p.projectname AS "projectName",
              h.oldstatusid AS "oldStatusId", os.projectstatusdesc AS "oldStatusLabel",
              h.newstatusid AS "newStatusId", ns.projectstatusdesc AS "newStatusLabel",
              h.changedat AS "changedAt", h.changedby AS "changedBy",
              NULLIF(TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)), '') AS "changedByName",
              COUNT(*) OVER() AS "totalCount"
       FROM projectstatushistory h
       LEFT JOIN projects p ON p.id = h.projectid
       LEFT JOIN projectstatus os ON os.id = h.oldstatusid
       LEFT JOIN projectstatus ns ON ns.id = h.newstatusid
       LEFT JOIN employees e ON e.id = h.changedby
       WHERE ($1::bigint IS NULL OR h.projectid = $1::bigint)
         AND ($2::date IS NULL OR h.changedat >= $2::date)
         AND ($3::date IS NULL OR h.changedat < ($3::date + INTERVAL '1 day'))
         AND ($4::text IS NULL OR p.projectnumber ILIKE '%' || $4 || '%' OR p.projectname ILIKE '%' || $4 || '%')
       ORDER BY h.changedat DESC
       LIMIT $5 OFFSET $6`,
      [projectId || null, startDate || null, endDate || null, search || null, limit, offset]
    );
    const total = rows.length ? Number(rows[0].totalCount) : 0;
    res.json({
      rows: rows.map(({ totalCount, ...r }) => r),
      total, page, limit,
    });
  } catch (err) {
    console.error("[GET /api/reports/project-timeline] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/reports/stale-projects?page=&limit=
// Open projects (excludes Closed/Cancelled — nothing more is going to
// happen to those) ordered by how long they've sat without a logged
// status change: NULLS FIRST (never logged a change at all — the
// projectstatushistory table only started recording going forward, so
// most real projects will legitimately show "—" here for a while yet),
// then by entrydate ASC as a tiebreak among those — among projects with
// no tracked movement, the ones opened longest ago are the more
// plausible candidates for genuinely stale. Same { rows, total, page,
// limit } pagination shape as /project-timeline.
router.get("/stale-projects", requireModuleAccess("reports"), async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 5, 200);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const offset = (page - 1) * limit;
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.projectnumber AS code, p.projectname AS name, p.entrydate AS "entryDate",
              lsc.changedat AS "lastStatusChangeAt",
              COUNT(*) OVER() AS "totalCount"
       FROM projects p
       LEFT JOIN LATERAL (
         SELECT MAX(changedat) AS changedat FROM projectstatushistory h WHERE h.projectid = p.id
       ) lsc ON true
       WHERE p.projectstatusid::bigint NOT IN (
         SELECT id FROM projectstatus WHERE projectstatusdesc IN ('Closed', 'Cancelled')
       )
       ORDER BY lsc.changedat ASC NULLS FIRST, p.entrydate ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const total = rows.length ? Number(rows[0].totalCount) : 0;
    res.json({
      rows: rows.map(({ totalCount, ...r }) => r),
      total, page, limit,
    });
  } catch (err) {
    console.error("[GET /api/reports/stale-projects] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

module.exports = router;
