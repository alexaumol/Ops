/**
 * Email transports — DB-managed outbound-mail credentials (Settings -> Email).
 * ---------------------------------------------------------------------------
 * Replaces the GRAPH_MAIL_* / SMTP_* env vars. Each row in email_transports
 * is a Microsoft Graph app (Mail.Send) or an SMTP account; the secret column
 * holds AES-256-GCM ciphertext (server/lib/secrets.js, key APP_ENCRYPTION_KEY).
 *
 * A billing entity points at a transport via entity.mail_transport_id. When
 * it has none, the app-level default in appconfig 'email.default_transport_id'
 * is used; if that is unset too, resolveForEntity() throws NoTransportError
 * and the caller returns a clear 503.
 *
 * This module is the only place transport secrets are decrypted. The API
 * layer (routes/emailTransports.js) never returns them — only "…Set" booleans.
 * ---------------------------------------------------------------------------
 */
const { pool } = require("../config/db");
const secrets = require("./secrets");
const graph = require("./graph");
const mailer = require("./mailer");

const DEFAULT_KEY = "email.default_transport_id";

class NoTransportError extends Error {
  constructor(message) {
    super(message);
    this.name = "NoTransportError";
  }
}

const COLS = `id, name, kind, from_address, active,
  graph_tenant_id, graph_client_id, graph_client_secret,
  smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure,
  created_at, updated_at, updated_by`;

// Public shape — never includes a secret, adds "set" booleans instead.
function toSafe(r) {
  return {
    id: Number(r.id),
    name: r.name,
    kind: r.kind,
    fromAddress: r.from_address,
    active: r.active,
    graphTenantId: r.graph_tenant_id || "",
    graphClientId: r.graph_client_id || "",
    graphSecretSet: !!r.graph_client_secret,
    smtpHost: r.smtp_host || "",
    smtpPort: r.smtp_port || null,
    smtpUser: r.smtp_user || "",
    smtpSecure: !!r.smtp_secure,
    smtpPassSet: !!r.smtp_pass,
    updatedAt: r.updated_at,
  };
}

async function listTransports(db = pool) {
  const { rows } = await db.query(`SELECT ${COLS} FROM email_transports ORDER BY lower(name)`);
  return rows.map(toSafe);
}

async function getRow(db, id) {
  const { rows } = await db.query(`SELECT ${COLS} FROM email_transports WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function getDefaultTransportId(db = pool) {
  try {
    const { rows } = await db.query(`SELECT configvalue FROM appconfig WHERE configkey = $1`, [DEFAULT_KEY]);
    const v = rows[0] && rows[0].configvalue;
    return v ? Number(v) : null;
  } catch (err) {
    if (err.code === "42P01") return null; // appconfig not created yet
    throw err;
  }
}

// Decrypt a row into a config object ready for graph.sendMail / mailer.sendSmtpMail.
// Throws if the key is unavailable or a stored secret won't decrypt.
function toUsable(r) {
  if (r.kind === "graph") {
    return {
      id: Number(r.id),
      kind: "graph",
      name: r.name,
      from: r.from_address,
      tenantId: r.graph_tenant_id,
      clientId: r.graph_client_id,
      clientSecret: r.graph_client_secret ? secrets.decryptSecret(r.graph_client_secret) : null,
      sender: r.from_address,
    };
  }
  return {
    id: Number(r.id),
    kind: "smtp",
    name: r.name,
    from: r.from_address,
    host: r.smtp_host,
    port: r.smtp_port,
    user: r.smtp_user,
    pass: r.smtp_pass ? secrets.decryptSecret(r.smtp_pass) : null,
    secure: !!r.smtp_secure,
  };
}

async function loadUsable(db, id) {
  const r = await getRow(db, id);
  if (!r) throw new NoTransportError(`Email transport #${id} not found.`);
  if (!r.active) throw new NoTransportError(`Email transport "${r.name}" is disabled.`);
  return toUsable(r);
}

// Pick the transport for an invoice email.
//   entityId          — invoices.entityid / the joined entity id
//   entityMailTransportId — entity.mail_transport_id (may be null)
//   entityMailSender  — entity.mailsender From override (may be null)
async function resolveForEntity(db, { entityId, entityMailTransportId, entityMailSender } = {}) {
  let id = entityMailTransportId ? Number(entityMailTransportId) : null;
  if (!id) id = await getDefaultTransportId(db);
  if (!id) {
    throw new NoTransportError(
      "No email transport is set for this entity, and there is no default. " +
        "Set one in Settings → Email, then assign it under Settings → Entities."
    );
  }
  const usable = await loadUsable(db, id);
  const override = entityMailSender && String(entityMailSender).trim();
  if (override) {
    usable.from = override;
    usable.sender = override;
  }
  return usable;
}

// Dispatch a prepared message through a usable transport.
async function sendVia(usable, mailArgs) {
  const args = { ...mailArgs, from: mailArgs.from || usable.from };
  if (usable.kind === "graph") {
    return graph.sendMail(args, {
      tenantId: usable.tenantId,
      clientId: usable.clientId,
      clientSecret: usable.clientSecret,
      sender: usable.sender || usable.from,
    });
  }
  return mailer.sendSmtpMail(args, {
    host: usable.host,
    port: usable.port,
    user: usable.user,
    pass: usable.pass,
    secure: usable.secure,
    from: usable.from,
  });
}

// Send a fixed test message through transport `id`. Never throws — returns
// { ok } or { ok:false, error } with a message safe to show (no secret).
async function testTransport(db, id, to) {
  try {
    const usable = await loadUsable(db, id);
    const info = await sendVia(usable, {
      to,
      subject: `Ops — email transport test (${usable.name})`,
      text:
        `This is a test message from Ops.\n\n` +
        `Transport: ${usable.name} (${usable.kind})\n` +
        `Sent: ${new Date().toISOString()}\n`,
    });
    return { ok: true, sender: info && info.sender };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

module.exports = {
  NoTransportError,
  DEFAULT_KEY,
  toSafe,
  listTransports,
  getRow,
  getDefaultTransportId,
  loadUsable,
  resolveForEntity,
  sendVia,
  testTransport,
};
