/**
 * SMTP mail transport (nodemailer).
 * ---------------------------------------------------------------------------
 * Used for invoice email when a billing entity's transport (Settings ->
 * Email) is of kind "smtp" — e.g. a sender mailbox hosted outside the
 * Microsoft 365 tenant, which Graph can't send as.
 *
 * Config is passed per call (from the DB transport, decrypted by
 * server/lib/emailTransport.js) — no SMTP_* env vars:
 *   cfg.host    e.g. smtp.ionos.es
 *   cfg.port    587 (STARTTLS) or 465 (implicit TLS)
 *   cfg.user    the full mailbox address
 *   cfg.pass    that mailbox's password
 *   cfg.secure  true for implicit TLS (also forced when port === 465)
 *   cfg.from    default From when a caller passes none (defaults to cfg.user)
 *
 * Most providers require the From address to match the authenticated
 * mailbox.
 * ---------------------------------------------------------------------------
 */
let nodemailer = null;
try {
  nodemailer = require("nodemailer");
} catch {
  console.error("[mailer] nodemailer not installed — SMTP email disabled. Run `npm install` in server/.");
}

const asList = (v) =>
  (Array.isArray(v) ? v : v ? [v] : []).map((s) => String(s).trim()).filter(Boolean);

// One nodemailer transport per distinct account, reused across sends.
const transports = new Map();
function getTransport(cfg) {
  if (!nodemailer) throw new Error("nodemailer not installed");
  const host = cfg.host;
  const port = Number(cfg.port) || 587;
  const user = cfg.user;
  const pass = cfg.pass;
  if (!host || !user || !pass) {
    throw new Error("SMTP transport is missing host / user / password");
  }
  const secure = cfg.secure === true || port === 465;
  const key = `${host}|${port}|${user}`;
  let t = transports.get(key);
  if (!t) {
    t = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
    transports.set(key, t);
  }
  return t;
}

// Sends one message over SMTP.
//   mailArgs.from        : sender address (falls back to cfg.from, then cfg.user)
//   mailArgs.to / cc     : string or string[]
//   mailArgs.subject     : string
//   mailArgs.text / html : body
//   mailArgs.attachments : [{ filename, contentType, content }] — content a
//                          Buffer or a base64 string
//   cfg : { host, port, user, pass, secure, from }
async function sendSmtpMail({ from, to, cc, subject, text, html, attachments = [], replyTo }, cfg = {}) {
  const t = getTransport(cfg);
  const sender = (from && String(from).trim()) || cfg.from || cfg.user;
  const info = await t.sendMail({
    from: sender,
    to: asList(to),
    cc: asList(cc),
    replyTo: replyTo || undefined,
    subject: subject || "(no subject)",
    text: text || undefined,
    html: html || undefined,
    attachments: attachments.map((f) => ({
      filename: f.filename || "attachment",
      contentType: f.contentType || undefined,
      content: Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content || ""), "base64"),
    })),
  });
  return { sender, messageId: info.messageId };
}

module.exports = { sendSmtpMail };
