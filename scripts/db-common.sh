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

# Postgres only: decide PRISMA_PG_TRGM for the prepared schema (scripts/db-state.mjs
# ensurePgTrgm). Waits for the database first. The extension already installed -> 1.
# Otherwise CREATE EXTENSION; only a confirmed privilege/availability error (and the
# extension still missing) -> 0, i.e. continue without trigram indexes. Any other error
# (connection loss, ...) is retried and then fails the start, so a transient problem can
# never make `db push` drop the existing trigram indexes.
ensure_pg_trgm() {
  is_postgres || return 0
  trgm="$(node "$(dirname "$0")/db-state.mjs" ensure-trgm)" || { log "❌ Could not verify the pg_trgm extension; not starting."; exit 1; }
  export PRISMA_PG_TRGM="$trgm"
  if [ "$trgm" = 1 ]; then log "✅ pg_trgm extension available."; fi
}
