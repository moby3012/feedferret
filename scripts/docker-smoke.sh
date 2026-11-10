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
#    push -> server.js) against a throwaway Postgres (or SQLite) and require
#    GET /api/health == 200 within SMOKE_TIMEOUT seconds (default 90).
#
# The sqlite mode needs an image built with `--build-arg DATABASE_PROVIDER=sqlite`.
# Everything it creates (containers, network) is removed on exit.
set -euo pipefail

IMAGE="${1:?usage: $0 <image> [postgres|sqlite]}"
MODE="${2:-postgres}"
TIMEOUT="${SMOKE_TIMEOUT:-90}"
RUN_ID="ffsmoke-${MODE}-$$"
APP="${RUN_ID}-app"
DB="${RUN_ID}-db"
NET="${RUN_ID}-net"
failed=0

log() { echo "[smoke:${MODE}] $*"; }
fail() { echo "::error::[smoke:${MODE}] $*" >&2; failed=1; }

cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ] || [ "$failed" -ne 0 ]; then
    echo "::group::[smoke:${MODE}] container logs (failure)"
    docker ps -a --filter "name=${RUN_ID}" || true
    docker logs "$APP" 2>&1 | tail -n 200 || true
    if [ "$MODE" = "postgres" ]; then docker logs "$DB" 2>&1 | tail -n 40 || true; fi
    echo "::endgroup::"
  fi
  docker rm -f "$APP" "$DB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
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
  for d in tests e2e .e2e .pm graft .git .github .husky .claude playwright-report test-results perf-results; do
    [ -e "$d" ] && echo "./$d"
  done
  # un-bundled TypeScript sources (a traced "whole project" shows up as these)
  find . \( -path ./node_modules -o -path ./.next/node_modules \) -prune -o -type f \
      \( -name "*.ts" -o -name "*.tsx" \) ! -name "*.d.ts" -print | head -n 20
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
    env_args+=(-e DATABASE_PROVIDER=sqlite -e DATABASE_URL=file:/app/data/dev.db)
    ;;
  *) echo "unknown mode: $MODE" >&2; exit 2 ;;
esac

log "starting container"
docker run -d --name "$APP" --network "$NET" "${env_args[@]}" "$IMAGE" >/dev/null

deadline=$(( $(date +%s) + TIMEOUT ))
status=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  state=$(docker inspect -f '{{.State.Status}}' "$APP" 2>/dev/null || echo gone)
  if [ "$state" != "running" ]; then
    fail "container left 'running' state (state=$state, exit=$(docker inspect -f '{{.State.ExitCode}}' "$APP" 2>/dev/null || echo ?))"
    exit 1
  fi
  status=$(docker exec "$APP" curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health 2>/dev/null || true)
  if [ "$status" = "200" ]; then
    log "/api/health -> 200"
    break
  fi
  sleep 2
done
if [ "$status" != "200" ]; then
  fail "/api/health did not return 200 within ${TIMEOUT}s (last status: ${status:-none})"
  exit 1
fi

# A real page must render too (login redirect/render), not only the health route.
page=$(docker exec "$APP" curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/login || true)
case "$page" in
  200|307|308) log "/login -> $page" ;;
  *) fail "/login returned $page"; exit 1 ;;
esac

# Container must still be up (no crash right after the first request).
sleep 3
if [ "$(docker inspect -f '{{.State.Status}}' "$APP")" != "running" ]; then
  fail "container died after serving requests"
  exit 1
fi
log "OK"
