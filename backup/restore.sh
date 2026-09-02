#!/usr/bin/env bash
#
# Restore one Ops database dump (produced by backup.sh / pg_dump -Fc).
#
#   backup/restore.sh <dump-file> <target-db> [host:port]
#
#   <dump-file>   a local .dump, or  rclone:<remote-path>  to pull it first
#   <target-db>   database to create and restore into. MUST NOT already exist
#                 unless --force is given (then it is dropped first).
#   [host:port]   Postgres to restore into (default 127.0.0.1:5432)
#
#   --force       drop <target-db> if it exists before restoring
#   --jobs N      parallel restore workers (default 2)
#
# Auth: ~/.pgpass as the postgres superuser. Never prompts (-w).
#
# This is the tested path for the monthly restore drill and for real recovery.
# See docs/backups.md.

set -Eeuo pipefail

FORCE=0
JOBS=2
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --jobs)  JOBS="$2"; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
set -- "${args[@]}"

DUMP="${1:-}"
TARGET_DB="${2:-}"
CLUSTER="${3:-127.0.0.1:5432}"
[ -n "$DUMP" ] && [ -n "$TARGET_DB" ] || {
  echo "usage: restore.sh <dump-file|rclone:remote/path> <target-db> [host:port] [--force] [--jobs N]" >&2
  exit 1
}

host="${CLUSTER%%:*}"; port="${CLUSTER##*:}"
SU="${PG_SUPERUSER:-postgres}"
admin="postgresql://${SU}@${host}:${port}/postgres"
log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

# pull from object storage if asked
tmp=""
if [[ "$DUMP" == rclone:* ]]; then
  command -v rclone >/dev/null || { echo "rclone not on PATH" >&2; exit 1; }
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  src="${DUMP#rclone:}"
  log "fetching $src"
  rclone copy "$src" "$tmp" --transfers 2
  DUMP="$(find "$tmp" -type f -name '*.dump' | head -n1)"
  [ -n "$DUMP" ] || { echo "no .dump in $src" >&2; exit 1; }
fi
[ -f "$DUMP" ] || { echo "no such file: $DUMP" >&2; exit 1; }

log "dump:   $DUMP ($(du -h "$DUMP" | cut -f1))"
log "target: ${host}:${port}/${TARGET_DB}"

exists="$(psql -w -Atqc "SELECT 1 FROM pg_database WHERE datname = '${TARGET_DB}'" "$admin")"
if [ "$exists" = "1" ]; then
  [ "$FORCE" = "1" ] || { echo "database ${TARGET_DB} already exists — pass --force to replace it" >&2; exit 1; }
  log "dropping existing ${TARGET_DB}"
  psql -w -v ON_ERROR_STOP=1 -c "DROP DATABASE ${TARGET_DB} WITH (FORCE)" "$admin"
fi

log "creating ${TARGET_DB}"
psql -w -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${TARGET_DB}" "$admin"

log "restoring (jobs=${JOBS})"
# --no-owner / --no-privileges: roles differ per instance; provision.js owns
# grants. --exit-on-error surfaces real problems; a fresh DB has no conflicts.
pg_restore -w --no-owner --no-privileges --jobs "$JOBS" --exit-on-error \
  -d "postgresql://${SU}@${host}:${port}/${TARGET_DB}" "$DUMP"

cnt="$(psql -w -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" \
  "postgresql://${SU}@${host}:${port}/${TARGET_DB}")"
log "done — ${TARGET_DB} has ${cnt} tables in public"
