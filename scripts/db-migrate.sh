#!/bin/sh
# Brings the database schema up to date on every start (start.sh in the Docker image,
# `pnpm run prisma:migrate` for `pnpm start`). Mode via FEEDFERRET_DB_SYNC:
#
#   migrate (default)  scripts/db-migrate.mjs: `prisma migrate deploy` with
#                      prisma/migrations/<provider>, under a Postgres advisory lock. A
#                      database created by the old `db push` startup ("legacy", no
#                      `_prisma_migrations`) is adopted once (see db-migrate.mjs): only
#                      pure-DDL migrations are ever marked applied without running them,
#                      gaps are closed with `db push` only if pure DDL (never
#                      --accept-data-loss); anything else stops the start.
#   push               fallback/rollback: `db push` without --accept-data-loss (scripts/db-sync.sh)
#   push-unsafe        pre-M11 behaviour: `db push --accept-data-loss`. Explicit, one-off opt-in.
#   skip               do not touch the schema (e.g. migrations run as a separate job)
#
# Fails closed: every unexpected result exits non-zero, so the container does not start on
# a half-migrated or unverified schema. Nothing on the default path drops data.
set -e

# Startup always uses the repository schema: a dev/CI-only schema override must never
# reach a startup `db push`/`migrate`. (db-migrate.mjs sets it per command for adoption only.)
unset PRISMA_SCHEMA_OVERRIDE

export PRISMA_CMD="${PRISMA_CMD:-prisma}"
CONFIG="prisma/startup.config.mjs"
SCRIPT_DIR="$(dirname "$0")"
. "$SCRIPT_DIR/db-common.sh"

fail() {
  log "❌ $*"
  exit 1
}

MODE="$(echo "${FEEDFERRET_DB_SYNC:-migrate}" | tr '[:upper:]' '[:lower:]')"
case "$MODE" in
  migrate) ;;
  push)
    log "⚠️ FEEDFERRET_DB_SYNC=push: using the db push fallback (refuses data loss) instead of migrations."
    exec sh "$SCRIPT_DIR/db-sync.sh"
    ;;
  push-unsafe)
    log "⚠️ WARNING: FEEDFERRET_DB_SYNC=push-unsafe: running db push --accept-data-loss. This can DROP columns/tables. Only use it once, after a verified backup, then unset it."
    exec sh "$SCRIPT_DIR/db-sync.sh" --accept-data-loss
    ;;
  skip)
    log "⚠️ FEEDFERRET_DB_SYNC=skip: not touching the database schema."
    exit 0
    ;;
  *)
    fail "Unknown FEEDFERRET_DB_SYNC=\"$FEEDFERRET_DB_SYNC\" (use migrate, push, push-unsafe or skip)."
    ;;
esac

# migrate: orchestration (pg_trgm check, Postgres advisory lock, legacy adoption,
# migrate deploy, drift check) lives in scripts/db-migrate.mjs.
exec node "$SCRIPT_DIR/db-migrate.mjs"
