# External document sync (Settings → Sync)

Ops can copy documents it holds into the company's Microsoft 365 storage
(OneDrive / SharePoint) as a backup. Configure it in **Settings → Sync**.

## What it does

| Setting | Meaning |
|---|---|
| **Projects — external storage location** (`sync.projects_location`) | Ops keeps one folder per project here, named `PROJECTNUMBER_ENTITYID PROJECT NAME` (entity id zero-padded to 3 digits). Created when a project is created and by the catch-up job. Falls back to the `GRAPH_ONEDRIVE_FOLDER` env var when empty. |
| **Other documents — backup location** (`sync.other_docs_location`) | Base folder for the document-type backup below. |
| **Back up these document types** (`sync.backup_doc_types`) | `tickets` = every expense's evidence file · `invoices` = the rendered invoice PDF. |
| **File backups under each document's project folder** (`sync.backup_under_project`) | **Off** — documents are grouped by type: `<location>/Tickets/…`, `<location>/Invoices/…`. **On** — a document goes under its project's folder: `<location>/PROJECTNUMBER_ENTITYID NAME/…` (documents with no project go to `<location>/_Unassigned/Tickets|Invoices/…`). File names carry a `ticket_<id>_…` / `invoice_<code>.pdf` prefix so the two are still distinguishable. |

A **location** is either a plain folder path in `GRAPH_ONEDRIVE_USER`'s drive
(like `GRAPH_ONEDRIVE_FOLDER`, e.g. `Clients/Backups`) **or** a full
SharePoint / OneDrive share URL (`https://…sharepoint.com/…`). A share URL is
resolved once via Graph `/shares`.

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

Google Drive; cross-tenant auth (writes go to the drive the current
`Sites.Selected` grant covers); mirroring deletes or renames (removing a
document in Ops leaves the backup copy in place); copying project working
files into project folders (only the backup of tickets / invoices);
per-invoice letterhead accuracy for non-HiTT entities (the PDF still renders,
just with the HiTT template).
