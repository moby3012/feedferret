#!/bin/sh
# Shared helpers for scripts/db-migrate.sh and scripts/db-sync.sh (sourced, POSIX sh).
# Expects PRISMA_CMD and CONFIG to be set by the caller.

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

is_postgres() {
  case "$(echo "${DATABASE_PROVIDER:-sqlite}" | tr '[:upper:]' '[:lower:]')" in
    postgres|postgresql) return 0 ;;
    *) return 1 ;;
  esac
}

# Postgres only: create the pg_trgm extension the trigram search indexes need.
# pg_trgm is a trusted extension (PG >= 13): the database owner can create it. If the
# role cannot, continue without the trigram indexes (search still works, unaccelerated)
# and export PRISMA_PG_TRGM=0 so the prepared schemas leave the `gin_trgm_ops` indexes
# out (instead of failing on the unknown operator class).
# Only a missing privilege / unavailable extension skips the indexes. Any other error
# (e.g. a connection blip) is retried once, so a transient failure doesn't make the
# schema step drop the existing indexes on prod.
ensure_pg_trgm() {
  is_postgres || return 0
  create_trgm() { echo 'CREATE EXTENSION IF NOT EXISTS pg_trgm;' | $PRISMA_CMD db execute --stdin --config "$CONFIG" 2>&1; }
  trgm_ok=0
  if out=$(create_trgm); then
    trgm_ok=1
  elif ! echo "$out" | grep -qiE 'permission denied|42501|must be owner|must have CREATE privilege|not available|could not open extension control file'; then
    log "⚠️ Creating the pg_trgm extension failed; retrying once."
    echo "$out" | grep -v '^\s*$' | tail -n 5
    sleep 3
    if out=$(create_trgm); then trgm_ok=1; fi
  fi
  if [ "$trgm_ok" = 1 ]; then
    log "✅ pg_trgm extension available."
  else
    log "⚠️ Could not create the pg_trgm extension; starting without trigram search indexes."
    echo "$out" | grep -v '^\s*$' | tail -n 5
    export PRISMA_PG_TRGM=0
  fi
}
