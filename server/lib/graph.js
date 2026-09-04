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
 * 2. Invoice email (sendMail, from routes/invoicing.js) — Mail.Send only.
 *    Its credentials now come from a DB-managed email transport
 *    (server/lib/emailTransport.js, Settings -> Email), passed to sendMail()
 *    as the second argument — no GRAPH_MAIL_* env vars.
 * ---------------------------------------------------------------------------
 */
const TENANT_ID = process.env.GRAPH_TENANT_ID;
const CLIENT_ID = process.env.GRAPH_CLIENT_ID;
const CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET;
const ONEDRIVE_USER = process.env.GRAPH_ONEDRIVE_USER;
const ONEDRIVE_FOLDER = process.env.GRAPH_ONEDRIVE_FOLDER;

const ONEDRIVE_CREDS = { tenantId: TENANT_ID, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };

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

const getAccessToken = () => getToken(ONEDRIVE_CREDS); // OneDrive / drive access

const GRAPH = "https://graph.microsoft.com/v1.0";

// Percent-encodes each segment of a OneDrive path while keeping the
// literal "/" separators Graph's root:/path: addressing needs.
function encodeDrivePath(path) {
  return String(path || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
}
const trimSlashes = (s) => String(s || "").replace(/^[/\\]+|[/\\]+$/g, "").replace(/\\/g, "/");

async function graphFetch(url, init = {}) {
  const token = await getAccessToken();
  return fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
}

/* ========================================================================
 * Settings → Sync: back up documents into a configurable drive location.
 * The location is either a plain path under GRAPH_ONEDRIVE_USER's drive
 * (like GRAPH_ONEDRIVE_FOLDER) or a SharePoint/OneDrive share URL.
 * ===================================================================== */

// Same env as the folder feature — the token creds plus a user whose drive
// path-based locations resolve against. A caller with a share URL only
// strictly needs the token creds, but requiring ONEDRIVE_USER keeps the
// "is this configured at all" check simple.
function syncConfigured() {
  return !!(TENANT_ID && CLIENT_ID && CLIENT_SECRET && ONEDRIVE_USER);
}

const b64url = (s) =>
  Buffer.from(s, "utf8").toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");

// The OneDrive personal-site key for a UPN: osola@hittbcn.com -> osola_hittbcn_com
const oneDriveKey = (upn) => String(upn || "").toLowerCase().replace(/[@.]/g, "_");

// Classify a Sync location string into how Graph should address it:
//   { kind: "path",  path }   — a folder under GRAPH_ONEDRIVE_USER's drive root
//   { kind: "share", url }    — a sharing URL, resolved once via /shares
// A plain string is a path. An "…/onedrive.aspx?id=/personal/<user>/Documents/…"
// web-UI address (what you get from the browser address bar) is understood when
// it points at the configured user's own OneDrive; anything else in that shape
// throws with guidance. Every other http(s) URL is treated as a sharing URL.
function classifyLocation(loc) {
  if (!/^https?:\/\//i.test(loc)) return { kind: "path", path: trimSlashes(loc) };

  let u;
  try { u = new URL(loc); } catch { return { kind: "share", url: loc }; }
  const id = u.searchParams.get("id");
  if (!/\.sharepoint\.com$/i.test(u.hostname) || !id) return { kind: "share", url: loc };

  // Web-UI address. id is a server-relative path like
  // /personal/<key>/Documents/<folder…> (personal OneDrive) or
  // /sites/<site>/Shared Documents/<…> (a team site).
  const m = /^\/personal\/([^/]+)\/Documents(?:\/(.*))?$/i.exec(id.trim());
  if (m) {
    if (ONEDRIVE_USER && m[1].toLowerCase() !== oneDriveKey(ONEDRIVE_USER)) {
      throw new Error(
        `That link points at ${m[1].replace(/_/g, ".")}'s OneDrive, but Ops is configured for ${ONEDRIVE_USER}. ` +
        `Use a folder path in that account, or a "Copy link" sharing URL.`
      );
    }
    return { kind: "path", path: trimSlashes(m[2] || "") };
  }
  throw new Error(
    `That's a SharePoint web address, not a folder path or a sharing link. ` +
    `Open the folder, use Share -> Copy link, and paste that — or enter a plain folder path (e.g. Clients/Projects).`
  );
}

// Turn a location string into a Graph addressing prefix + a helper that
// builds the URL for any sub-path beneath it. Memoised per location string
// for the life of the process (a share URL costs one Graph call to resolve).
const locationCache = new Map();
async function resolveLocation(location) {
  const loc = String(location || "").trim();
  if (!loc) throw new Error("no sync location configured");
  if (locationCache.has(loc)) return locationCache.get(loc);

  const c = classifyLocation(loc);
  let resolved;
  if (c.kind === "share") {
    const res = await graphFetch(`${GRAPH}/shares/u!${b64url(c.url)}/driveItem?$select=id,parentReference,webUrl`);
    if (!res.ok) throw new Error(`resolve share link failed: ${res.status} ${await res.text().catch(() => "")}`);
    const item = await res.json();
    const driveId = item.parentReference && item.parentReference.driveId;
    if (!driveId || !item.id) throw new Error("share link did not resolve to a drive item");
    resolved = { kind: "item", prefix: `drives/${driveId}/items/${item.id}` };
  } else {
    resolved = { kind: "path", prefix: `users/${encodeURIComponent(ONEDRIVE_USER)}/drive/root`, base: c.path };
  }
  locationCache.set(loc, resolved);
  return resolved;
}

// Graph URL for `subPath` (a "/"-joined relative path, may be "") under a
// resolved location.
function itemUrl(resolved, subPath) {
  const parts = trimSlashes(subPath).split("/").filter(Boolean);
  if (resolved.kind === "item") {
    const enc = parts.map(encodeURIComponent).join("/");
    return enc ? `${GRAPH}/${resolved.prefix}:/${enc}:` : `${GRAPH}/${resolved.prefix}`;
  }
  const full = [resolved.base, ...parts].filter(Boolean);
  const enc = full.map(encodeURIComponent).join("/");
  return enc ? `${GRAPH}/${resolved.prefix}:/${enc}:` : `${GRAPH}/${resolved.prefix}`;
}

// mkdir -p: ensure every segment of `folderPath` exists under the resolved
// location. Returns the leaf folder's { id, webUrl }.
async function ensureFolderPath(resolved, folderPath) {
  const segs = trimSlashes(folderPath).split("/").filter(Boolean);
  let leaf = null;
  for (let i = 0; i < segs.length; i++) {
    const sub = segs.slice(0, i + 1).join("/");
    const getRes = await graphFetch(`${itemUrl(resolved, sub)}?$select=id,webUrl,folder`);
    if (getRes.ok) { leaf = await getRes.json(); continue; }
    if (getRes.status !== 404) {
      throw new Error(`folder lookup failed (${sub}): ${getRes.status} ${await getRes.text().catch(() => "")}`);
    }
    const parent = segs.slice(0, i).join("/");
    const mk = await graphFetch(`${itemUrl(resolved, parent)}/children`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: segs[i], folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    });
    if (mk.ok) { leaf = await mk.json(); continue; }
    // A racing create is fine — re-fetch.
    if (mk.status === 409) {
      const again = await graphFetch(`${itemUrl(resolved, sub)}?$select=id,webUrl,folder`);
      if (again.ok) { leaf = await again.json(); continue; }
    }
    throw new Error(`folder create failed (${sub}): ${mk.status} ${await mk.text().catch(() => "")}`);
  }
  return leaf;
}

// Upload a file to `<location>/<folderPath>/<filename>`, overwriting any
// existing file of that name. Simple PUT up to 4 MiB, a resumable upload
// session above that. Returns { id, webUrl }.
const SIMPLE_MAX = 4 * 1024 * 1024;
const CHUNK = 5 * 320 * 1024; // 1.6 MiB, a multiple of 320 KiB as Graph requires

async function uploadFile(resolved, folderPath, filename, buffer, contentType) {
  await ensureFolderPath(resolved, folderPath);
  const dest = [trimSlashes(folderPath), filename].filter(Boolean).join("/");

  if (buffer.length <= SIMPLE_MAX) {
    const res = await graphFetch(
      `${itemUrl(resolved, dest)}/content?@microsoft.graph.conflictBehavior=replace`,
      { method: "PUT", headers: { "Content-Type": contentType || "application/octet-stream" }, body: buffer }
    );
    if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text().catch(() => "")}`);
    return res.json();
  }

  const sess = await graphFetch(`${itemUrl(resolved, dest)}/createUploadSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }),
  });
  if (!sess.ok) throw new Error(`create upload session failed: ${sess.status} ${await sess.text().catch(() => "")}`);
  const { uploadUrl } = await sess.json();

  const total = buffer.length;
  for (let start = 0; start < total; start += CHUNK) {
    const end = Math.min(start + CHUNK, total);
    const part = buffer.subarray(start, end);
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Length": String(part.length), "Content-Range": `bytes ${start}-${end - 1}/${total}` },
      body: part,
    });
    if (res.status === 200 || res.status === 201) return res.json();
    if (res.status !== 202) throw new Error(`chunk upload failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  throw new Error("upload session ended without a completed file");
}

// Ensure a single project folder exists directly under `location`
// (defaults to GRAPH_ONEDRIVE_FOLDER). Idempotent: existing folder is
// reused, not renamed. Returns { id, webUrl, name }.
async function createProjectFolder(folderName, location) {
  if (!syncConfigured()) throw new Error("Graph integration not configured (missing GRAPH_* env vars)");
  const loc = String(location || "").trim() || ONEDRIVE_FOLDER;
  if (!loc) throw new Error("no project folder location (set sync.projects_location or GRAPH_ONEDRIVE_FOLDER)");
  const resolved = await resolveLocation(loc);
  const folder = await ensureFolderPath(resolved, folderName);
  return { id: folder.id, webUrl: folder.webUrl, name: folderName };
}

/* ========================================================================
 * Outbound email (Microsoft Graph /sendMail, app-only)
 * ------------------------------------------------------------------------
 * Used by the invoicing module's "email this invoice PDF" action.
 *
 * Credentials come from a DB-managed transport (Settings -> Email,
 * server/lib/emailTransport.js) — a confidential app registration with only
 * the Mail.Send Application permission (admin-consented), ideally scoped
 * with an application access policy to the sender mailbox. They are passed
 * as the `creds` argument: { tenantId, clientId, clientSecret, sender }.
 *
 * The sender mailbox is `from` (per-call override) or `creds.sender`.
 *
 * When Mail.Send isn't granted / the app can't send as that mailbox, the
 * caller gets a clear error — nothing is sent silently.
 * ===================================================================== */

// Sends one message.
//   mailArgs.from        : sender mailbox override (else creds.sender)
//   mailArgs.to / cc     : string or string[] of addresses
//   mailArgs.subject     : string
//   mailArgs.text / html : body (text unless html is given)
//   mailArgs.attachments : [{ filename, contentType, content }] where content
//                          is a Buffer or a base64 string
//   creds  : { tenantId, clientId, clientSecret, sender }
async function sendMail({ from, to, cc, subject, text, html, attachments = [], replyTo }, creds = {}) {
  const { tenantId, clientId, clientSecret } = creds;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("Graph mail: transport is missing tenant id / client id / client secret");
  }
  const sender = (from && String(from).trim()) || (creds.sender && String(creds.sender).trim());
  if (!sender) {
    throw new Error("sendMail: no sender mailbox (transport has no From address)");
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

  const token = await getToken({ tenantId, clientId, clientSecret });
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

module.exports = {
  graphConfigured,
  createProjectFolder,
  sendMail,
  // Settings → Sync backup engine
  syncConfigured,
  resolveLocation,
  classifyLocation,
  ensureFolderPath,
  uploadFile,
};
