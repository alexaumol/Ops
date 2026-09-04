# External document sync (Settings → Sync)

Ops can copy documents it holds into the company's Microsoft 365 storage
(OneDrive / SharePoint) as a backup. Configure it in **Settings → Sync**.

The whole feature is **off by default** — flip **Sync documents to an external
storage** (`sync.enabled`) on. While it's off, the app never contacts
OneDrive / SharePoint, the catch-up job exits immediately, and the rest of the
section is greyed out. (Existing deployments that relied on the automatic
project-folder creation on project creation must turn this on.)

## What it does

| Setting | Meaning |
|---|---|
| **Sync documents to an external storage** (`sync.enabled`) | Master on/off switch for everything below. |
| **Create project folder on a remote location** (`sync.projects_location`) | When a project is created, Ops adds a subfolder here named `PROJECTNUMBER_ENTITYID PROJECT NAME` (entity id zero-padded to 3 digits). The catch-up job backfills any project missing one. Falls back to the `GRAPH_ONEDRIVE_FOLDER` env var when empty. |
| **Back up these document types** (`sync.backup_doc_types`) | `tickets` = every expense's evidence file · `invoices` = the rendered invoice PDF. |
| **File backups under each document's project folder** (`sync.backup_under_project`) | **On** — a document is filed inside its project's folder (under the project location above): `<projects location>/PROJECTNUMBER_ENTITYID NAME/…`; documents with no project go to `<projects location>/_Unassigned/Tickets\|Invoices/…`. A separate backup location isn't used, so **"Backup other documents" is hidden**. **Off** — documents are grouped by type at the backup location below: `<backup location>/Tickets/…`, `<backup location>/Invoices/…`. Either way file names carry a `ticket_<id>_…` / `invoice_<code>.pdf` prefix. |
| **Backup other documents** (`sync.other_docs_location`) | Base folder for the by-type backup. Only used when "file under project folder" is **off**. |

Each **location** has a **provider** and a path:

| Provider | Path | Status |
|---|---|---|
| **OneDrive / SharePoint** | a folder path in `GRAPH_ONEDRIVE_USER`'s drive (like `GRAPH_ONEDRIVE_FOLDER`, e.g. `Clients/Backups`); a **"Copy link"** sharing URL (resolved once via Graph `/shares`); **or** the browser address of the folder in OneDrive (`…/onedrive.aspx?id=/personal/<user>/Documents/…` — accepted when it points at `GRAPH_ONEDRIVE_USER`'s own OneDrive, and turned into the equivalent path) | **wired** |
| **Google Drive** | a shared-drive folder link or id | **staged** — saved, but a sync attempt records a "not built yet" error row; nothing is copied |
| **Network server (UNC)** | `\\server\share\Ops` on the corporate LAN/VPN | **staged** — same |

The stored value is JSON `{"provider":"…","path":"…"}`. A bare string left over
from before the provider picker is read as `{provider:"onedrive", path:<string>}`
and upgrades on the next Save.

## Trigger

- **On upload / create** — best-effort, right after the API responds. A
  failure here never blocks or fails the upload; it's recorded and retried.
- **Hourly catch-up job** — `npm run sync:external`. Pushes anything with no
  `external_sync` row or a failed last attempt, and backfills everything that
  predates switching the feature on. Successful items are not re-pushed by the
  job (only the upload hooks refresh them when the source changes).

```bash
cd /opt/ops/server && npm run sync:external -- --dry     # report only
cd /opt/ops/server && npm run sync:external -- --limit 200
```

## Permissions

Reuses the existing app-only Graph registration (`GRAPH_TENANT_ID` /
`GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` / `GRAPH_ONEDRIVE_USER`). The app
needs write access to the target location — `Sites.Selected` granted on that
SharePoint site, or `Files.ReadWrite.All`. With the `GRAPH_*` vars unset the
whole feature is a silent no-op.

## Deploy

```bash
npm --prefix /opt/ops/server run migrate        # creates external_sync
cp backup/systemd/ops-sync-external.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ops-sync-external.timer
```

`external_sync` (one row per synced object) records the remote id / path and
the last status. `actionsaudit` gets a `sync.run` row per job run.

## Not built (v1)

Google Drive **and network-server (UNC) upload** — the provider can be picked
and the path saved, but nothing is copied until each backend lands (Google
Drive needs `googleapis` + a service account; network-server needs an SMB
client or a mounted path on the server). Cross-tenant auth (writes go to the
drive the current `Sites.Selected` grant covers); mirroring deletes or renames
(removing a
document in Ops leaves the backup copy in place); copying project working
files into project folders (only the backup of tickets / invoices);
per-invoice letterhead accuracy for non-HiTT entities (the PDF still renders,
just with the HiTT template).
