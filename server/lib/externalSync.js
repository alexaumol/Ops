/**
 * Settings → Sync — back up app documents to the company's external storage.
 * ---------------------------------------------------------------------------
 * Microsoft only for v1 (reuses lib/graph.js, app-only). Config keys:
 *   sync.projects_location    {"provider","path"} — folder for per-project folders
 *   sync.other_docs_location  {"provider","path"} — base folder for the backup
 *   sync.backup_doc_types     CSV of "tickets" / "invoices"
 *   sync.backup_under_project "on" -> file a document under its project's
 *                             folder instead of a per-type folder
 *
 * A location's `provider` is "onedrive" (wired), "gdrive" or "network"
 * (staged — a sync attempt records a "not built yet" error). A bare string
 * value (pre-provider config) is read as { provider: "onedrive", path: <string> }.
 *
 * Every entry point is BEST-EFFORT: it never throws to its caller. Outcomes
 * are recorded in the external_sync table (status 'ok' | 'error'); the
 * catch-up job (scripts/sync-external.js) retries errors and backfills.
 * See docs/external-sync.md.
 * ---------------------------------------------------------------------------
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const graph = require("./graph");
const { expenseFilePath, mimeForName } = require("./expenseFiles");
const { renderInvoicePdfBuffer } = require("./invoicePdf");

const ENV_PROJECT_FOLDER = process.env.GRAPH_ONEDRIVE_FOLDER || "";

const PROVIDER_LABEL = { onedrive: "OneDrive", gdrive: "Google Drive", network: "Network server" };

// A location value is JSON {"provider","path"} or (legacy) a bare path string.
function parseLocation(raw) {
  const s = String(raw || "").trim();
  if (s.startsWith("{")) {
    try {
      const o = JSON.parse(s);
      return { provider: o.provider || "onedrive", path: String(o.path || "").trim() };
    } catch { /* fall through to bare-string handling */ }
  }
  return { provider: "onedrive", path: s };
}

async function getSyncConfig(db) {
  let m = {};
  try {
    const { rows } = await db.query(`SELECT configkey, configvalue FROM appconfig WHERE configkey LIKE 'sync.%'`);
    m = Object.fromEntries(rows.map((r) => [r.configkey, r.configvalue]));
  } catch { /* table missing / DB down — treat as unconfigured */ }
  const projects = parseLocation(m["sync.projects_location"]);
  const other = parseLocation(m["sync.other_docs_location"]);
  return {
    enabled: m["sync.enabled"] === "on",
    projectsLocation: projects.path || ENV_PROJECT_FOLDER,
    projectsProvider: projects.path ? projects.provider : "onedrive",
    otherLocation: other.path,
    otherProvider: other.provider,
    docTypes: new Set(String(m["sync.backup_doc_types"] || "").split(",").map((s) => s.trim()).filter(Boolean)),
    underProject: m["sync.backup_under_project"] === "on",
  };
}

// Drive-safe file/folder name.
function sanitize(name) {
  return String(name || "")
    .replace(/[/\\:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "untitled";
}

// "PROJECTNUMBER_ENTITYID PROJECT NAME" — the convention routes/projects.js
// has always used for the OneDrive folder it creates on project creation.
function projectFolderName(code, entityId, name) {
  const c = sanitize(code).replace(/ /g, "");
  const e = entityId != null && entityId !== "" ? String(Number(entityId)).padStart(3, "0") : "000";
  return `${c}_${e} ${sanitize(name)}`.trim();
}

const typeFolder = (type) => (type === "invoices" ? "Invoices" : "Tickets");

// Where a document's backup goes: { location, folder }.
//   underProject ON  -> inside the project's folder, under the project
//                       location (same place the folders are created). No
//                       project -> a "_Unassigned/<Type>" folder there.
//   underProject OFF -> a per-type folder at sync.other_docs_location.
function backupTarget(cfg, type, project) {
  if (cfg.underProject) {
    return {
      location: cfg.projectsLocation,
      provider: cfg.projectsProvider,
      folder: project && project.code
        ? projectFolderName(project.code, project.entityId, project.name)
        : `_Unassigned/${typeFolder(type)}`,
    };
  }
  return { location: cfg.otherLocation, provider: cfg.otherProvider, folder: typeFolder(type) };
}

// null when the provider is wired; otherwise a message to store as the error.
function unsupportedProvider(provider) {
  if (!provider || provider === "onedrive") return null;
  return `${PROVIDER_LABEL[provider] || provider} sync is not built yet — see docs/external-sync.md`;
}

async function record(db, kind, refId, fields) {
  const f = fields || {};
  try {
    await db.query(
      `INSERT INTO external_sync
         (kind, ref_id, source_sig, target, remote_id, remote_url, remote_path, status, error, attempts, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,now())
       ON CONFLICT (kind, ref_id) DO UPDATE SET
         source_sig  = EXCLUDED.source_sig,
         target      = EXCLUDED.target,
         remote_id   = COALESCE(EXCLUDED.remote_id,  external_sync.remote_id),
         remote_url  = COALESCE(EXCLUDED.remote_url,  external_sync.remote_url),
         remote_path = COALESCE(EXCLUDED.remote_path, external_sync.remote_path),
         status      = EXCLUDED.status,
         error       = EXCLUDED.error,
         attempts    = external_sync.attempts + 1,
         synced_at   = now()`,
      [kind, refId, f.sourceSig ?? null, f.target ?? null, f.remoteId ?? null,
       f.remoteUrl ?? null, f.remotePath ?? null, f.status || "ok", f.error ?? null]
    );
  } catch (err) {
    console.error(`[externalSync] could not record ${kind} #${refId}:`, err.message);
  }
}

/* ---------------------------------------------------------------- expense */

async function syncExpenseDoc(db, expenseId) {
  const cfg = await getSyncConfig(db);
  if (!cfg.enabled || !graph.syncConfigured() || !cfg.docTypes.has("tickets")) return { skipped: true };

  let e;
  try {
    const { rows } = await db.query(
      `SELECT x.id, x.ticketurl, x.picturetitle, x.projectid,
              p.projectnumber AS code, p.entityid AS "entityId", p.projectname AS name
       FROM expenses x
       LEFT JOIN projects p ON p.id = x.projectid::bigint
       WHERE x.id = $1`,
      [expenseId]
    );
    e = rows[0];
  } catch (err) {
    return { error: err.message };
  }
  if (!e || !e.ticketurl) return { skipped: true };

  const project = e.projectid ? { code: e.code, entityId: e.entityId, name: e.name } : null;
  const { location, provider, folder } = backupTarget(cfg, "tickets", project);
  if (!location) return { skipped: true };
  const unsupported = unsupportedProvider(provider);
  if (unsupported) {
    await record(db, "expense_doc", e.id, { sourceSig: e.ticketurl, target: location, status: "error", error: unsupported });
    return { skipped: true };
  }
  const ext = path.extname(e.ticketurl) || path.extname(e.picturetitle || "");
  const base = sanitize((e.picturetitle || "ticket").replace(/\.[^.]+$/, ""));
  const filename = `ticket_${e.id}_${base}${ext}`;

  try {
    const buffer = await fs.promises.readFile(expenseFilePath(e.ticketurl));
    const resolved = await graph.resolveLocation(location);
    const up = await graph.uploadFile(resolved, folder, filename, buffer, mimeForName(e.ticketurl));
    await record(db, "expense_doc", e.id, {
      sourceSig: e.ticketurl, target: location,
      remoteId: up.id, remoteUrl: up.webUrl, remotePath: `${folder}/${filename}`, status: "ok",
    });
    return { ok: true };
  } catch (err) {
    await record(db, "expense_doc", e.id, { sourceSig: e.ticketurl, target: location, status: "error", error: err.message });
    return { error: err.message };
  }
}

/* ---------------------------------------------------------------- invoice */

async function syncInvoiceDoc(db, invoiceId) {
  const cfg = await getSyncConfig(db);
  if (!cfg.enabled || !graph.syncConfigured() || !cfg.docTypes.has("invoices")) return { skipped: true };

  let head;
  try {
    const { rows } = await db.query(
      `SELECT i.id, i.invoicecode, i.projectid,
              p.projectnumber AS code, p.entityid AS "entityId", p.projectname AS name
       FROM invoices i
       LEFT JOIN projects p ON p.id = i.projectid::bigint
       WHERE i.id = $1`,
      [invoiceId]
    );
    head = rows[0];
  } catch (err) {
    return { error: err.message };
  }
  if (!head) return { skipped: true };

  // Bail before the (costly) PDF render if this invoice's target provider
  // isn't wired yet.
  const proj0 = head.projectid ? { code: head.code, entityId: head.entityId, name: head.name } : null;
  const t0 = backupTarget(cfg, "invoices", proj0);
  if (!t0.location) return { skipped: true };
  const unsupported0 = unsupportedProvider(t0.provider);
  if (unsupported0) {
    await record(db, "invoice_doc", head.id, { target: t0.location, status: "error", error: unsupported0 });
    return { skipped: true };
  }

  // loadInvoiceForPdf lives on the invoicing route module — lazy-require so
  // the route ↔ lib hook doesn't form a load-time cycle.
  let buffer;
  try {
    const invoicing = require("../routes/invoicing");
    const data = await invoicing._loadInvoiceForPdf(invoiceId);
    if (!data) return { skipped: true };
    buffer = await renderInvoicePdfBuffer(data);
  } catch (err) {
    await record(db, "invoice_doc", head.id, { status: "error", error: `render: ${err.message}` });
    return { error: err.message };
  }

  const { location, folder } = t0;
  const filename = `invoice_${sanitize(head.invoicecode || `#${head.id}`)}.pdf`;
  const sig = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);

  try {
    const resolved = await graph.resolveLocation(location);
    const up = await graph.uploadFile(resolved, folder, filename, buffer, "application/pdf");
    await record(db, "invoice_doc", head.id, {
      sourceSig: sig, target: location,
      remoteId: up.id, remoteUrl: up.webUrl, remotePath: `${folder}/${filename}`, status: "ok",
    });
    return { ok: true };
  } catch (err) {
    await record(db, "invoice_doc", head.id, { sourceSig: sig, target: location, status: "error", error: err.message });
    return { error: err.message };
  }
}

/* ----------------------------------------------------------- project folder */

async function syncProjectFolder(db, project) {
  // project: { id, code, entityId, name }
  const cfg = await getSyncConfig(db);
  if (!cfg.enabled || !graph.syncConfigured() || !cfg.projectsLocation) return { skipped: true };
  if (!project || !project.code || project.entityId == null || project.entityId === "") return { skipped: true };

  const folderName = projectFolderName(project.code, project.entityId, project.name);

  const unsupported = unsupportedProvider(cfg.projectsProvider);
  if (unsupported) {
    await record(db, "project_folder", project.id, { sourceSig: folderName, target: cfg.projectsLocation, status: "error", error: unsupported });
    return { skipped: true };
  }
  try {
    const created = await graph.createProjectFolder(folderName, cfg.projectsLocation);
    await record(db, "project_folder", project.id, {
      sourceSig: folderName, target: cfg.projectsLocation,
      remoteId: created.id, remoteUrl: created.webUrl, remotePath: folderName, status: "ok",
    });
    return { ok: true, created: true, name: created.name, webUrl: created.webUrl };
  } catch (err) {
    await record(db, "project_folder", project.id, { sourceSig: folderName, target: cfg.projectsLocation, status: "error", error: err.message });
    return { error: err.message, created: false };
  }
}

module.exports = {
  getSyncConfig,
  projectFolderName,
  backupTarget,
  syncExpenseDoc,
  syncInvoiceDoc,
  syncProjectFolder,
};
