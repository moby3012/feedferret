#!/usr/bin/env bash
# Smoke test for the production Docker image.
#
#   scripts/docker-smoke.sh <image> [postgres|sqlite]
#
# 1. Static: the image must not contain files that break or leak at runtime
#    (prisma.config.*, .env*, test/e2e artefacts, source files, harness markers).
#    Regression guard for the 2026-11-09 outage, where Next's standalone
#    tracing pulled prisma.config.ts into the runner and the global Prisma CLI
#    crashed on it (`db push` failed -> restart loop).
# 2. Runtime: start the image exactly like production (start.sh -> prisma db
#    push -> server.js) against a throwaway Postgres (or a SQLite volume) and
#    require GET /api/health == 200 within SMOKE_TIMEOUT seconds (default 90).
# 3. Restart: stop it and start a NEW container on the SAME database (what every
#    redeploy does). It must become healthy again, `db push` must find nothing to
#    change, and the search indexes must survive untouched: SQLite article_fts +
#    shadow tables (the 2nd start used to fail -> restart loop), Postgres pg_trgm
#    GIN indexes (used to be dropped and rebuilt on every deploy).
#
# The sqlite mode needs an image built with `--build-arg DATABASE_PROVIDER=sqlite`.
# Everything it creates (containers, network) is removed on exit.
set -euo pipefail

IMAGE="${1:?usage: $0 <image> [postgres|sqlite]}"
MODE="${2:-postgres}"
TIMEOUT="${SMOKE_TIMEOUT:-90}"
RUN_ID="ffsmoke-${MODE}-$$"
APP1="${RUN_ID}-app1"
APP2="${RUN_ID}-app2"
APP="$APP1"
DB="${RUN_ID}-db"
NET="${RUN_ID}-net"
VOL="${RUN_ID}-data"
failed=0

log() { echo "[smoke:${MODE}] $*"; }
fail() { echo "::error::[smoke:${MODE}] $*" >&2; failed=1; }

cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ] || [ "$failed" -ne 0 ]; then
    echo "::group::[smoke:${MODE}] container logs (failure)"
    docker ps -a --filter "name=${RUN_ID}" || true
    for c in "$APP1" "$APP2"; do
      docker inspect "$c" >/dev/null 2>&1 || continue
      echo "--- $c"
      docker logs "$c" 2>&1 | tail -n 150 || true
    done
    if [ "$MODE" = "postgres" ]; then docker logs "$DB" 2>&1 | tail -n 40 || true; fi
    echo "::endgroup::"
  fi
  docker rm -f "$APP1" "$APP2" "$DB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT

# ── 1. static assertions ─────────────────────────────────────────────────────
log "static checks on $IMAGE"
# Run as root (never starts start.sh) so find can read everything under /app.
findings=$(docker run --rm --user 0 --entrypoint sh "$IMAGE" -c '
  cd /app
  # config / secrets / harness leftovers anywhere outside node_modules
  find . -path ./node_modules -prune -o -type f \( \
      -name "prisma.config.*" -o -name ".env" -o -name ".env.*" \
      -o -name "*.harness" -o -name "*.pem" -o -name "*.key" \
      -o -name "*.db-journal" -o -name "*.tsbuildinfo" \) -print
  # test / tooling / agent directories that must never ship
  for d in tests e2e .e2e .pm graft .git .github .husky .claude playwright-report test-results perf-results prisma/migrations-archive; do
    [ -e "$d" ] && echo "./$d"
  done
  # un-bundled TypeScript sources (a traced "whole project" shows up as these)
  find . \( -path ./node_modules -o -path ./.next/node_modules \) -prune -o -type f \
      \( -name "*.ts" -o -name "*.tsx" \) ! -name "*.d.ts" -print | head -n 20
  # startup migration files (scripts/db-migrate.sh) must ship
  for f in scripts/db-migrate.sh scripts/db-common.sh scripts/db-sync.sh scripts/db-state.mjs scripts/migration-utils.mjs \
      prisma/baseline.schema.prisma prisma/migrations/sqlite/migration_lock.toml prisma/migrations/postgresql/migration_lock.toml \
      prisma/migrations/sqlite/00000000000000_init/migration.sql prisma/migrations/postgresql/00000000000000_init/migration.sql; do
    [ -f "$f" ] || echo "missing: $f"
  done
  # SQLite databases: only the runtime data dir and the committed prisma/dev.db
  find . -path ./node_modules -prune -o -type f -name "*.db" ! -path ./data/dev.db ! -path ./prisma/dev.db -print
' | sort -u)
if [ -n "$findings" ]; then
  fail "image contains files that must not ship:"
  echo "$findings" | sed 's/^/    /' >&2
  exit 1
fi
log "static checks passed"

# ── 2. runtime smoke ─────────────────────────────────────────────────────────
docker network create "$NET" >/dev/null
AUTH_SECRET_VALUE=$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 48)
env_args=(
  -e "AUTH_SECRET=${AUTH_SECRET_VALUE}"
  -e "AUTH_URL=http://localhost:3000"
  -e "AUTH_TRUST_HOST=true"
)
run_args=()

case "$MODE" in
  postgres)
    PGPASS=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
    docker run -d --name "$DB" --network "$NET" --network-alias postgres \
      -e POSTGRES_USER=feedferret -e "POSTGRES_PASSWORD=${PGPASS}" -e POSTGRES_DB=feedferret \
      postgres:16-alpine >/dev/null
    env_args+=(
      -e DATABASE_PROVIDER=postgresql
      -e "DATABASE_URL=postgresql://feedferret:${PGPASS}@postgres:5432/feedferret?schema=public"
    )
    ;;
  sqlite)
    # Named volume like production: survives the container, initialised from the image's
    # /app/data (owned by the nextjs user).
    docker volume create "$VOL" >/dev/null
    run_args+=(-v "${VOL}:/app/data")
    env_args+=(-e DATABASE_PROVIDER=sqlite -e DATABASE_URL=file:/app/data/dev.db)
    ;;
  *) echo "unknown mode: $MODE" >&2; exit 2 ;;
esac

# Runs SQL against the app's database and prints the rows, one per line, fields joined by "|".
db_query() {
  local sql="$1"
  if [ "$MODE" = "postgres" ]; then
    docker exec "$DB" psql -U feedferret -d feedferret -tAc "$sql"
  else
    # No sqlite3 CLI in the image; better-sqlite3 ships in the standalone node_modules.
    docker exec "$APP" node -e '
      const Database = require("better-sqlite3");
      const db = new Database("/app/data/dev.db", { readonly: true, fileMustExist: true });
      for (const row of db.prepare(process.argv[1]).raw().all()) console.log(row.join("|"));
    ' "$sql"
  fi
}

# Start a container named $1 and wait until it serves /api/health and /login.
start_and_wait_healthy() {
  APP="$1"
  log "starting container $APP"
  docker run -d --name "$APP" --network "$NET" ${run_args[@]+"${run_args[@]}"} "${env_args[@]}" "$IMAGE" >/dev/null

  local deadline status="" state page
  deadline=$(( $(date +%s) + TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    state=$(docker inspect -f '{{.State.Status}}' "$APP" 2>/dev/null || echo gone)
    if [ "$state" != "running" ]; then
      fail "$APP left 'running' state (state=$state, exit=$(docker inspect -f '{{.State.ExitCode}}' "$APP" 2>/dev/null || echo ?))"
      exit 1
    fi
    status=$(docker exec "$APP" curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health 2>/dev/null || true)
    if [ "$status" = "200" ]; then
      log "$APP /api/health -> 200"
      break
    fi
    sleep 2
  done
  if [ "$status" != "200" ]; then
    fail "$APP /api/health did not return 200 within ${TIMEOUT}s (last status: ${status:-none})"
    exit 1
  fi

  # A real page must render too (login redirect/render), not only the health route.
  page=$(docker exec "$APP" curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/login || true)
  case "$page" in
    200|307|308) log "$APP /login -> $page" ;;
    *) fail "$APP /login returned $page"; exit 1 ;;
  esac

  # Container must still be up (no crash right after the first request).
  sleep 3
  if [ "$(docker inspect -f '{{.State.Status}}' "$APP")" != "running" ]; then
    fail "$APP died after serving requests"
    exit 1
  fi
}

# Identity of the search index objects: if they are dropped and recreated, this changes.
#   postgres: name + oid of each pg_trgm index;  sqlite: name + root page of each FTS table.
search_index_fingerprint() {
  if [ "$MODE" = "postgres" ]; then
    db_query "SELECT c.relname || ':' || c.oid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname LIKE 'Article_%_trgm_idx' ORDER BY 1"
  else
    db_query "SELECT name || ':' || rootpage FROM sqlite_master WHERE name LIKE 'article_fts%' AND type IN ('table', 'trigger') ORDER BY name"
  fi
}

# Wait until the app finished provisioning search (Postgres: 5 trigram indexes; SQLite:
# FTS table created and its background backfill marked complete).
wait_for_search_indexes() {
  local deadline n
  deadline=$(( $(date +%s) + 60 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ "$MODE" = "postgres" ]; then
      n=$(db_query "SELECT count(*) FROM pg_indexes WHERE indexname LIKE 'Article_%_trgm_idx'" 2>/dev/null || echo 0)
      [ "$n" = "5" ] && return 0
    else
      n=$(db_query "SELECT count(*) FROM article_fts_meta WHERE backfilled_at IS NOT NULL" 2>/dev/null || echo 0)
      [ "$n" = "1" ] && return 0
    fi
    sleep 2
  done
  fail "search indexes not provisioned within 60s (last: ${n:-?})"
  exit 1
}

# ── first start (fresh database) ─────────────────────────────────────────────
start_and_wait_healthy "$APP1"
app1_logs=$(docker logs "$APP1" 2>&1 || true)
if ! grep -q "Database state: empty" <<<"$app1_logs" || ! grep -q "Database schema matches prisma/schema.prisma" <<<"$app1_logs"; then
  fail "1st start: expected migrate deploy on an empty database without drift"
  sed -n '/Updating database schema/,/Database is ready/p' <<<"$app1_logs" >&2
  exit 1
fi
log "1st start: migrate deploy created the schema"
wait_for_search_indexes
before=$(search_index_fingerprint)
log "search indexes after 1st start:"
echo "$before" | sed 's/^/    /'
[ -n "$before" ] || { fail "no search index objects found after the first start"; exit 1; }

# ── second start (same database, new container — a redeploy) ─────────────────
docker stop -t 20 "$APP1" >/dev/null
start_and_wait_healthy "$APP2"
# Capture first: with pipefail, `docker logs | grep -q` can fail when grep exits
# early and docker logs gets SIGPIPE (a false "schema changed" failure).
app2_logs=$(docker logs "$APP2" 2>&1 || true)
if ! grep -q "Database state: migrated" <<<"$app2_logs" || ! grep -q "No pending migrations to apply" <<<"$app2_logs"; then
  fail "2nd start: expected 'Database state: migrated' + 'No pending migrations to apply' (prisma migrate deploy)"
  sed -n '/Updating database schema/,/Database is ready/p' <<<"$app2_logs" >&2
  exit 1
fi
if grep -qiE "db push|Legacy database" <<<"$app2_logs"; then
  fail "2nd start: the migrate startup must not run db push"
  sed -n '/Updating database schema/,/Database is ready/p' <<<"$app2_logs" >&2
  exit 1
fi
if grep -q "Schema drift" <<<"$app2_logs"; then
  fail "2nd start: database drifted from prisma/schema.prisma"
  sed -n '/Updating database schema/,/Database is ready/p' <<<"$app2_logs" >&2
  exit 1
fi
log "2nd start: migrate deploy found no pending migrations, no db push, no drift"
wait_for_search_indexes
after=$(search_index_fingerprint)
if [ "$before" != "$after" ]; then
  fail "search index objects changed across restarts (dropped/recreated):"
  diff <(echo "$before") <(echo "$after") >&2 || true
  exit 1
fi
log "search indexes survived the restart unchanged"

# Stored-secret status CLI (M8) must run inside the image against the live DB.
if ! docker exec "$APP2" node scripts/secrets-cli.mjs status >/dev/null; then
  fail "secrets-cli status failed inside the image"
  docker exec "$APP2" node scripts/secrets-cli.mjs status >&2 || true
  exit 1
fi
log "secrets-cli status runs inside the image"
log "OK"
