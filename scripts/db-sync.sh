#!/bin/sh
# Brings the database schema in line with prisma/schema.prisma. Runs on every start
# (start.sh in the Docker image, `pnpm run prisma:push` for `pnpm start`), so it must be
# idempotent and must never drop data or objects the app created itself:
#
#   SQLite:   article_fts (FTS5) + its shadow tables + our bookkeeping tables are declared
#             as external tables in prisma/cli-config.mjs, so `db push` leaves them alone.
#   Postgres: the pg_trgm GIN search indexes are part of the Postgres schema variant
#             (scripts/prepare-prisma-schema.mjs), so `db push` keeps them instead of dropping
#             them on every deploy. The extension must exist before `db push` can create them.
#
# The CLI reads prisma/startup.config.mjs (plain object, no `prisma/config` import) so this
# works in the runner image, where only the globally installed Prisma CLI is available.
set -e

# Startup always pushes the repository schema: a dev/CI-only schema override must never
# reach `db push --accept-data-loss` in production.
unset PRISMA_SCHEMA_OVERRIDE

PRISMA_CMD="${PRISMA_CMD:-prisma}"
CONFIG="prisma/startup.config.mjs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

case "$(echo "${DATABASE_PROVIDER:-sqlite}" | tr '[:upper:]' '[:lower:]')" in
  postgres|postgresql)
    # pg_trgm is a trusted extension (PG >= 13): the database owner can create it. If the
    # role cannot, start without the trigram indexes (search still works, unaccelerated)
    # instead of failing `db push` on the unknown `gin_trgm_ops` operator class.
    # Only a missing privilege / unavailable extension skips the indexes. Any other error
    # (e.g. a connection blip) is retried once, so a transient failure doesn't make
    # `db push` drop the existing indexes on prod.
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
    ;;
esac

node scripts/prepare-prisma-schema.mjs
$PRISMA_CMD db push --config "$CONFIG" --accept-data-loss
