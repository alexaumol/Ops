/**
 * /api/time-off
 * ---------------------------------------------------------------------------
 * Time-off (PTO) requests. Mirrors Access's "TimeOffRequests.frm" — the
 * "Enter your time off requests" + balance-summary parts of it. Real
 * schema (confirmed 2026-08-25):
 *
 *   timeoffrequests       id, empid, startdate, enddate, daysrequested,
 *                         submittedat, approvedby, approvedat, rejectedby,
 *                         rejectedat, rejectcomment, withdrawnat, synced,
 *                         syncedat, calendar_event_id
 *   timeoffrequeststatus  id, timeoffreqid, statusid — one row per request
 *                         (not a history table — verified no duplicates)
 *   timeoffworkflowstatus id, workflowstatusdesc — 1 Not submitted,
 *                         2 Submitted, 3 Pending approval, 4 Approved,
 *                         5 Rejected, 6 Withdrawn, 7 Cancelled
 *   employeeworkcalendar  per employee per year: holidaysamount +
 *                         corporateholidaysamount = that year's allowance
 *
 * Approve/reject: rather than Access's manager-relationship concept (which
 * doesn't exist in this schema), approval rights come from the
 * timeoffapprovers allow-list (lib/permissions.js) — any approver can act
 * on anyone's request, mirroring how the global-admin override behaved in
 * Auth.bas. See INTERNAL.md.
 * ---------------------------------------------------------------------------
 */
const express = require("express");
const { pool } = require("../config/db");
const { requireModuleAccess, requireTimeOffApprover } = require("../lib/permissions");
const { logAudit } = require("../lib/audit");

const router = express.Router();

// Employee name + date range for a request, for audit descriptions.
async function timeOffAuditLabel(requestId) {
  try {
    const { rows } = await pool.query(
      `SELECT TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)) AS name,
              r.startdate, r.enddate, r.daysrequested AS days
       FROM timeoffrequests r LEFT JOIN employees e ON e.id = r.empid
       WHERE r.id = $1`,
      [requestId]
    );
    const r = rows[0];
    if (!r) return `request #${requestId}`;
    const range = `${r.startdate ? new Date(r.startdate).toISOString().slice(0, 10) : "?"}–${r.enddate ? new Date(r.enddate).toISOString().slice(0, 10) : "?"}`;
    return `${r.name || "an employee"}'s time off ${range} (${r.days ?? "?"}d)`;
  } catch {
    return `request #${requestId}`;
  }
}

// GET /api/time-off/requests/pending — cross-employee queue for approvers.
// Registered before the /:id routes so "pending" doesn't get swallowed as
// an :id param.
router.get("/requests/pending", requireTimeOffApprover(), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.empid, TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)) AS "employeeName",
              r.startdate, r.enddate, r.daysrequested, r.submittedat,
              s.statusid, ws.workflowstatusdesc AS "statusLabel"
       FROM timeoffrequests r
       LEFT JOIN timeoffrequeststatus s ON s.timeoffreqid = r.id
       LEFT JOIN timeoffworkflowstatus ws ON ws.id = s.statusid
       LEFT JOIN employees e ON e.id = r.empid
       WHERE s.statusid IN (2, 3)
       ORDER BY r.submittedat ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/time-off/requests/pending] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/time-off/requests?empId=X
router.get("/requests", requireModuleAccess("time-allocation"), async (req, res) => {
  const { empId } = req.query;
  if (!empId) return res.status(400).json({ error: "validation_error", message: "empId is required" });
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.startdate, r.enddate, r.daysrequested, r.submittedat,
              r.approvedat, r.rejectedat, r.rejectcomment, r.withdrawnat,
              s.statusid, ws.workflowstatusdesc AS "statusLabel"
       FROM timeoffrequests r
       LEFT JOIN timeoffrequeststatus s ON s.timeoffreqid = r.id
       LEFT JOIN timeoffworkflowstatus ws ON ws.id = s.statusid
       WHERE r.empid = $1
       ORDER BY r.startdate DESC`,
      [empId]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/time-off/requests] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// POST /api/time-off/requests — submit a new request (status: Submitted).
router.post("/requests", requireModuleAccess("time-allocation"), async (req, res) => {
  const { empId, startDate, endDate, daysRequested } = req.body || {};
  if (!empId || !startDate || !endDate || !daysRequested) {
    return res.status(400).json({ error: "validation_error", message: "empId, startDate, endDate and daysRequested are required" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO timeoffrequests (empid, startdate, enddate, daysrequested, submittedat)
       VALUES ($1, $2::date, $3::date, $4, now())
       RETURNING id, startdate, enddate, daysrequested, submittedat`,
      [empId, startDate, endDate, daysRequested]
    );
    const reqRow = rows[0];
    await client.query(
      `INSERT INTO timeoffrequeststatus (timeoffreqid, statusid) VALUES ($1, 2)`,
      [reqRow.id]
    );
    await client.query("COMMIT");
    res.status(201).json({ ...reqRow, statusid: 2, statusLabel: "Submitted" });
    logAudit(req, {
      kind: "timeoff.submit",
      desc: `Submitted time-off request ${startDate}–${endDate} (${daysRequested}d)`,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[POST /api/time-off/requests] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/time-off/requests/:id/withdraw — self-service withdraw. No
// approval step needed to pull your own request back.
router.patch("/requests/:id/withdraw", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE timeoffrequests SET withdrawnat = now() WHERE id = $1`, [req.params.id]);

    const existing = await client.query(
      `SELECT id FROM timeoffrequeststatus WHERE timeoffreqid = $1 LIMIT 1`, [req.params.id]
    );
    if (existing.rows.length) {
      await client.query(`UPDATE timeoffrequeststatus SET statusid = 6 WHERE id = $1`, [existing.rows[0].id]);
    } else {
      await client.query(`INSERT INTO timeoffrequeststatus (timeoffreqid, statusid) VALUES ($1, 6)`, [req.params.id]);
    }

    await client.query("COMMIT");
    res.status(204).end();
    timeOffAuditLabel(req.params.id).then((label) =>
      logAudit(req, { kind: "timeoff.withdraw", desc: `Withdrew ${label}` }));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[PATCH /api/time-off/requests/:id/withdraw] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/time-off/requests/:id/approve
router.patch("/requests/:id/approve", requireTimeOffApprover(), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE timeoffrequests SET approvedby = $2, approvedat = now() WHERE id = $1`,
      [req.params.id, req.hittUser.employeeId]
    );

    const existing = await client.query(
      `SELECT id FROM timeoffrequeststatus WHERE timeoffreqid = $1 LIMIT 1`, [req.params.id]
    );
    if (existing.rows.length) {
      await client.query(`UPDATE timeoffrequeststatus SET statusid = 4 WHERE id = $1`, [existing.rows[0].id]);
    } else {
      await client.query(`INSERT INTO timeoffrequeststatus (timeoffreqid, statusid) VALUES ($1, 4)`, [req.params.id]);
    }

    await client.query("COMMIT");
    res.status(204).end();
    timeOffAuditLabel(req.params.id).then((label) =>
      logAudit(req, { kind: "timeoff.approve", desc: `Approved ${label}` }));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[PATCH /api/time-off/requests/:id/approve] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/time-off/requests/:id/reject   { comment?: string }
router.patch("/requests/:id/reject", requireTimeOffApprover(), async (req, res) => {
  const { comment } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE timeoffrequests SET rejectedby = $2, rejectedat = now(), rejectcomment = $3 WHERE id = $1`,
      [req.params.id, req.hittUser.employeeId, comment || null]
    );

    const existing = await client.query(
      `SELECT id FROM timeoffrequeststatus WHERE timeoffreqid = $1 LIMIT 1`, [req.params.id]
    );
    if (existing.rows.length) {
      await client.query(`UPDATE timeoffrequeststatus SET statusid = 5 WHERE id = $1`, [existing.rows[0].id]);
    } else {
      await client.query(`INSERT INTO timeoffrequeststatus (timeoffreqid, statusid) VALUES ($1, 5)`, [req.params.id]);
    }

    await client.query("COMMIT");
    res.status(204).end();
    timeOffAuditLabel(req.params.id).then((label) =>
      logAudit(req, { kind: "timeoff.reject", desc: `Rejected ${label}${comment ? ` — "${comment}"` : ""}` }));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[PATCH /api/time-off/requests/:id/reject] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// GET /api/time-off/balance?empId=X&year=Y
router.get("/balance", async (req, res) => {
  const { empId, year } = req.query;
  if (!empId || !year) return res.status(400).json({ error: "validation_error", message: "empId and year are required" });
  try {
    let calendar = await pool.query(
      `SELECT holidaysamount, corporateholidaysamount FROM employeeworkcalendar WHERE empid = $1 AND workyear = $2 LIMIT 1`,
      [empId, year]
    );
    // Fall back to the org-wide row managed in Settings → Work calendar
    // when this employee has no per-person calendar entry for the year.
    if (!calendar.rows.length) {
      calendar = await pool.query(
        `SELECT holidaysamount, corporateholidaysamount FROM corporateworkcalendar WHERE workyear = $1 LIMIT 1`,
        [year]
      );
    }
    const totalDays = calendar.rows.length
      ? Number(calendar.rows[0].holidaysamount || 0) + Number(calendar.rows[0].corporateholidaysamount || 0)
      : null;

    const usage = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN s.statusid = 4 THEN r.daysrequested ELSE 0 END), 0) AS "approvedDays",
         COALESCE(SUM(CASE WHEN s.statusid IN (2, 3) THEN r.daysrequested ELSE 0 END), 0) AS "pendingDays"
       FROM timeoffrequests r
       LEFT JOIN timeoffrequeststatus s ON s.timeoffreqid = r.id
       WHERE r.empid = $1 AND EXTRACT(YEAR FROM r.startdate) = $2`,
      [empId, year]
    );
    const approvedDays = Number(usage.rows[0].approvedDays);
    const pendingDays = Number(usage.rows[0].pendingDays);

    res.json({
      totalDays,
      approvedDays,
      pendingDays,
      availableDays: totalDays === null ? null : totalDays - approvedDays - pendingDays,
    });
  } catch (err) {
    console.error("[GET /api/time-off/balance] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

module.exports = router;
