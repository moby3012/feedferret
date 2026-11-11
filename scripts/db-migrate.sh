#!/bin/sh
# Brings the database schema up to date on every start (start.sh in the Docker image,
# `pnpm run prisma:migrate` for `pnpm start`). Mode via FEEDFERRET_DB_SYNC:
#
#   migrate (default)  `prisma migrate deploy` with prisma/migrations/<provider>.
#                      A database created by the old `db push` startup ("legacy", no
#                      `_prisma_migrations` table) is adopted once: it is compared with the
#                      frozen baseline (prisma/baseline.schema.prisma); a purely additive gap
#                      is closed with `db push` (never --accept-data-loss), then the baseline
#                      migration is marked as applied. Anything destructive stops the start.
#   push               fallback/rollback: `db push` without --accept-data-loss (scripts/db-sync.sh)
#   push-unsafe        pre-M11 behaviour: `db push --accept-data-loss`. Explicit, one-off opt-in.
#   skip               do not touch the schema (e.g. migrations run as a separate job)
#
# Fails closed: every unexpected result exits non-zero, so the container does not start on
# a half-migrated or unverified schema. Nothing on the default path drops data.
set -e

# Startup always uses the repository schema: a dev/CI-only schema override must never
# reach a startup `db push`/`migrate`. (Set again below, deliberately, for the baseline only.)
unset PRISMA_SCHEMA_OVERRIDE

PRISMA_CMD="${PRISMA_CMD:-prisma}"
CONFIG="prisma/startup.config.mjs"
BASELINE_MIGRATION="00000000000000_init"
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

ensure_pg_trgm
node scripts/prepare-prisma-schema.mjs

STATE="$(node scripts/db-state.mjs)" || fail "Could not inspect the database (DATABASE_URL / DATABASE_PROVIDER?)."
log "🔎 Database state: $STATE"

if [ "$STATE" = "legacy" ]; then
  # Adopt a database created by the old `db push` startup. Without a shadow database the
  # only schemas we can compare against are the frozen baseline and the current schema:
  #   a) DB == current schema           -> mark every migration as applied (0 pending)
  #   b) DB == baseline                 -> mark the baseline applied; deploy runs the rest
  #   c) DB = baseline minus additive   -> db push the baseline (no data loss), then b)
  #   d) DB between baseline and current (newer additive objects already pushed), the gap
  #      to the current schema is additive and every post-baseline migration is plain
  #      additive SQL (so pushing == running them) -> db push current schema, then a)
  #   anything else (destructive in every direction) -> stop, nothing changed.
  log "🧭 Legacy database (created by db push, no migration history): adopting the migration history."
  node scripts/prepare-prisma-schema.mjs --source prisma/baseline.schema.prisma --target prisma/baseline.generated.prisma
  BASELINE_SCHEMA="$(pwd)/prisma/baseline.generated.prisma"
  CURRENT_SCHEMA="$(pwd)/prisma/schema.generated.prisma"
  if is_postgres; then MIGRATIONS_DIR="prisma/migrations/postgresql"; else MIGRATIONS_DIR="prisma/migrations/sqlite"; fi
  MIGRATIONS="$(for d in "$MIGRATIONS_DIR"/*/; do [ -f "$d/migration.sql" ] && basename "$d"; done)"
  [ -n "$MIGRATIONS" ] || fail "No migrations found in $MIGRATIONS_DIR."
  MIGRATION_COUNT="$(echo "$MIGRATIONS" | wc -l | tr -d ' ')"

  schema_diff() { target="$1"; shift; $PRISMA_CMD migrate diff --config "$CONFIG" --from-config-datasource --to-schema "$target" "$@"; }
  # Sets DIFF_RC (0 same, 2 different, other = error) and DIFF_OUT.
  check_diff() { DIFF_RC=0; DIFF_OUT="$(schema_diff "$1" --exit-code 2>&1)" || DIFF_RC=$?; }
  # True if the SQL that brings the database to schema $1 is additive only (sets DIFF_SQL).
  additive_to() { DIFF_SQL="$(schema_diff "$1" --script)" && echo "$DIFF_SQL" | node scripts/db-state.mjs assert-additive >/dev/null 2>&1; }
  # db push schema $1 (never --accept-data-loss), then require an empty diff.
  push_to() {
    PRISMA_SCHEMA_OVERRIDE="$1" $PRISMA_CMD db push --config "$CONFIG" \
      || fail "db push to the $2 schema failed (Prisma refused data loss or the change could not be applied). Nothing was marked as migrated. See docs/database.md."
    check_diff "$1"
    if [ "$DIFF_RC" != 0 ]; then
      echo "$DIFF_OUT"
      fail "The database still differs from the $2 schema after db push. Nothing was marked as migrated. Fix the difference above (or start with FEEDFERRET_DB_SYNC=push) and restart."
    fi
  }
  resolve_applied() {
    $PRISMA_CMD migrate resolve --config "$CONFIG" --applied "$1" || fail "migrate resolve --applied $1 failed."
  }
  ADOPT=""

  check_diff "$CURRENT_SCHEMA"
  case "$DIFF_RC" in
    0) ADOPT=all ;;
    2) ;;
    *) echo "$DIFF_OUT"; fail "Comparing the database with the current schema failed (exit $DIFF_RC)." ;;
  esac

  if [ -z "$ADOPT" ]; then
    check_diff "$BASELINE_SCHEMA"
    case "$DIFF_RC" in
      0) ADOPT=baseline ;;
      2)
        log "⚠️ The database differs from the baseline schema:"
        echo "$DIFF_OUT"
        if additive_to "$BASELINE_SCHEMA"; then
          log "➕ Additive gap to the baseline only: applying it with db push (no --accept-data-loss)."
          push_to "$BASELINE_SCHEMA" baseline
          ADOPT=baseline
        elif [ "$MIGRATION_COUNT" -gt 1 ] && additive_to "$CURRENT_SCHEMA" \
            && node scripts/db-state.mjs assert-migrations-additive "$MIGRATIONS_DIR"; then
          log "➕ Database is ahead of the baseline (newer objects already pushed); the gap to the current schema is additive and all newer migrations are additive: applying it with db push (no --accept-data-loss)."
          push_to "$CURRENT_SCHEMA" current
          ADOPT=all
        else
          echo "$DIFF_SQL"
          fail "Adopting this database needs destructive changes (see SQL above). Nothing was changed.
   To proceed: take a backup, start once with FEEDFERRET_DB_SYNC=push (refuses data loss; use
   push-unsafe only if you accept the listed losses), then unset FEEDFERRET_DB_SYNC and restart.
   See docs/database.md (\"Migrations at startup\")."
        fi
        ;;
      *) echo "$DIFF_OUT"; fail "Comparing the database with the baseline schema failed (exit $DIFF_RC)." ;;
    esac
  fi

  if [ "$ADOPT" = all ]; then
    log "✅ Legacy database matches the current schema: marking all $MIGRATION_COUNT migration(s) as applied."
    for name in $MIGRATIONS; do resolve_applied "$name"; done
  else
    log "✅ Legacy database matches the baseline."
    resolve_applied "$BASELINE_MIGRATION"
    log "✅ Baseline $BASELINE_MIGRATION marked as applied."
  fi
fi

log "🔄 Applying migrations (prisma migrate deploy)..."
$PRISMA_CMD migrate deploy --config "$CONFIG" \
  || fail "prisma migrate deploy failed. The database was NOT started. Check the error above; for a failed migration see docs/database.md (\"Recovering from a failed migration\")."

# Log-only drift check: the database should now match the current schema exactly.
if [ "${FEEDFERRET_DB_DRIFT_CHECK:-1}" != 0 ]; then
  rc=0
  out="$($PRISMA_CMD migrate diff --config "$CONFIG" --from-config-datasource --to-schema "$(pwd)/prisma/schema.generated.prisma" --exit-code 2>&1)" || rc=$?
  case "$rc" in
    0) log "✅ Database schema matches prisma/schema.prisma." ;;
    2) log "⚠️ Schema drift: the database differs from prisma/schema.prisma (not changed automatically):"; echo "$out" ;;
    *) log "⚠️ Drift check could not run (exit $rc); continuing."; echo "$out" | tail -n 5 ;;
  esac
fi
