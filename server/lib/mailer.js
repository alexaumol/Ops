/**
 * SMTP mail transport (nodemailer).
 * ---------------------------------------------------------------------------
 * Used for FHiTT invoice emails: their sender mailbox (invoices@fhitt.org)
 * is hosted at IONOS, not in the Microsoft 365 tenant, so Microsoft Graph
 * can't send as it (see lib/graph.js). HiTT / HiTT-OSM invoices still go
 * out through Graph.
 *
 * Config (server/.env) — all four required for the transport to be active:
 *   SMTP_HOST    e.g. smtp.ionos.es  (or smtp.ionos.com / .de — match the
 *                account region)
 *   SMTP_PORT    587 (STARTTLS) or 465 (implicit TLS)
 *   SMTP_USER    the full mailbox address, e.g. invoices@fhitt.org
 *   SMTP_PASS    that mailbox's password
 * Optional:
 *   SMTP_SECURE  "true" to force implicit TLS (auto-true when SMTP_PORT=465)
 *   SMTP_FROM    fallback From when a caller passes none (defaults to SMTP_USER)
 *
 * IONOS (like most providers) requires the From address to match the
 * authenticated mailbox — for FHiTT that's the same address, so fine.
 *
 * smtpConfigured() is false when anything is missing; callers surface a
 * clear error rather than sending silently.
 * ---------------------------------------------------------------------------
 */
let nodemailer = null;
try {
  nodemailer = require("nodemailer");
} catch {
  console.error("[mailer] nodemailer not installed — SMTP email disabled. Run `npm install` in server/.");
}

const HOST = process.env.SMTP_HOST || null;
const PORT = Number(process.env.SMTP_PORT) || 587;
const USER = process.env.SMTP_USER || null;
const PASS = process.env.SMTP_PASS || null;
const SECURE = process.env.SMTP_SECURE === "true" || PORT === 465;

function smtpConfigured() {
  return !!(nodemailer && HOST && USER && PASS);
}

let transport = null;
function getTransport() {
  if (!smtpConfigured()) {
    throw new Error("SMTP not configured (SMTP_HOST / SMTP_USER / SMTP_PASS)");
  }
  if (!transport) {
    transport = nodemailer.createTransport({
      host: HOST,
      port: PORT,
      secure: SECURE,
      auth: { user: USER, pass: PASS },
    });
  }
  return transport;
}

const asList = (v) =>
  (Array.isArray(v) ? v : v ? [v] : []).map((s) => String(s).trim()).filter(Boolean);

// Sends one message over SMTP.
//   from        : sender address (falls back to SMTP_FROM, then SMTP_USER)
//   to / cc     : string or string[]
//   subject     : string
//   text / html : body
//   attachments : [{ filename, contentType, content }] — content a Buffer or
//                 a base64 string
async function sendSmtpMail({ from, to, cc, subject, text, html, attachments = [], replyTo }) {
  const t = getTransport();
  const info = await t.sendMail({
    from: (from && String(from).trim()) || process.env.SMTP_FROM || USER,
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
  return { sender: (from && String(from).trim()) || USER, messageId: info.messageId };
}

module.exports = { smtpConfigured, sendSmtpMail };
