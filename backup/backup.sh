#!/usr/bin/env bash
#
# Ops nightly backup — dump every database on this host, ship it off-box.
#
#   pg_dump -Fc each DB  ->  local run dir  ->  rclone copy to object storage
#   then prune local (LOCAL_KEEP_DAYS) and remote (REMOTE_KEEP_DAYS).
#
# Runs on BOTH VPSes. What gets dumped is whatever Postgres reports on the
# clusters listed in PG_CLUSTERS, minus the templates. So a newly provisioned
# ops_<slug> silo is picked up the same night with no config change.
#
# Config: backup/config.env (gitignored). Copy from config.env.example.
# Override its path with OPS_BACKUP_CONFIG=/path/to/env.
#
# Exit non-zero on any failure. If HEALTHCHECK_URL is set it pings
#   <url>/start  on start, <url>  on success, <url>/fail  on failure
# (healthchecks.io / Uptime Kuma push convention) so silence => alarm.

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${OPS_BACKUP_CONFIG:-$HERE/config.env}"

log()  { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
ping_hc() {  # $1 = "" | start | fail   — no-op until HEALTHCHECK_URL is set
  local url="${HEALTHCHECK_URL:-}"
  [ -n "$url" ] || return 0
  curl -fsS -m 15 --retry 3 -o /dev/null "${url}${1:+/$1}" || true
}
die()  { log "ERROR: $*"; ping_hc fail; exit 1; }

[ -f "$CONFIG" ] || die "config not found: $CONFIG (copy from $HERE/config.env.example)"
# shellcheck disable=SC1090
source "$CONFIG"

PG_CLUSTERS="${PG_CLUSTERS:-127.0.0.1:5432}"
PG_SUPERUSER="${PG_SUPERUSER:-postgres}"
EXCLUDE_DBS="${EXCLUDE_DBS:-}"
LOCAL_DIR="${LOCAL_DIR:-/var/backups/ops}"
LOCAL_KEEP_DAYS="${LOCAL_KEEP_DAYS:-7}"
REMOTE_KEEP_DAYS="${REMOTE_KEEP_DAYS:-31}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}"
HOSTLABEL="${HOSTLABEL:-$(hostname -s)}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-}"
# Space-separated dirs of on-disk files to mirror (expense evidence etc.).
# Synced as-is to <remote>/<host>/files/<basename>/ — not point-in-time,
# just a running mirror. Empty = skip.
UPLOAD_DIRS="${UPLOAD_DIRS:-}"

RUN_DATE="$(date -u +%Y-%m-%d)"
RUN_TS="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$LOCAL_DIR/$HOSTLABEL/$RUN_DATE"

on_err() {
  local rc=$?
  log "backup FAILED (rc=$rc) at line ${BASH_LINENO[0]}"
  ping_hc fail
  exit "$rc"
}
trap on_err ERR

command -v pg_dump >/dev/null || die "pg_dump not on PATH"
command -v psql    >/dev/null || die "psql not on PATH"
if [ -n "$RCLONE_REMOTE" ]; then
  command -v rclone >/dev/null || die "rclone not on PATH but RCLONE_REMOTE is set"
else
  log "WARNING: RCLONE_REMOTE is empty — local-only backup, nothing shipped off-box"
fi

ping_hc start
mkdir -p "$RUN_DIR"
log "run dir: $RUN_DIR"

MANIFEST="$RUN_DIR/MANIFEST.txt"
: > "$MANIFEST"
dumped=0

is_excluded() {
  local db="$1" x
  for x in $EXCLUDE_DBS; do [ "$db" = "$x" ] && return 0; done
  return 1
}

for cluster in $PG_CLUSTERS; do
  host="${cluster%%:*}"; port="${cluster##*:}"
  admin="postgresql://${PG_SUPERUSER}@${host}:${port}/postgres"
  log "cluster ${host}:${port} — listing databases"
  dbs="$(psql -w -Atqc \
    "SELECT datname FROM pg_database WHERE datistemplate = false AND datname <> 'postgres' ORDER BY datname" \
    "$admin")" || die "cannot list databases on ${host}:${port} (check ~/.pgpass)"

  for db in $dbs; do
    if is_excluded "$db"; then log "  skip $db (EXCLUDE_DBS)"; continue; fi
    out="$RUN_DIR/${HOSTLABEL}__${host}_${port}__${db}__${RUN_TS}.dump"
    log "  dump ${host}:${port}/${db}"
    pg_dump -w -Fc -Z 6 -f "$out" "postgresql://${PG_SUPERUSER}@${host}:${port}/${db}" \
      || die "pg_dump failed for ${host}:${port}/${db}"
    sz="$(stat -c %s "$out")"
    [ "$sz" -gt 0 ] || die "empty dump for $db"
    sha="$(sha256sum "$out" | cut -d' ' -f1)"
    printf '%s  %10d  %s\n' "$sha" "$sz" "$(basename "$out")" >> "$MANIFEST"
    dumped=$((dumped + 1))
  done
done

[ "$dumped" -gt 0 ] || die "no databases dumped"
log "dumped $dumped database(s), $(du -sh "$RUN_DIR" | cut -f1) total"

if [ -n "$RCLONE_REMOTE" ]; then
  dest="${RCLONE_REMOTE%/}/$HOSTLABEL/$RUN_DATE"
  log "upload -> $dest"
  rclone copy "$RUN_DIR" "$dest" --transfers 2 --checksum || die "rclone copy failed"
  # verify every local file made it, byte-for-byte
  rclone check "$RUN_DIR" "$dest" --one-way || die "rclone check failed — upload incomplete"
  log "upload verified"

  # running mirror of on-disk upload dirs (not point-in-time)
  for d in $UPLOAD_DIRS; do
    [ -d "$d" ] || { log "  skip files mirror: $d (not a dir)"; continue; }
    fdest="${RCLONE_REMOTE%/}/$HOSTLABEL/files/$(basename "$d")"
    log "  mirror $d -> $fdest"
    rclone sync "$d" "$fdest" --transfers 4 || log "WARNING: files mirror failed for $d (non-fatal)"
  done
fi

# --- prune local ---
if [ -d "$LOCAL_DIR/$HOSTLABEL" ]; then
  find "$LOCAL_DIR/$HOSTLABEL" -mindepth 1 -maxdepth 1 -type d -mtime "+$LOCAL_KEEP_DAYS" \
    -print -exec rm -rf {} + | sed 's/^/  prune local: /' || true
fi

# --- prune remote ---
if [ -n "$RCLONE_REMOTE" ]; then
  log "prune remote older than ${REMOTE_KEEP_DAYS}d"
  rclone delete "${RCLONE_REMOTE%/}/$HOSTLABEL" --min-age "${REMOTE_KEEP_DAYS}d" --rmdirs || \
    log "WARNING: remote prune failed (non-fatal)"
fi

log "backup OK — $dumped db(s) from $HOSTLABEL"
ping_hc
