/**
 * Microsoft Graph client-credentials helper (app-only, no user involved).
 * ---------------------------------------------------------------------------
 * Two independent uses, each with its OWN confidential Entra app
 * registration (both separate from the public SPA sign-in client in
 * js/config.js). Configured via server/.env — see INTERNAL.md for the
 * portal setup.
 *
 * 1. OneDrive project folders (createProjectFolder, from routes/projects.js) —
 *    Sites.Selected, granted against one person's OneDrive:
 *      GRAPH_TENANT_ID  GRAPH_CLIENT_ID  GRAPH_CLIENT_SECRET (secret VALUE)
 *      GRAPH_ONEDRIVE_USER  GRAPH_ONEDRIVE_FOLDER
 *    Missing any -> graphConfigured() false; callers skip folder creation
 *    rather than fail project creation.
 *
 * 2. Invoice email (sendMail, from routes/invoicing.js) — Mail.Send only,
 *    kept off the OneDrive credential:
 *      GRAPH_MAIL_TENANT_ID  GRAPH_MAIL_CLIENT_ID  GRAPH_MAIL_CLIENT_SECRET
 *    Each falls back to the matching GRAPH_* var when unset, so a single
 *    shared app still works if you don't split them.
 *    Missing all -> graphMailConfigured() false; the email endpoint 503s.
 * ---------------------------------------------------------------------------
 */
const TENANT_ID = process.env.GRAPH_TENANT_ID;
const CLIENT_ID = process.env.GRAPH_CLIENT_ID;
const CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET;
const ONEDRIVE_USER = process.env.GRAPH_ONEDRIVE_USER;
const ONEDRIVE_FOLDER = process.env.GRAPH_ONEDRIVE_FOLDER;

// Outbound email uses its OWN app registration (Mail.Send only) — keeping
// it off the OneDrive app's Sites.Selected credential. Falls back to the
// GRAPH_* app when the GRAPH_MAIL_* vars aren't set.
const MAIL_TENANT_ID = process.env.GRAPH_MAIL_TENANT_ID || TENANT_ID;
const MAIL_CLIENT_ID = process.env.GRAPH_MAIL_CLIENT_ID || CLIENT_ID;
const MAIL_CLIENT_SECRET = process.env.GRAPH_MAIL_CLIENT_SECRET || CLIENT_SECRET;

const ONEDRIVE_CREDS = { tenantId: TENANT_ID, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };
const MAIL_CREDS = { tenantId: MAIL_TENANT_ID, clientId: MAIL_CLIENT_ID, clientSecret: MAIL_CLIENT_SECRET };

function graphConfigured() {
  return !!(TENANT_ID && CLIENT_ID && CLIENT_SECRET && ONEDRIVE_USER && ONEDRIVE_FOLDER);
}

// Cached in memory per client id (not persisted) — fine for a single Node
// process, and an app-only token isn't tied to any one request/user.
// Refreshed a minute before expiry to avoid a request racing an expired token.
const tokenCache = new Map(); // clientId -> { value, expiresAt }

async function getToken({ tenantId, clientId, clientSecret }) {
  const cached = tokenCache.get(clientId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    throw new Error(`Graph token request failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const data = await res.json();
  tokenCache.set(clientId, { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
  return data.access_token;
}

const getAccessToken = () => getToken(ONEDRIVE_CREDS); // OneDrive folder creation

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
 * Used by the invoicing module's "email this invoice PDF" action.
 *
 * Its OWN confidential app registration — GRAPH_MAIL_CLIENT_ID /
 * GRAPH_MAIL_CLIENT_SECRET / GRAPH_MAIL_TENANT_ID — with only the Mail.Send
 * Application permission (admin-consented), ideally scoped with an
 * application access policy to just invoices@hittbcn.com. Kept separate
 * from the OneDrive app so that Sites.Selected credential doesn't also
 * carry mail rights. If the GRAPH_MAIL_* vars are unset it falls back to
 * the GRAPH_* (OneDrive) app.
 *
 * The sender mailbox is passed per-call (`from`). Only HiTT / HiTT-OSM
 * invoices go through Graph (from invoices@hittbcn.com, a mailbox in the
 * M365 tenant); FHiTT's invoices@fhitt.org is hosted at IONOS and goes over
 * SMTP instead (lib/mailer.js). GRAPH_MAIL_SENDER is only the last-resort
 * fallback when a caller passes no `from`.
 *
 * When Mail.Send isn't granted / the app can't send as that mailbox, the
 * caller gets a clear 5xx — nothing is sent silently.
 * ===================================================================== */
const MAIL_SENDER = process.env.GRAPH_MAIL_SENDER || ONEDRIVE_USER || null;

function graphMailConfigured() {
  return !!(MAIL_TENANT_ID && MAIL_CLIENT_ID && MAIL_CLIENT_SECRET);
}

// Sends one message.
//   from        : sender mailbox (UPN / shared-mailbox address). Falls back
//                 to GRAPH_MAIL_SENDER, then GRAPH_ONEDRIVE_USER.
//   to / cc     : string or string[] of addresses
//   subject     : string
//   text / html : body (text unless html is given)
//   attachments : [{ filename, contentType, content }] where content is a
//                 Buffer or a base64 string
async function sendMail({ from, to, cc, subject, text, html, attachments = [], replyTo }) {
  if (!graphMailConfigured()) {
    throw new Error("Graph mail not configured (missing GRAPH_MAIL_CLIENT_ID / GRAPH_MAIL_CLIENT_SECRET / GRAPH_MAIL_TENANT_ID)");
  }
  const sender = (from && String(from).trim()) || MAIL_SENDER;
  if (!sender) {
    throw new Error("sendMail: no sender mailbox (pass `from`, or set GRAPH_MAIL_SENDER)");
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

  const token = await getToken(MAIL_CREDS);
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message, saveToSentItems: true }),
    }
  );
  if (!res.ok) {
    throw new Error(`Graph sendMail failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return { sender };
}

module.exports = { graphConfigured, createProjectFolder, graphMailConfigured, sendMail };
