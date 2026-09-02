#!/usr/bin/env bash
#
# Restore one Ops database dump (produced by backup.sh / pg_dump -Fc).
#
#   backup/restore.sh <dump> <target-db> [host:port] [--force] [--jobs N]
#
#   <dump>        a local .dump file, OR
#                 rclone:<remote>/<path>        — a dir; must contain exactly one .dump
#                 rclone:<remote>/<path>.dump   — a specific object
#   <target-db>   database to create and restore into. Must not already exist
#                 unless --force is given (then it is dropped first).
#   [host:port]   Postgres to restore into (default 127.0.0.1:5432)
#
#   --force       drop <target-db> if it exists before restoring
#   --jobs N      parallel restore workers (default 2)
#
# Auth: ~/.pgpass as the postgres superuser. Never prompts (-w).
# Exits non-zero if the restored DB ends up with no user tables.
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
  echo "usage: restore.sh <dump|rclone:remote/path> <target-db> [host:port] [--force] [--jobs N]" >&2
  exit 1
}

host="${CLUSTER%%:*}"; port="${CLUSTER##*:}"
SU="${PG_SUPERUSER:-postgres}"
admin="postgresql://${SU}@${host}:${port}/postgres"
target_url="postgresql://${SU}@${host}:${port}/${TARGET_DB}"
log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

# --- pull from object storage if asked ---
if [[ "$DUMP" == rclone:* ]]; then
  command -v rclone >/dev/null || { echo "rclone not on PATH" >&2; exit 1; }
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  src="${DUMP#rclone:}"
  if [[ "$src" == *.dump ]]; then
    log "fetching $src"
    rclone copyto "$src" "$tmp/$(basename "$src")"
  else
    log "fetching *.dump under $src"
    rclone copy "$src" "$tmp" --include '*.dump' --max-depth 4 --transfers 2
  fi
  mapfile -t hits < <(find "$tmp" -type f -name '*.dump' | sort)
  if [ "${#hits[@]}" -eq 0 ]; then
    echo "no .dump found at rclone path: $src" >&2
    echo "contents of that path:" >&2
    rclone lsf "$src" --max-depth 3 2>/dev/null | sed 's/^/  /' >&2 || echo "  (path missing or empty)" >&2
    exit 1
  elif [ "${#hits[@]}" -gt 1 ]; then
    echo "multiple dumps under $src — re-run pointing at one:" >&2
    for h in "${hits[@]}"; do echo "  rclone:${src%/}/$(basename "$h")" >&2; done
    exit 1
  fi
  DUMP="${hits[0]}"
  log "using $(basename "$DUMP")"
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
# grants. -Fc dumps carry their own schemas (public, or eventstore/projections/
# … for the Zitadel DB), so this restores whatever the dump held.
pg_restore -w --no-owner --no-privileges --jobs "$JOBS" --exit-on-error \
  -d "$target_url" "$DUMP"

# --- verify: table counts per schema, and fail loudly on an empty restore ---
log "restored — tables by schema:"
psql -w -Atqc "
  SELECT '  ' || n.nspname || ': ' || count(*)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r','p')
    AND n.nspname NOT IN ('pg_catalog','information_schema')
    AND n.nspname !~ '^pg_'
  GROUP BY n.nspname ORDER BY n.nspname" "$target_url"

total="$(psql -w -Atqc "
  SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r','p')
    AND n.nspname NOT IN ('pg_catalog','information_schema')
    AND n.nspname !~ '^pg_'" "$target_url")"

if [ "${total:-0}" -eq 0 ]; then
  echo "WARNING: ${TARGET_DB} has no user tables after restore — the dump looks empty or wrong" >&2
  exit 1
fi
log "done — ${TARGET_DB}: ${total} tables total"
