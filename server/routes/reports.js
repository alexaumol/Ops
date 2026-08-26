/**
 * /api/reports
 * ---------------------------------------------------------------------------
 * New module (no direct Access precedent — closest analogue was
 * "TimeAllocationLog" report, a per-employee hours-by-week log, and the
 * "Holidays"/work-calendar admin forms). Two reports for now:
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
              COALESCE(SUM(t.projtimetrackhours), 0) AS "totalHours",
              COALESCE(SUM(t.projtimetrackhours) FILTER (WHERE t.po_res = 'PO'), 0) AS "poHours",
              COALESCE(SUM(t.projtimetrackhours) FILTER (WHERE t.po_res = 'RES'), 0) AS "resHours",
              COUNT(DISTINCT t.userid) AS "employeeCount"
       FROM projectstimetracking t
       JOIN projects p ON p.id = t.projectid::bigint
       LEFT JOIN projectstatus ps ON ps.id = p.projectstatusid::bigint
       WHERE ($1::date IS NULL OR t.projtimetrackdate >= $1::date)
         AND ($2::date IS NULL OR t.projtimetrackdate <= $2::date)
       GROUP BY p.id, p.projectnumber, p.projectname, ps.projectstatusdesc
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

module.exports = router;
