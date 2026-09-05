/**
 * /api/tasks — platform-wide task manager (CRM Phase C2).
 * ---------------------------------------------------------------------------
 * Deliberately not gated by requireModuleAccess() — a task can attach to a
 * customer/partner, a contact, a project, or nothing at all (entity_type /
 * entity_id, see the migration), so it isn't owned by any one module's
 * permission. Every authenticated employee can create tasks and manage
 * their own; requireAuth (mounted globally in server.js) is the only gate.
 *
 * Visibility: GET / defaults to "mine" (owned, collaborated on, or created
 * by the caller) unless the caller is an admin, or the query names an
 * explicit owner or an entity — a task list scoped to one record (e.g. a
 * customer/partner's "next actions" panel) shows everyone's tasks on that
 * record, not just the caller's, mirroring how contacts/notes on a
 * business partner aren't independently visibility-gated either.
 * ---------------------------------------------------------------------------
 */
const express = require("express");
const { pool } = require("../config/db");
const { logAudit } = require("../lib/audit");

const router = express.Router();

const TASK_SELECT = `
  SELECT t.id, t.title, t.description, t.status, t.priority,
         t.owner_employeeid AS "ownerEmployeeId",
         NULLIF(TRIM(CONCAT(owner.employeefirstname, ' ', owner.employeelastname)), '') AS "ownerName",
         t.due_date AS "dueDate", t.reminder_at AS "reminderAt",
         t.entity_type AS "entityType", t.entity_id AS "entityId",
         t.source_activityid AS "sourceActivityId",
         t.completed_at AS "completedAt",
         t.created_by AS "createdBy", t.created_at AS "createdAt",
         COALESCE(ARRAY_AGG(tc.employeeid) FILTER (WHERE tc.employeeid IS NOT NULL), '{}') AS "collaboratorIds"
  FROM tasks t
  LEFT JOIN employees owner ON owner.id = t.owner_employeeid
  LEFT JOIN task_collaborators tc ON tc.taskid = t.id
`;
const TASK_GROUP_BY = `GROUP BY t.id, owner.employeefirstname, owner.employeelastname`;

async function taskById(id) {
  const { rows } = await pool.query(`${TASK_SELECT} WHERE t.id = $1 ${TASK_GROUP_BY}`, [id]);
  return rows[0] || null;
}

// GET /api/tasks — filters: owner=me|<employeeId>|none, status, entityType,
// entityId, dueBefore (YYYY-MM-DD, inclusive).
router.get("/", async (req, res) => {
  const { owner, status, entityType, entityId, dueBefore } = req.query;
  const callerId = req.hittUser?.employeeId || null;
  const isAdmin = !!req.hittUser?.isAdmin;
  const conditions = [];
  const params = [];

  if (status) { params.push(status); conditions.push(`t.status = $${params.length}`); }
  if (entityType) { params.push(entityType); conditions.push(`t.entity_type = $${params.length}`); }
  if (entityId) { params.push(entityId); conditions.push(`t.entity_id = $${params.length}`); }
  if (dueBefore) { params.push(dueBefore); conditions.push(`t.due_date <= $${params.length}`); }

  if (owner === "me" && callerId) {
    params.push(callerId);
    conditions.push(`t.owner_employeeid = $${params.length}`);
  } else if (owner === "none") {
    conditions.push(`t.owner_employeeid IS NULL`);
  } else if (owner) {
    params.push(owner);
    conditions.push(`t.owner_employeeid = $${params.length}`);
  } else if (!isAdmin && !entityType && callerId) {
    // No explicit owner/entity filter, not admin: default to "mine" rather
    // than handing back every task in the system.
    params.push(callerId);
    conditions.push(`(t.owner_employeeid = $${params.length} OR t.created_by = $${params.length} OR EXISTS (
      SELECT 1 FROM task_collaborators c WHERE c.taskid = t.id AND c.employeeid = $${params.length}
    ))`);
  }

  try {
    const { rows } = await pool.query(
      `${TASK_SELECT}
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ${TASK_GROUP_BY}
       ORDER BY (t.status = 'open') DESC, t.due_date NULLS LAST, t.id DESC
       LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/tasks] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const task = await taskById(req.params.id);
    if (!task) return res.status(404).json({ error: "not_found" });
    res.json(task);
  } catch (err) {
    console.error("[GET /api/tasks/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

router.post("/", async (req, res) => {
  const {
    title, description, priority, ownerEmployeeId, dueDate, reminderAt,
    entityType, entityId, sourceActivityId, collaboratorEmployeeIds,
  } = req.body || {};
  if (!title || !title.trim()) {
    return res.status(400).json({ error: "validation_error", message: "title is required" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO tasks
         (title, description, priority, owner_employeeid, due_date, reminder_at,
          entity_type, entity_id, source_activityid, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [title.trim(), description || null, priority || null, ownerEmployeeId || null,
       dueDate || null, reminderAt || null, entityType || null, entityId || null,
       sourceActivityId || null, req.hittUser?.employeeId || null]
    );
    const taskId = rows[0].id;
    for (const empId of Array.isArray(collaboratorEmployeeIds) ? collaboratorEmployeeIds : []) {
      await client.query(
        `INSERT INTO task_collaborators (taskid, employeeid) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [taskId, empId]
      );
    }
    await client.query("COMMIT");
    const task = await taskById(taskId);
    res.status(201).json(task);
    logAudit(req, { kind: "task.insert", desc: `Created task "${task.title}"` });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[POST /api/tasks] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/tasks/:id — partial update. status:'done' sets completed_at
// (if not already done); moving off 'done' clears it. collaboratorEmployeeIds,
// when present, replaces the full collaborator list (not a merge).
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const {
    title, description, priority, ownerEmployeeId, dueDate, reminderAt,
    status, collaboratorEmployeeIds,
  } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: curRows } = await client.query(`SELECT status FROM tasks WHERE id = $1 FOR UPDATE`, [id]);
    if (!curRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_found" });
    }
    const cur = curRows[0];
    const nextStatus = status !== undefined ? status : cur.status;
    const completingNow = nextStatus === "done" && cur.status !== "done";
    const reopening = nextStatus !== "done" && cur.status === "done";

    await client.query(
      `UPDATE tasks SET
         title = COALESCE($1, title),
         description = CASE WHEN $2 THEN $3 ELSE description END,
         priority = CASE WHEN $4 THEN $5 ELSE priority END,
         owner_employeeid = CASE WHEN $6 THEN $7 ELSE owner_employeeid END,
         due_date = CASE WHEN $8 THEN $9 ELSE due_date END,
         reminder_at = CASE WHEN $10 THEN $11 ELSE reminder_at END,
         status = COALESCE($12, status),
         completed_at = CASE WHEN $13 THEN now() WHEN $14 THEN NULL ELSE completed_at END
       WHERE id = $15`,
      [title || null,
       description !== undefined, description || null,
       priority !== undefined, priority || null,
       ownerEmployeeId !== undefined, ownerEmployeeId || null,
       dueDate !== undefined, dueDate || null,
       reminderAt !== undefined, reminderAt || null,
       status || null,
       completingNow, reopening,
       id]
    );

    if (Array.isArray(collaboratorEmployeeIds)) {
      await client.query(`DELETE FROM task_collaborators WHERE taskid = $1`, [id]);
      for (const empId of collaboratorEmployeeIds) {
        await client.query(
          `INSERT INTO task_collaborators (taskid, employeeid) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [id, empId]
        );
      }
    }

    await client.query("COMMIT");
    const task = await taskById(id);
    res.json(task);
    if (completingNow) logAudit(req, { kind: "task.complete", desc: `Completed task "${task.title}"` });
    else if (reopening) logAudit(req, { kind: "task.reopen", desc: `Reopened task "${task.title}"` });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[PATCH /api/tasks/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(`DELETE FROM tasks WHERE id = $1 RETURNING title`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    res.status(204).end();
    logAudit(req, { kind: "task.delete", desc: `Deleted task "${rows[0].title}"` });
  } catch (err) {
    console.error("[DELETE /api/tasks/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

module.exports = router;
