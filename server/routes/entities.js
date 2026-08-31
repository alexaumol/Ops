/**
 * /api/entities — the customer's billing entities (Settings → Entities).
 * ---------------------------------------------------------------------------
 * Backs a multi-organization setup: each legal entity that issues invoices
 * has its own letterhead (legal name / VAT / address / invoicing email /
 * webpage), bank account, and invoice logo. All of it is stamped onto the
 * invoice PDF (see server/lib/invoicePdf.js).
 *
 * Real schema:
 *   entity      id, entitydesc   — extended below with the letterhead
 *               columns (legalname, vatnumber, address, emailinvoicing,
 *               webpage, logo) via ensureEntitySchema().
 *   bankaccts   id, entityid, bankname, bankaddrline1, bankaddrline2,
 *               iban, bicswift, acctid   — one row per entity here.
 *
 * Admin only. The invoicing route reads these columns straight from the DB
 * when it builds a PDF; it doesn't call this router.
 * ---------------------------------------------------------------------------
 */
const express = require("express");
const { pool } = require("../config/db");
const { requireAdmin } = require("../lib/permissions");
const { ensureEntitySchema } = require("../lib/entitySchema");
const { logAudit } = require("../lib/audit");

const router = express.Router();
router.use(requireAdmin);

// pdfkit only renders PNG / JPEG, so that's all an entity logo may be.
const LOGO_RE = /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=\s]+$/;
const MAX_LOGO_CHARS = 2 * 1024 * 1024;

const trimOrNull = (v) => {
  const s = (v == null ? "" : String(v)).trim();
  return s === "" ? null : s;
};

const MAIL_TRANSPORTS = ["graph", "smtp"];
function mailTransport(v) {
  const s = trimOrNull(v);
  return s && MAIL_TRANSPORTS.includes(s.toLowerCase()) ? s.toLowerCase() : null;
}

function entityFields(body) {
  const b = body || {};
  return {
    entitydesc: trimOrNull(b.entitydesc),
    legalname: trimOrNull(b.legalname),
    vatnumber: trimOrNull(b.vatnumber),
    address: trimOrNull(b.address),
    emailinvoicing: trimOrNull(b.emailinvoicing),
    webpage: trimOrNull(b.webpage),
    mailtransport: mailTransport(b.mailtransport),
    mailsender: trimOrNull(b.mailsender),
  };
}

function bankFields(body) {
  const b = (body && body.bank) || {};
  return {
    bankname: trimOrNull(b.bankname),
    bankaddrline1: trimOrNull(b.bankaddrline1),
    bankaddrline2: trimOrNull(b.bankaddrline2),
    iban: trimOrNull(b.iban),
    bicswift: trimOrNull(b.bicswift),
  };
}

// Validates the `logo` field of a request body:
//   undefined      -> caller didn't send it, leave the stored value alone
//   ""  / null     -> clear the stored logo
//   data:image/... -> new logo (size-checked)
// Returns { skip } | { value: string|null } | { error: string }.
function logoUpdate(body) {
  if (!body || !("logo" in body)) return { skip: true };
  const raw = body.logo;
  if (raw == null || raw === "") return { value: null };
  const s = String(raw).trim();
  if (!LOGO_RE.test(s)) return { error: "The logo must be a PNG or JPEG image." };
  if (s.length > MAX_LOGO_CHARS) return { error: "That logo image is too large — use a smaller file." };
  return { value: s };
}

async function upsertBank(client, entityId, bank) {
  const existing = await client.query(`SELECT id FROM bankaccts WHERE entityid = $1 ORDER BY id LIMIT 1`, [entityId]);
  const vals = [bank.bankname, bank.bankaddrline1, bank.bankaddrline2, bank.iban, bank.bicswift];
  if (existing.rows.length) {
    await client.query(
      `UPDATE bankaccts SET bankname = $1, bankaddrline1 = $2, bankaddrline2 = $3, iban = $4, bicswift = $5
       WHERE id = $6`,
      [...vals, existing.rows[0].id]
    );
  } else if (vals.some((v) => v != null)) {
    await client.query(
      `INSERT INTO bankaccts (entityid, acctid, bankname, bankaddrline1, bankaddrline2, iban, bicswift)
       VALUES ($1, (SELECT COALESCE(MAX(acctid), 0) + 1 FROM bankaccts), $2, $3, $4, $5, $6, $7)`,
      [entityId, ...vals]
    );
  }
}

const LIST_SELECT = `
  SELECT e.id, e.entitydesc, e.legalname, e.vatnumber, e.address,
         e.emailinvoicing, e.webpage, e.mailtransport, e.mailsender,
         (e.logo IS NOT NULL AND e.logo <> '') AS "hasLogo",
         b.bankname, b.bankaddrline1, b.bankaddrline2, b.iban, b.bicswift,
         COALESCE(p.n, 0)::int AS "projectCount"
  FROM entity e
  LEFT JOIN LATERAL (SELECT * FROM bankaccts WHERE entityid = e.id ORDER BY id LIMIT 1) b ON true
  LEFT JOIN LATERAL (SELECT COUNT(*) AS n FROM projects WHERE entityid::bigint = e.id) p ON true
`;

function shapeRow(r) {
  return {
    id: r.id,
    entitydesc: r.entitydesc,
    legalname: r.legalname,
    vatnumber: r.vatnumber,
    address: r.address,
    emailinvoicing: r.emailinvoicing,
    webpage: r.webpage,
    mailtransport: r.mailtransport || null,
    mailsender: r.mailsender || null,
    hasLogo: !!r.hasLogo,
    projectCount: Number(r.projectCount) || 0,
    bank: {
      bankname: r.bankname || null,
      bankaddrline1: r.bankaddrline1 || null,
      bankaddrline2: r.bankaddrline2 || null,
      iban: r.iban || null,
      bicswift: r.bicswift || null,
    },
  };
}

// GET /api/entities — list (logos excluded; hasLogo flag instead)
router.get("/", async (req, res) => {
  try {
    await ensureEntitySchema();
    const { rows } = await pool.query(`${LIST_SELECT} ORDER BY e.id`);
    res.json(rows.map(shapeRow));
  } catch (err) {
    console.error("[GET /api/entities] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// GET /api/entities/:id — full detail, including the logo data URL
router.get("/:id", async (req, res) => {
  try {
    await ensureEntitySchema();
    const { rows } = await pool.query(`${LIST_SELECT} WHERE e.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "not_found", message: "Entity not found." });
    const { rows: logoRows } = await pool.query(`SELECT logo FROM entity WHERE id = $1`, [req.params.id]);
    res.json({ ...shapeRow(rows[0]), logo: logoRows[0]?.logo || null });
  } catch (err) {
    console.error("[GET /api/entities/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// POST /api/entities
router.post("/", async (req, res) => {
  const f = entityFields(req.body);
  if (!f.entitydesc) {
    return res.status(400).json({ error: "bad_request", message: "A short entity name is required." });
  }
  const logo = logoUpdate(req.body);
  if (logo.error) return res.status(400).json({ error: "bad_request", message: logo.error });

  const client = await pool.connect();
  try {
    await ensureEntitySchema();
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO entity (entitydesc, legalname, vatnumber, address, emailinvoicing, webpage, mailtransport, mailsender, logo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [f.entitydesc, f.legalname, f.vatnumber, f.address, f.emailinvoicing, f.webpage, f.mailtransport, f.mailsender, logo.skip ? null : logo.value]
    );
    const id = rows[0].id;
    await upsertBank(client, id, bankFields(req.body));
    await client.query("COMMIT");
    const { rows: full } = await pool.query(`${LIST_SELECT} WHERE e.id = $1`, [id]);
    res.status(201).json(shapeRow(full[0]));
    logAudit(req, { kind: "settings.entity", desc: `Added entity "${f.entitydesc}"` });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[POST /api/entities] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/entities/:id
router.patch("/:id", async (req, res) => {
  const f = entityFields(req.body);
  if (!f.entitydesc) {
    return res.status(400).json({ error: "bad_request", message: "A short entity name is required." });
  }
  const logo = logoUpdate(req.body);
  if (logo.error) return res.status(400).json({ error: "bad_request", message: logo.error });

  const client = await pool.connect();
  try {
    await ensureEntitySchema();
    await client.query("BEGIN");
    const sets = [
      "entitydesc = $1", "legalname = $2", "vatnumber = $3",
      "address = $4", "emailinvoicing = $5", "webpage = $6",
      "mailtransport = $7", "mailsender = $8",
    ];
    const params = [f.entitydesc, f.legalname, f.vatnumber, f.address, f.emailinvoicing, f.webpage, f.mailtransport, f.mailsender];
    if (!logo.skip) {
      params.push(logo.value);
      sets.push(`logo = $${params.length}`);
    }
    params.push(req.params.id);
    const { rowCount } = await client.query(
      `UPDATE entity SET ${sets.join(", ")} WHERE id = $${params.length}`,
      params
    );
    if (!rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_found", message: "Entity not found." });
    }
    await upsertBank(client, req.params.id, bankFields(req.body));
    await client.query("COMMIT");
    const { rows: full } = await pool.query(`${LIST_SELECT} WHERE e.id = $1`, [req.params.id]);
    res.json(shapeRow(full[0]));
    logAudit(req, { kind: "settings.entity", desc: `Edited entity "${f.entitydesc}"` });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[PATCH /api/entities/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/entities/:id — blocked while any project still uses it.
router.delete("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureEntitySchema();
    const used = await client.query(
      `SELECT 1 FROM projects WHERE entityid::bigint = $1::bigint LIMIT 1`, [req.params.id]
    );
    if (used.rows.length) {
      return res.status(409).json({ error: "conflict", message: "This entity is used by at least one project and can't be deleted." });
    }
    await client.query("BEGIN");
    await client.query(`DELETE FROM bankaccts WHERE entityid = $1`, [req.params.id]);
    const { rows } = await client.query(`DELETE FROM entity WHERE id = $1 RETURNING entitydesc`, [req.params.id]);
    await client.query("COMMIT");
    if (!rows.length) return res.status(404).json({ error: "not_found", message: "Entity not found." });
    res.status(204).end();
    logAudit(req, { kind: "settings.entity", desc: `Deleted entity "${rows[0].entitydesc || "—"}"` });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[DELETE /api/entities/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
