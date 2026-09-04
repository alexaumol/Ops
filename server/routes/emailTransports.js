/**
 * /api/settings/email-transports — admin CRUD for DB-managed email transports
 * (Settings -> Email). Mounted under settings.js, so requireAdmin already
 * applies.
 *
 * Secrets (Graph client secret, SMTP password) are AES-256-GCM-encrypted at
 * rest (server/lib/secrets.js) and NEVER returned by the API — the list
 * reports `graphSecretSet` / `smtpPassSet` booleans instead. On update a
 * secret field follows the same rule as the Veri*Factu API key: a non-empty
 * value sets it, "" clears it, omitted leaves it unchanged.
 * ---------------------------------------------------------------------------
 */
const express = require("express");
const { pool } = require("../config/db");
const { logAudit } = require("../lib/audit");
const secrets = require("../lib/secrets");
const et = require("../lib/emailTransport");

const router = express.Router();

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const str = (v) => (typeof v === "string" ? v.trim() : "");
const KINDS = new Set(["graph", "smtp"]);

// Fields a create/update accepts, by kind. Secrets handled separately.
function readCommon(b) {
  return {
    name: str(b.name),
    from_address: str(b.fromAddress || b.from_address),
    active: b.active === undefined ? true : !!b.active,
  };
}

async function nameTaken(name, exceptId = null) {
  const { rows } = await pool.query(
    `SELECT 1 FROM email_transports WHERE lower(name) = lower($1) AND id <> COALESCE($2, -1)`,
    [name, exceptId]
  );
  return rows.length > 0;
}

// GET /  — list (no secrets) + the app-level default id.
router.get("/", async (req, res) => {
  try {
    const [transports, defaultTransportId] = await Promise.all([
      et.listTransports(pool),
      et.getDefaultTransportId(pool),
    ]);
    res.json({ transports, defaultTransportId, secretsReady: secrets.secretsReady() });
  } catch (err) {
    console.error("[GET /api/settings/email-transports] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// POST /  — create a transport.
router.post("/", async (req, res) => {
  const b = req.body || {};
  const kind = str(b.kind);
  const c = readCommon(b);

  if (!KINDS.has(kind)) return res.status(400).json({ error: "bad_request", message: "kind must be 'graph' or 'smtp'." });
  if (!c.name) return res.status(400).json({ error: "bad_request", message: "A name is required." });
  if (!EMAIL_RE.test(c.from_address)) return res.status(400).json({ error: "bad_request", message: "A valid From address is required." });

  const graphSecret = str(b.graphClientSecret);
  const smtpPass = str(b.smtpPass);
  const needsSecret = kind === "graph" ? graphSecret : smtpPass;
  if (needsSecret && !secrets.secretsReady()) {
    return res.status(400).json({ error: "no_key", message: `Can't store the secret: ${secrets.secretsKeyError()}. Set APP_ENCRYPTION_KEY in the server env.` });
  }

  let row = {
    name: c.name, kind, from_address: c.from_address, active: c.active,
    graph_tenant_id: null, graph_client_id: null, graph_client_secret: null,
    smtp_host: null, smtp_port: null, smtp_user: null, smtp_pass: null, smtp_secure: false,
  };

  if (kind === "graph") {
    row.graph_tenant_id = str(b.graphTenantId) || null;
    row.graph_client_id = str(b.graphClientId) || null;
    if (!row.graph_tenant_id || !row.graph_client_id) {
      return res.status(400).json({ error: "bad_request", message: "Graph transports need a tenant id and a client id." });
    }
    row.graph_client_secret = graphSecret ? secrets.encryptSecret(graphSecret) : null;
  } else {
    row.smtp_host = str(b.smtpHost) || null;
    row.smtp_user = str(b.smtpUser) || null;
    row.smtp_port = Number(b.smtpPort) || 587;
    row.smtp_secure = !!b.smtpSecure;
    if (!row.smtp_host || !row.smtp_user) {
      return res.status(400).json({ error: "bad_request", message: "SMTP transports need a host and a username." });
    }
    row.smtp_pass = smtpPass ? secrets.encryptSecret(smtpPass) : null;
  }

  try {
    if (await nameTaken(c.name)) return res.status(409).json({ error: "conflict", message: "A transport with that name already exists." });
    const { rows } = await pool.query(
      `INSERT INTO email_transports
         (name, kind, from_address, active, graph_tenant_id, graph_client_id, graph_client_secret,
          smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [row.name, row.kind, row.from_address, row.active, row.graph_tenant_id, row.graph_client_id, row.graph_client_secret,
       row.smtp_host, row.smtp_port, row.smtp_user, row.smtp_pass, row.smtp_secure, req.hittUser.employeeId || null]
    );
    res.status(201).json(et.toSafe(rows[0]));
    logAudit(req, { kind: "settings.email-transport", desc: `Created email transport "${row.name}" (${kind})`, level: 2 });
  } catch (err) {
    console.error("[POST /api/settings/email-transports] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// PATCH /:id  — partial update. Secret fields: non-empty sets, "" clears,
// omitted leaves.
router.patch("/:id", async (req, res) => {
  const b = req.body || {};
  const id = Number(req.params.id);
  try {
    const existing = await et.getRow(pool, id);
    if (!existing) return res.status(404).json({ error: "not_found", message: "Transport not found." });

    const sets = [];
    const params = [];
    const push = (frag, val) => { params.push(val); sets.push(`${frag} = $${params.length}`); };
    const changed = [];

    if (b.name !== undefined) {
      const name = str(b.name);
      if (!name) return res.status(400).json({ error: "bad_request", message: "Name can't be empty." });
      if (await nameTaken(name, id)) return res.status(409).json({ error: "conflict", message: "Another transport has that name." });
      push("name", name); changed.push("name");
    }
    if (b.fromAddress !== undefined || b.from_address !== undefined) {
      const from = str(b.fromAddress || b.from_address);
      if (!EMAIL_RE.test(from)) return res.status(400).json({ error: "bad_request", message: "From address is not valid." });
      push("from_address", from); changed.push("from");
    }
    if (b.active !== undefined) { push("active", !!b.active); changed.push(`active=${!!b.active}`); }

    if (existing.kind === "graph") {
      if (b.graphTenantId !== undefined) { push("graph_tenant_id", str(b.graphTenantId) || null); changed.push("tenant id"); }
      if (b.graphClientId !== undefined) { push("graph_client_id", str(b.graphClientId) || null); changed.push("client id"); }
      if (typeof b.graphClientSecret === "string") {
        const s = b.graphClientSecret.trim();
        if (s && !secrets.secretsReady()) return res.status(400).json({ error: "no_key", message: `Can't store the secret: ${secrets.secretsKeyError()}.` });
        push("graph_client_secret", s ? secrets.encryptSecret(s) : null);
        changed.push(s ? "client secret set" : "client secret cleared");
      }
    } else {
      if (b.smtpHost !== undefined) { push("smtp_host", str(b.smtpHost) || null); changed.push("host"); }
      if (b.smtpPort !== undefined) { push("smtp_port", Number(b.smtpPort) || 587); changed.push("port"); }
      if (b.smtpUser !== undefined) { push("smtp_user", str(b.smtpUser) || null); changed.push("user"); }
      if (b.smtpSecure !== undefined) { push("smtp_secure", !!b.smtpSecure); changed.push("secure"); }
      if (typeof b.smtpPass === "string") {
        const s = b.smtpPass.trim();
        if (s && !secrets.secretsReady()) return res.status(400).json({ error: "no_key", message: `Can't store the secret: ${secrets.secretsKeyError()}.` });
        push("smtp_pass", s ? secrets.encryptSecret(s) : null);
        changed.push(s ? "password set" : "password cleared");
      }
    }

    if (!sets.length) return res.status(400).json({ error: "bad_request", message: "Nothing to update." });
    params.push(id);
    const { rows } = await pool.query(
      `UPDATE email_transports SET ${sets.join(", ")}, updated_at = now(), updated_by = ${req.hittUser.employeeId || "NULL"}
        WHERE id = $${params.length} RETURNING *`,
      params
    );
    res.json(et.toSafe(rows[0]));
    logAudit(req, { kind: "settings.email-transport", desc: `Updated email transport "${existing.name}": ${changed.join(", ")}`, level: 2 });
  } catch (err) {
    console.error("[PATCH /api/settings/email-transports/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// DELETE /:id  — blocked while any entity points at it.
router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const existing = await et.getRow(pool, id);
    if (!existing) return res.status(404).json({ error: "not_found", message: "Transport not found." });
    const used = await pool.query(`SELECT entitydesc FROM entity WHERE mail_transport_id = $1`, [id]);
    if (used.rows.length) {
      return res.status(409).json({
        error: "conflict",
        message: `In use by: ${used.rows.map((r) => r.entitydesc).join(", ")}. Reassign those entities first.`,
      });
    }
    await pool.query(`DELETE FROM email_transports WHERE id = $1`, [id]);
    // Clear the app-level default if it pointed here.
    await pool.query(`DELETE FROM appconfig WHERE configkey = $1 AND configvalue = $2`, [et.DEFAULT_KEY, String(id)]);
    res.status(204).end();
    logAudit(req, { kind: "settings.email-transport", desc: `Deleted email transport "${existing.name}"`, level: 2 });
  } catch (err) {
    console.error("[DELETE /api/settings/email-transports/:id] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// POST /:id/test  { to }  — send a fixed test message. Always 200 with a
// result object; never leaks the secret.
router.post("/:id/test", async (req, res) => {
  const id = Number(req.params.id);
  const to = str(req.body && req.body.to);
  if (!EMAIL_RE.test(to)) return res.status(400).json({ error: "bad_request", message: "Enter a valid recipient address." });
  try {
    const result = await et.testTransport(pool, id, to);
    res.json(result);
    logAudit(req, {
      kind: "settings.email-transport",
      desc: `Tested email transport #${id} -> ${to}: ${result.ok ? "ok" : "failed"}`,
      level: 2,
    });
  } catch (err) {
    console.error("[POST /api/settings/email-transports/:id/test] error:", err.message);
    res.status(502).json({ error: "server_error", message: err.message });
  }
});

// PUT /default  { id }  — set/clear the app-level fallback transport.
router.put("/default", async (req, res) => {
  const raw = req.body && req.body.id;
  const id = raw ? Number(raw) : null;
  try {
    if (id) {
      const row = await et.getRow(pool, id);
      if (!row) return res.status(404).json({ error: "not_found", message: "Transport not found." });
      await pool.query(
        `INSERT INTO appconfig (configkey, configvalue, updatedat, updatedby)
         VALUES ($1, $2, now(), $3)
         ON CONFLICT (configkey) DO UPDATE SET configvalue = EXCLUDED.configvalue, updatedat = now(), updatedby = EXCLUDED.updatedby`,
        [et.DEFAULT_KEY, String(id), req.hittUser.employeeId || null]
      );
    } else {
      await pool.query(`DELETE FROM appconfig WHERE configkey = $1`, [et.DEFAULT_KEY]);
    }
    res.json({ defaultTransportId: id });
    logAudit(req, { kind: "settings.email-transport", desc: `Default email transport = ${id || "(none)"}`, level: 2 });
  } catch (err) {
    console.error("[PUT /api/settings/email-transports/default] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

module.exports = router;
