# Backups (0F)

Every database on both VPSes is dumped nightly and shipped to object storage,
client-side encrypted. One restore path, tested monthly. This doc is also the
rebuild-from-zero runbook.

## Model

| | |
|---|---|
| **What** | `pg_dump -Fc` of every non-template DB on the clusters in `PG_CLUSTERS` |
| **When** | nightly, `02:30 UTC` + up to 30 min jitter (`ops-backup.timer`) |
| **Where local** | `/var/backups/ops/<host>/<date>/` — kept `LOCAL_KEEP_DAYS` (7) |
| **Where remote** | `<RCLONE_REMOTE>/<host>/<date>/` — kept `REMOTE_KEEP_DAYS` (31) |
| **Encryption** | rclone `crypt` remote — dumps are encrypted on the box before upload; the bucket only ever sees ciphertext |
| **Integrity** | per-file sha256 in `MANIFEST.txt`; `rclone check` after every upload |
| **Alerting** | healthcheck ping (healthchecks.io or Uptime Kuma, `HEALTHCHECK_STYLE`) + systemd `OnFailure=` |

New `ops_<slug>` silos need **no** backup config change — they're discovered
from `pg_database` the same night they're provisioned.

### Coverage per host

- **Ops VPS** (`127.0.0.1:5432`): `zitadel`, every `ops_<slug>` silo.
  Losing `zitadel` means re-federating IdPs and re-creating orgs/apps — back it up.
- **HITT VPS**: `ops` (production HITT), and `test_ops` if present. Set
  `PG_CLUSTERS` to include the second cluster's port if `test_ops` runs
  separately (e.g. `"127.0.0.1:5432 127.0.0.1:8432"`).

### What is NOT in these dumps

- Uploaded evidence files — mirrored separately via `UPLOAD_DIRS`, see [below](#file-uploads).
- WAL / point-in-time recovery — [fast-follow](#wal-archiving-fast-follow).
- Code and per-instance config — in git and in `/srv/ops/<slug>/` (rebuildable
  by `provision.js`; the `env` file holds generated secrets, see the runbook).

## One-time setup (per VPS)

### 1. Tools

```bash
sudo apt install -y rclone      # >= 1.60; or the official install script
# postgresql-client is already present (provision.js uses psql/pg_dump)
```

### 2. Postgres auth — root's `.pgpass`

`backup.sh` runs as root and connects over TCP as `postgres`, so:

```bash
sudo tee -a /root/.pgpass >/dev/null <<'EOF'
127.0.0.1:5432:*:postgres:REPLACE_WITH_POSTGRES_PASSWORD
EOF
sudo chmod 600 /root/.pgpass
```

(The Ops VPS already has this from provisioning. Add a second line if you
back up a second cluster/port.)

### 3. Object storage bucket

Create a bucket in **IONOS Object Storage** (S3-compatible, EU region — same
provider, same data-residency story as the VPS and DNS). You need:

- endpoint, e.g. `https://s3.eu-central-3.ionoscloud.com`
- region, e.g. `eu-central-3`
- an access key / secret key pair scoped to this bucket
- bucket name, e.g. `ops-backups`

Turn on **object lock / versioning** if the plan offers it — that defends the
backups against a compromised VPS deleting them. Set a lifecycle rule to expire
objects after ~35 days as a backstop to the script-side prune.

> Any S3-compatible target works (Backblaze B2, Cloudflare R2, AWS S3, Wasabi).
> Swap the endpoint/provider in the rclone config below.

### 4. rclone config — S3 remote + crypt wrapper

Run as root (`sudo -i`), non-interactively:

```bash
rclone config create ionos-s3 s3 \
  provider=IONOS \
  access_key_id=YOUR_ACCESS_KEY \
  secret_access_key=YOUR_SECRET_KEY \
  endpoint=https://s3.eu-central-3.ionoscloud.com \
  region=eu-central-3 \
  acl=private

# Generate two strong secrets and KEEP THEM SAFE (see below):
PW=$(rclone obscure "$(openssl rand -base64 24)")
SALT=$(rclone obscure "$(openssl rand -base64 24)")

rclone config create ionos-crypt crypt \
  remote=ionos-s3:ops-backups \
  filename_encryption=standard \
  directory_name_encryption=true \
  password="$PW" \
  password2="$SALT"

rclone lsd ionos-crypt:            # smoke test — should not error
```

`ionos-crypt:` is now rooted at the bucket, so `RCLONE_REMOTE="ionos-crypt:"`
(nothing after the colon) — the script appends `<host>/<date>` itself, and
restore paths are `rclone:ionos-crypt:<host>/<date>`. Don't repeat the bucket
name in `RCLONE_REMOTE` or you get a redundant `ops-backups/ops-backups/…`
nesting.

> **The crypt password + salt are the only way to read the backups.** They're
> stored obscured (not encrypted) in `/root/.config/rclone/rclone.conf`. Copy
> that file — or the two plaintext values — into your password manager / offline
> store. If the VPS dies and you don't have them, the off-box backups are
> unreadable. This is the one secret whose loss is unrecoverable.

Lock the config down:

```bash
sudo chmod 600 /root/.config/rclone/rclone.conf
```

### 5. Backup config

```bash
sudo mkdir -p /etc/ops
sudo install -m 600 /opt/ops/backup/config.env.example /etc/ops/backup.env
sudo nano /etc/ops/backup.env      # set PG_CLUSTERS, RCLONE_REMOTE, HEALTHCHECK_URL, HOSTLABEL
```

Set `HOSTLABEL` explicitly per box (`ops-vps`, `hitt-vps`) — both boxes
currently `hostname -s` to `ubuntu`/similar and would collide in the bucket.

### 6. Healthcheck (dead-man's-switch)

If a night's backup doesn't run — timer broken, box down, script hung — the
check goes red and pages you. Silence = alarm, the only model that catches
"cron silently stopped". Two supported back-ends, selected by
`HEALTHCHECK_STYLE`:

**healthchecks.io / Better Stack** (`HEALTHCHECK_STYLE=healthchecks`, default) —
create a check with **period 1 day, grace 3 hours**, set `HEALTHCHECK_URL` to
its ping URL. The script hits `<url>/start`, `<url>`, `<url>/fail`.

**Self-hosted Uptime Kuma** (`HEALTHCHECK_STYLE=kuma`):

1. In Kuma: **Add New Monitor** → Monitor Type **Push**.
2. Set **Heartbeat Interval** to `90000` seconds (25 h — one day plus a margin;
   the max the UI accepts is 2 592 000) and **Retries** `0`, or set retries `1`
   with a short retry interval. The point: it should expire ~1–2 h after a
   normal 02:30 run would have pinged.
3. Save. Kuma shows a **Push URL** like
   `https://kuma.example.com/api/push/AbC12dEf34?status=up&msg=OK&ping=`.
4. Put **only the base** in the config — drop the `?status=...` query string:
   ```
   HEALTHCHECK_STYLE="kuma"
   HEALTHCHECK_URL="https://kuma.example.com/api/push/AbC12dEf34"
   ```
   `backup.sh` appends `?status=up&msg=OK` on success and
   `?status=down&msg=backup%20failed%20on%20<host>` on failure. (Kuma has no
   "start" ping, so that call is a no-op.)
5. Add a **Notification** (email, ntfy, Telegram, …) to the monitor so a
   missed heartbeat actually reaches you.

Test it: `sudo systemctl start ops-backup.service`, then confirm the monitor
flips to green in Kuma. To test the down path, run with a bad `PG_CLUSTERS`
and confirm it goes red.

Optionally edit `ops-backup-failed.service` (option A/B) so an *explicit*
failure also mails you, covering the case where the script dies before it can
ping `/fail`.

### 7. Install the units

```bash
sudo cp /opt/ops/backup/systemd/ops-backup*.service /etc/systemd/system/
sudo cp /opt/ops/backup/systemd/ops-backup.timer     /etc/systemd/system/
sudo chmod +x /opt/ops/backup/*.sh
sudo systemctl daemon-reload
sudo systemctl enable --now ops-backup.timer
sudo systemctl list-timers ops-backup.timer          # confirm next run
```

### 8. First run — verify end to end

```bash
sudo systemctl start ops-backup.service               # run it now
journalctl -u ops-backup.service -f                   # watch
ls -R /var/backups/ops/                               # local dumps + MANIFEST
sudo rclone tree ionos-crypt:                         # decrypted listing (host/date/*.dump)
sudo rclone lsf ionos-s3:ops-backups --recursive | head   # raw = encrypted names
```

Then do a real restore (next section) before you call 0F done.

## Restore

`backup/restore.sh` is the one blessed path — used for both the monthly drill
and real recovery.

```bash
# from a local dump file:
sudo /opt/ops/backup/restore.sh \
  /var/backups/ops/ops-vps/2026-09-02/ops-vps__127.0.0.1_5432__ops_demo__20260902T023012Z.dump \
  ops_demo_restore

# straight from object storage — a date dir with exactly one dump:
sudo /opt/ops/backup/restore.sh \
  rclone:ionos-crypt:ops-vps/2026-09-02 \
  ops_demo_restore

# ...or point at one object when the dir holds several DBs (restore.sh lists
# them for you if you give it just the dir):
sudo /opt/ops/backup/restore.sh \
  rclone:ionos-crypt:ops-vps/2026-09-02/ops-vps__127.0.0.1_5432__ops_demo__20260902T023012Z.dump \
  ops_demo_restore
```

It creates the target DB (refuses if it exists unless `--force`), runs
`pg_restore --no-owner --no-privileges --exit-on-error`, then prints table
counts per schema and **exits non-zero if the restored DB has no user tables**
(so a broken/empty dump fails the drill loudly). The Ops DBs land in `public`;
the `zitadel` DB lands in `eventstore` / `projections` / `auth` / … — the
count covers all of them. To point an instance at the restored DB, update
`PG*` in `/srv/ops/<slug>/env` and `systemctl restart ops@<slug>`.

### Monthly restore drill

1. Pick the newest `ops` (HITT) or a live silo dump.
2. `restore.sh <dump> ops_drill_YYYYMM`.
3. Sanity check:
   ```bash
   psql -w postgresql://postgres@127.0.0.1:5432/ops_drill_YYYYMM \
     -c "SELECT count(*) FROM projects" -c "SELECT max(invoicedate) FROM invoices"
   ```
4. Record wall-clock restore time and the dump's age in `docs/backup-drills.md`
   (date, DB, dump timestamp, restore seconds, notes).
5. `psql ... -c "DROP DATABASE ops_drill_YYYYMM WITH (FORCE)"`.

### RTO / RPO

- **RPO** ≈ 24 h (last nightly dump). Tightened by [WAL archiving](#wal-archiving-fast-follow).
- **RTO**: single DB restore is minutes. Full box loss = provision a new VPS +
  restore — target **< 4 h**, measured by the drill + the runbook below.

Fill in real numbers after the first drill:

| date | scope | dump age | restore time | notes |
|---|---|---|---|---|
| _tbd_ | | | | |

## Rebuild from zero — full VPS loss

### Ops VPS (SaaS host)

1. **New VPS**, Ubuntu 24.04, same size. DNS `A` for `theaumol.com` bits →
   new IP (IONOS DNS panel or API).
2. **Base**: `apt install nginx postgresql rclone python3-venv nodejs`,
   create the `ops` system user, `git clone` the repo to `/opt/ops`,
   `npm --prefix server ci`.
3. **rclone**: recreate `ionos-s3` + `ionos-crypt` remotes from the saved
   password manager values (step 4 above). Without the crypt secrets you
   cannot proceed — this is why they're stored off-box.
4. **Postgres**: restore `zitadel` first —
   `restore.sh rclone:ionos-crypt:ops-vps/<latest> zitadel`.
5. **Zitadel**: redeploy the container with the *same*
   `ZITADEL_MASTERKEY` (saved off-box) pointing at the restored DB. Restore
   its nginx vhost + the `theaumol` cert (`certbot certonly` again, DNS-01 —
   see [tls.md](tls.md)).
6. **TLS**: reissue both wildcard certs (`ops`, `theaumol`).
7. **Instances**: for each slug in the last `registry.json` (it's in
   `/srv/ops/registry.json` — also dumped? no: copy it into the bucket too, or
   reconstruct from bucket dir names):
   - `restore.sh rclone:ionos-crypt:ops-vps/<latest> ops_<slug>`
   - recreate the scoped role + grants (rerun the relevant `provision.js`
     steps, or `provision.js <slug> ... --repair` once that flag exists)
   - restore `/srv/ops/<slug>/env` + `config.js` from the bucket copy, or
     re-render and re-inject the OIDC client + regenerate the session secret
   - `systemctl enable --now ops@<slug>`, restore its nginx vhost
8. **Backups**: reinstall the timer (step 7 above). Run one now.

> Make the rebuild materially easier: have `provision.js` also push
> `registry.json` and each `/srv/ops/<slug>/{env,config.js}` into the backup
> bucket (encrypted) on every provision. Tracked as a Phase 1 item.

### HITT VPS

Simpler — one app, one DB. New VPS → base packages → `git clone` to
`/opt/hitt-ops` → restore `ops` → restore `/opt/hitt-ops/.env` (from the
bucket or your password manager) → nginx vhost + HTTP-01 cert for its domain
→ start the service.

## File uploads

`server/uploads/` (expense evidence, etc.) lives on the app host, not in
Postgres. `backup.sh` mirrors any dirs listed in `UPLOAD_DIRS` to
`<remote>/<host>/files/<basename>/` with `rclone sync` — a running mirror, not
point-in-time (a file deleted on the box is deleted in the mirror on the next
run). Set it in `/etc/ops/backup.env`:

- Ops VPS: the per-slug `uploads` dirs under `/srv/ops/<slug>/`
- HITT VPS: `/opt/hitt-ops/server/uploads`

If you need version history on uploads, enable bucket versioning (step 3) so
the S3 side keeps overwritten/deleted objects. Moving uploads to object
storage as the primary store is a Phase 1 item.

## WAL archiving (fast-follow)

Nightly dumps give a 24 h RPO. For point-in-time recovery:

1. `postgresql.conf`: `wal_level = replica`, `archive_mode = on`,
   `archive_command = 'rclone copy %p ionos-crypt:<host>/wal/ --no-traverse'`
   (or use `pgbackrest` / `wal-g`, which do this properly with retention and
   parallelism).
2. Take a periodic base backup (`pg_basebackup` or the tool's own).
3. Restore = base backup + replay WAL to a target time.

`pgbackrest` is the recommended path here — it handles archive retention,
compression, encryption, and PITR restore in one tool, and points at the same
S3 bucket. Worth adopting wholesale once there are more than a handful of
silos. Tracked as a Phase 1 item.

## Files

| path | what |
|---|---|
| `backup/backup.sh` | the nightly job — dump, upload, verify, prune, ping |
| `backup/restore.sh` | restore one dump into a named DB (local or `rclone:` source) |
| `backup/config.env.example` | template → `/etc/ops/backup.env` (per host, gitignored) |
| `backup/systemd/ops-backup.service` | oneshot unit, runs as root |
| `backup/systemd/ops-backup.timer` | nightly 02:30 UTC + jitter |
| `backup/systemd/ops-backup-failed.service` | `OnFailure=` hook — edit to taste |
