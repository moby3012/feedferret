#!/bin/sh
# Fallback schema sync with `prisma db push` (FEEDFERRET_DB_SYNC=push / push-unsafe, see
# scripts/db-migrate.sh; also `pnpm run prisma:push`). The default startup path is
# `prisma migrate deploy` (scripts/db-migrate.sh).
#
#   sh scripts/db-sync.sh                     refuses changes that would lose data
#   sh scripts/db-sync.sh --accept-data-loss  old pre-M11 behaviour (explicit opt-in only)
#
# Idempotent; never drops objects the app created itself:
#   SQLite:   article_fts (FTS5) + its shadow tables + our bookkeeping tables are declared
#             as external tables in prisma/cli-config.mjs, so `db push` leaves them alone.
#   Postgres: the pg_trgm GIN search indexes are part of the Postgres schema variant
#             (scripts/prepare-prisma-schema.mjs), so `db push` keeps them instead of dropping
#             them on every deploy. The extension must exist before `db push` can create them.
#   `db push` ignores the `_prisma_migrations` table, so switching back to migrations later works.
#
# The CLI reads prisma/startup.config.mjs (plain object, no `prisma/config` import) so this
# works in the runner image, where only the globally installed Prisma CLI is available.
set -e

# Startup always pushes the repository schema: a dev/CI-only schema override must never
# reach `db push` in production.
unset PRISMA_SCHEMA_OVERRIDE

PRISMA_CMD="${PRISMA_CMD:-prisma}"
CONFIG="prisma/startup.config.mjs"
. "$(dirname "$0")/db-common.sh"

ACCEPT_DATA_LOSS=""
if [ "${1:-}" = "--accept-data-loss" ]; then ACCEPT_DATA_LOSS="--accept-data-loss"; fi

ensure_pg_trgm
node scripts/prepare-prisma-schema.mjs
log "🔄 Running database sync (db push${ACCEPT_DATA_LOSS:+ $ACCEPT_DATA_LOSS})..."
$PRISMA_CMD db push --config "$CONFIG" $ACCEPT_DATA_LOSS
