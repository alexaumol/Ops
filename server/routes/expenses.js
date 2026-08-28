/**
 * /api/expenses
 * ---------------------------------------------------------------------------
 * Company expense records — meals with customers, hotels, flights, car
 * rentals, materials, etc. Most are bound to a project; internal expenses
 * (water supply, employee amenities, …) have projectid NULL.
 *
 * Wired to the pre-existing schema:
 *   expenses            id, picturetitle (evidence file's original name),
 *                       projectid, employeeid, amount, categoryid, expensets,
 *                       ticketurl (stored filename), ticketfolderpath,
 *                       comments (the description), invoiceable, countedat,
 *                       countedby
 *   expensescategories  id, categorydesc  — managed on Settings → Expense
 *                       categories
 *
 * One optional evidence document per expense (image or PDF), stored on the
 * API host under UPLOAD_DIR/expenses (never in the repo — see .gitignore)
 * and streamed back through GET /:id/document. MIME is inferred from the
 * stored file's extension (the schema has no mime column).
 * ---------------------------------------------------------------------------
 */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const { pool } = require("../config/db");
const { requireModuleAccess } = require("../lib/permissions");
const { logAudit } = require("../lib/audit");

// multer is only needed for evidence uploads. If it's missing (server not
// `npm install`ed yet) the module still runs — list + no-file CRUD work,
// upload/replace endpoints return 503 until it's installed.
let multer = null;
try { multer = require("multer"); }
catch { console.error("[expenses] multer not installed — evidence uploads disabled. Run `npm install` in server/."); }

const router = express.Router();
router.use(requireModuleAccess("expenses"));

const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR, "expenses")
  : path.join(__dirname, "..", "uploads", "expenses");
let uploadsReady = false;
try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  uploadsReady = !!multer;
} catch (e) {
  console.error(`[expenses] upload dir "${UPLOAD_DIR}" not available — uploads disabled:`, e.message);
}

const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif",
]);
const EXT_MIME = {
  ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
  ".heic": "image/heic", ".heif": "image/heif",
};
const mimeFor = (name) => EXT_MIME[path.extname(name || "").toLowerCase()] || "application/octet-stream";

const upload = multer && multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "").slice(0, 12).replace(/[^.\w]/g, "");
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) =>
    ALLOWED_MIME.has(file.mimetype) ? cb(null, true) : cb(new Error("Only images or PDF files are allowed.")),
});

// Parses a multipart body (with the optional `document` file). A JSON body
// passes straight through. When uploads aren't available, a multipart
// request is rejected with a clear 503 but JSON still works.
const acceptDocument = uploadsReady
  ? (req, res, next) =>
      upload.single("document")(req, res, (err) => {
        if (err) return res.status(400).json({ error: "upload_error", message: err.message });
        next();
      })
  : (req, res, next) => {
      if (req.is("multipart/form-data")) {
        return res.status(503).json({
          error: "uploads_unavailable",
          message: "Evidence uploads aren't available yet — the server needs `npm install` (multer).",
        });
      }
      next();
    };

function removeFileQuietly(storedName) {
  if (!storedName) return;
  fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(storedName))).catch(() => {});
}

const num = (v) => (v === "" || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const bool = (v) => v === true || v === "true" || v === "1" || v === 1;

function expenseBody(req) {
  const b = req.body || {};
  const isInternal = bool(b.isInternal);
  return {
    expenseDate: b.expenseDate || null,
    categoryId: num(b.categoryId),
    description: (b.description || "").trim() || null,
    amount: num(b.amount),
    projectId: isInternal ? null : num(b.projectId),
    isInternal,
    paidBy: num(b.paidBy),
    invoiceable: b.invoiceable === undefined ? null : bool(b.invoiceable),
  };
}

const EXPENSE_SELECT = `
  SELECT x.id,
         TO_CHAR(x.expensets, 'YYYY-MM-DD') AS "expenseDate",
         x.categoryid AS "categoryId", c.categorydesc AS "category",
         x.comments AS "description",
         x.amount, 'EUR' AS currency,
         (x.projectid IS NULL) AS "isInternal",
         x.projectid AS "projectId", p.projectnumber AS "projectCode", p.projectname AS "projectName",
         x.employeeid AS "paidById",
         NULLIF(TRIM(CONCAT(e.employeefirstname, ' ', e.employeelastname)), '') AS "paidByName",
         x.invoiceable AS "invoiceable",
         (x.ticketurl IS NOT NULL AND x.ticketurl <> '') AS "hasDocument",
         x.picturetitle AS "documentName",
         x.countedat AS "countedAt"
  FROM expenses x
  LEFT JOIN expensescategories c ON c.id = x.categoryid::bigint
  LEFT JOIN projects p ON p.id = x.projectid::bigint
  LEFT JOIN employees e ON e.id = x.employeeid::bigint
`;

async function expenseRow(id) {
  const { rows } = await pool.query(`${EXPENSE_SELECT} WHERE x.id = $1`, [id]);
  return rows[0] || null;
}

/* ============================== LIST ================================== */
// GET /api/expenses?search=&projectId=&categoryId=&scope=&startDate=&endDate=&page=&limit=
router.get("/", async (req, res) => {
  try {
    const { search, projectId, categoryId, scope, startDate, endDate } = req.query;
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const offset = (page - 1) * limit;

    const where = [];
    const fp = [];
    const P = (v) => { fp.push(v); return `$${fp.length}`; };

    if (search) {
      const t = P(search);
      where.push(`(x.comments ILIKE '%'||${t}||'%' OR c.categorydesc ILIKE '%'||${t}||'%'
                   OR p.projectnumber ILIKE '%'||${t}||'%' OR p.projectname ILIKE '%'||${t}||'%')`);
    }
    if (projectId) where.push(`x.projectid::bigint = ${P(projectId)}::bigint`);
    if (categoryId) where.push(`x.categoryid::bigint = ${P(categoryId)}::bigint`);
    if (scope === "internal") where.push("x.projectid IS NULL");
    if (scope === "project") where.push("x.projectid IS NOT NULL");
    if (startDate) where.push(`x.expensets::date >= ${P(startDate)}::date`);
    if (endDate) where.push(`x.expensets::date <= ${P(endDate)}::date`);

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const { rows } = await pool.query(
      `${EXPENSE_SELECT}, COUNT(*) OVER() AS "totalCount"
       ${whereSql}
       ORDER BY x.expensets DESC NULLS LAST, x.id DESC
       LIMIT $${fp.length + 1} OFFSET $${fp.length + 2}`,
      [...fp, limit, offset]
    );
    const total = rows.length ? Number(rows[0].totalCount) : 0;
    const sumRes = await pool.query(
      `SELECT COALESCE(SUM(x.amount), 0) AS total
       FROM expenses x
       LEFT JOIN expensescategories c ON c.id = x.categoryid::bigint
       LEFT JOIN projects p ON p.id = x.projectid::bigint
       ${whereSql}`,
      fp
    );
    res.json({
      rows: rows.map(({ totalCount, ...r }) => r),
      total, page, limit,
      sum: Number(sumRes.rows[0].total),
    });
  } catch (err) {
    console.error("[GET /api/expenses] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/expenses/categories — the vocabulary, for the form + filter.
router.get("/categories", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, categorydesc AS name FROM expensescategories ORDER BY categorydesc`
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /api/expenses/categories] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

/* ============================== CREATE / EDIT ========================= */
router.post("/", acceptDocument, async (req, res) => {
  try {
    const b = expenseBody(req);
    if (b.amount == null) {
      removeFileQuietly(req.file?.filename);
      return res.status(400).json({ error: "validation_error", message: "An amount is required." });
    }
    const { rows } = await pool.query(
      `INSERT INTO expenses
         (expensets, categoryid, comments, amount, projectid, employeeid, invoiceable,
          ticketurl, picturetitle, ticketfolderpath)
       VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        b.expenseDate, b.categoryId, b.description, b.amount, b.projectId, b.paidBy,
        b.invoiceable == null ? false : b.invoiceable,
        req.file?.filename ?? null,
        req.file ? (req.file.originalname || "").slice(0, 255) : null,
        req.file ? "expenses" : null,
      ]
    );
    const row = await expenseRow(rows[0].id);
    res.status(201).json(row);
    logAudit(req, {
      kind: "expense.create",
      desc: `Added expense${row.category ? ` (${row.category})` : ""} EUR ${b.amount}` +
        (row.projectCode ? ` on project ${row.projectCode}` : b.isInternal ? " (internal)" : ""),
    });
  } catch (err) {
    removeFileQuietly(req.file?.filename);
    console.error("[POST /api/expenses] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

router.patch("/:id", acceptDocument, async (req, res) => {
  try {
    const { rows: curRows } = await pool.query(
      `SELECT ticketurl FROM expenses WHERE id = $1`, [req.params.id]
    );
    if (!curRows.length) {
      removeFileQuietly(req.file?.filename);
      return res.status(404).json({ error: "not_found", message: "Expense not found." });
    }
    const oldDoc = curRows[0].ticketurl;
    const b = expenseBody(req);
    if (b.amount == null) {
      removeFileQuietly(req.file?.filename);
      return res.status(400).json({ error: "validation_error", message: "An amount is required." });
    }

    await pool.query(
      `UPDATE expenses SET
         expensets = $1::date, categoryid = $2, comments = $3, amount = $4,
         projectid = $5, employeeid = $6,
         invoiceable = COALESCE($7, invoiceable),
         ticketurl = COALESCE($8, ticketurl),
         picturetitle = COALESCE($9, picturetitle),
         ticketfolderpath = COALESCE($10, ticketfolderpath)
       WHERE id = $11`,
      [
        b.expenseDate, b.categoryId, b.description, b.amount, b.projectId, b.paidBy, b.invoiceable,
        req.file?.filename ?? null,
        req.file ? (req.file.originalname || "").slice(0, 255) : null,
        req.file ? "expenses" : null,
        req.params.id,
      ]
    );
    if (req.file && oldDoc && oldDoc !== req.file.filename) removeFileQuietly(oldDoc);

    const row = await expenseRow(req.params.id);
    res.json(row);
    logAudit(req, {
      kind: req.file ? "expense.document" : "expense.update",
      desc: `${req.file ? "Replaced the evidence on" : "Edited"} expense #${req.params.id}` +
        (row.category ? ` (${row.category})` : ""),
    });
  } catch (err) {
    removeFileQuietly(req.file?.filename);
    console.error("[PATCH /api/expenses/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT x.ticketurl, c.categorydesc AS category
       FROM expenses x LEFT JOIN expensescategories c ON c.id = x.categoryid::bigint
       WHERE x.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found", message: "Expense not found." });
    await pool.query(`DELETE FROM expenses WHERE id = $1`, [req.params.id]);
    removeFileQuietly(rows[0].ticketurl);
    res.status(204).end();
    logAudit(req, { kind: "expense.delete", desc: `Deleted expense #${req.params.id}${rows[0].category ? ` (${rows[0].category})` : ""}` });
  } catch (err) {
    console.error("[DELETE /api/expenses/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

/* ============================== BULK ================================= */
// POST /api/expenses/bulk  { action: 'delete' | 'update', ids: [...], patch: {...} }
router.post("/bulk", async (req, res) => {
  const { action, ids, patch } = req.body || {};
  const idList = Array.isArray(ids) ? ids.map(Number).filter(Number.isInteger) : [];
  if (!idList.length) return res.status(400).json({ error: "validation_error", message: "No expenses selected." });

  try {
    if (action === "delete") {
      const { rows } = await pool.query(
        `DELETE FROM expenses WHERE id = ANY($1::bigint[]) RETURNING ticketurl`, [idList]
      );
      rows.forEach((r) => removeFileQuietly(r.ticketurl));
      res.json({ affected: rows.length });
      logAudit(req, { kind: "expense.bulk", desc: `Bulk-deleted ${rows.length} expense(s)` });
      return;
    }
    if (action === "update") {
      const p = patch || {};
      const sets = [];
      const params = [];
      const set = (sql, val) => { params.push(val); sets.push(sql.replace("?", `$${params.length}`)); };

      if (p.categoryId !== undefined) set("categoryid = ?", num(p.categoryId));
      if (p.projectId !== undefined || p.isInternal !== undefined) {
        set("projectid = ?", bool(p.isInternal) ? null : num(p.projectId));
      }
      if (p.paidBy !== undefined) set("employeeid = ?", num(p.paidBy));
      if (p.invoiceable !== undefined) set("invoiceable = ?", bool(p.invoiceable));
      if (p.expenseDate !== undefined) set("expensets = ?::date", p.expenseDate || null);
      if (!sets.length) return res.status(400).json({ error: "validation_error", message: "Nothing to update." });

      params.push(idList);
      const { rowCount } = await pool.query(
        `UPDATE expenses SET ${sets.join(", ")} WHERE id = ANY($${params.length}::bigint[])`, params
      );
      res.json({ affected: rowCount });
      logAudit(req, { kind: "expense.bulk", desc: `Bulk-updated ${rowCount} expense(s)` });
      return;
    }
    res.status(400).json({ error: "validation_error", message: "action must be 'delete' or 'update'." });
  } catch (err) {
    console.error("[POST /api/expenses/bulk] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

/* ============================== DOCUMENT ============================= */
// GET /api/expenses/:id/document — stream the evidence inline.
router.get("/:id/document", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ticketurl, picturetitle FROM expenses WHERE id = $1`, [req.params.id]
    );
    if (!rows.length || !rows[0].ticketurl) return res.status(404).json({ error: "not_found" });
    const stored = path.basename(rows[0].ticketurl);
    const abs = path.join(UPLOAD_DIR, stored);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: "not_found", message: "File missing on disk." });
    res.setHeader("Content-Type", mimeFor(stored));
    res.setHeader("Content-Disposition", `inline; filename="${(rows[0].picturetitle || "evidence").replace(/["\r\n]/g, "")}"`);
    fs.createReadStream(abs).pipe(res);
  } catch (err) {
    console.error("[GET /api/expenses/:id/document] error:", err.message);
    res.status(502).json({ error: "server_error", message: err.message });
  }
});

// DELETE /api/expenses/:id/document — remove the evidence file + refs.
router.delete("/:id/document", async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT ticketurl FROM expenses WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    await pool.query(
      `UPDATE expenses SET ticketurl = NULL, picturetitle = NULL, ticketfolderpath = NULL WHERE id = $1`,
      [req.params.id]
    );
    removeFileQuietly(rows[0].ticketurl);
    res.status(204).end();
    logAudit(req, { kind: "expense.document", desc: `Removed the evidence from expense #${req.params.id}` });
  } catch (err) {
    console.error("[DELETE /api/expenses/:id/document] error:", err.message);
    res.status(502).json({ error: "server_error", message: err.message });
  }
});

module.exports = router;
