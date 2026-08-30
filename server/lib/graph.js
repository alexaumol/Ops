/**
 * Microsoft Graph client-credentials helper.
 * ---------------------------------------------------------------------------
 * Used for exactly one thing right now: creating a OneDrive folder for each
 * new project (see the POST /api/projects handler in routes/projects.js).
 *
 * This is a SEPARATE Entra app registration from the one employees sign in
 * with (js/config.js MSAL block) — that one is a public SPA client with no
 * secret; this one is a confidential/daemon app using the client-credentials
 * flow (app-only, no user involved) with the Sites.Selected Application
 * permission, granted just against one person's OneDrive (see GRAPH_* below
 * and INTERNAL.md for the exact setup — done 2026-08-27).
 *
 * Configured entirely via env vars (server/.env), all required:
 *   GRAPH_TENANT_ID       — same tenant as sign-in
 *   GRAPH_CLIENT_ID       — this app registration's Application (client) ID
 *   GRAPH_CLIENT_SECRET   — its client secret VALUE (not the Secret ID)
 *   GRAPH_ONEDRIVE_USER   — UPN of the OneDrive account project folders live in
 *   GRAPH_ONEDRIVE_FOLDER — path (relative to that OneDrive's root) of the
 *                           shared folder new project folders go inside
 *
 * If any are missing, graphConfigured() returns false and callers should
 * skip folder creation entirely rather than fail — this integration is a
 * best-effort side effect, never something that should block project
 * creation itself.
 * ---------------------------------------------------------------------------
 */
const TENANT_ID = process.env.GRAPH_TENANT_ID;
const CLIENT_ID = process.env.GRAPH_CLIENT_ID;
const CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET;
const ONEDRIVE_USER = process.env.GRAPH_ONEDRIVE_USER;
const ONEDRIVE_FOLDER = process.env.GRAPH_ONEDRIVE_FOLDER;

function graphConfigured() {
  return !!(TENANT_ID && CLIENT_ID && CLIENT_SECRET && ONEDRIVE_USER && ONEDRIVE_FOLDER);
}

// Cached in memory (not persisted) — fine for a single Node process, and
// this app-only token isn't tied to any one request/user. Refreshed a
// minute before actual expiry to avoid a request racing an expired token.
let cachedToken = null; // { value, expiresAt }

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }
  const res = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    throw new Error(`Graph token request failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const data = await res.json();
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

// Percent-encodes each segment of a OneDrive path while keeping the
// literal "/" separators Graph's root:/path: addressing needs.
function encodeDrivePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

// Creates {folderName} as a subfolder of GRAPH_ONEDRIVE_FOLDER in
// GRAPH_ONEDRIVE_USER's OneDrive. Renames on a name collision instead of
// failing (@microsoft.graph.conflictBehavior) — shouldn't normally happen
// given project codes are unique, but this is a best-effort side effect,
// not something worth erroring the caller over.
async function createProjectFolder(folderName) {
  if (!graphConfigured()) {
    throw new Error("Graph integration not configured (missing GRAPH_* env vars)");
  }
  const token = await getAccessToken();
  const parentPath = encodeDrivePath(ONEDRIVE_FOLDER);
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(ONEDRIVE_USER)}/drive/root:/${parentPath}:/children`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: folderName,
        folder: {},
        "@microsoft.graph.conflictBehavior": "rename",
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`Graph folder creation failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return res.json();
}

/* ========================================================================
 * Outbound email (Microsoft Graph /sendMail, app-only)
 * ------------------------------------------------------------------------
 * Used by the invoicing module's "email this invoice PDF" action. Needs
 * the SAME confidential app registration as above, plus:
 *   - Mail.Send  Application permission (admin-consented), and
 *   - GRAPH_MAIL_SENDER  — the mailbox the invoice goes out from (a UPN or
 *     shared-mailbox address the app is allowed to send as). Falls back to
 *     GRAPH_ONEDRIVE_USER when unset.
 * When Mail.Send isn't granted or GRAPH_MAIL_SENDER is unset the caller
 * gets a clear 503 — nothing is sent silently.
 * ===================================================================== */
const MAIL_SENDER = process.env.GRAPH_MAIL_SENDER || ONEDRIVE_USER;

function graphMailConfigured() {
  return !!(TENANT_ID && CLIENT_ID && CLIENT_SECRET && MAIL_SENDER);
}

// Sends one message as MAIL_SENDER.
//   to / cc     : string or string[] of addresses
//   subject     : string
//   text / html : body (text unless html is given)
//   attachments : [{ filename, contentType, content }] where content is a
//                 Buffer or a base64 string
async function sendMail({ to, cc, subject, text, html, attachments = [], replyTo }) {
  if (!graphMailConfigured()) {
    throw new Error("Graph mail not configured (missing GRAPH_* env vars or GRAPH_MAIL_SENDER)");
  }
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((s) => String(s).trim()).filter(Boolean);
  const recip = (a) => ({ emailAddress: { address: a } });

  const message = {
    subject: subject || "(no subject)",
    body: { contentType: html ? "HTML" : "Text", content: html || text || "" },
    toRecipients: list(to).map(recip),
  };
  const ccList = list(cc);
  if (ccList.length) message.ccRecipients = ccList.map(recip);
  if (replyTo) message.replyTo = [recip(replyTo)];
  if (attachments.length) {
    message.attachments = attachments.map((f) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: f.filename || "attachment",
      contentType: f.contentType || "application/octet-stream",
      contentBytes: Buffer.isBuffer(f.content) ? f.content.toString("base64") : String(f.content || ""),
    }));
  }
  if (!message.toRecipients.length) throw new Error("sendMail: no recipient");

  const token = await getAccessToken();
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAIL_SENDER)}/sendMail`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message, saveToSentItems: true }),
    }
  );
  if (!res.ok) {
    throw new Error(`Graph sendMail failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return { sender: MAIL_SENDER };
}

module.exports = { graphConfigured, createProjectFolder, graphMailConfigured, sendMail };
