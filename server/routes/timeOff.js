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
 * Scope note: this covers self-service submit/view/withdraw only.
 * Approve/reject is NOT built — Access's workflow needs a "who can
 * approve whose requests" concept (a manager relationship) that doesn't
 * exist anywhere in this schema or app yet. See INTERNAL.md.
 * ---------------------------------------------------------------------------
 */
const express = require("express");
const { pool } = require("../config/db");

const router = express.Router();

// GET /api/time-off/requests?empId=X
router.get("/requests", async (req, res) => {
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
router.post("/requests", async (req, res) => {
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
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[PATCH /api/time-off/requests/:id/withdraw] DB error:", err.message);
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
    const calendar = await pool.query(
      `SELECT holidaysamount, corporateholidaysamount FROM employeeworkcalendar WHERE empid = $1 AND workyear = $2 LIMIT 1`,
      [empId, year]
    );
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
