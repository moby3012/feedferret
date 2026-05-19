#!/bin/sh

# Fail on any error
set -e

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "🚀 Starting FeedFerret deployment script..."

# Create the data directory and ensure it exists
mkdir -p /app/data

export DATABASE_PROVIDER="${DATABASE_PROVIDER:-postgresql}"
export DATABASE_URL="${DATABASE_URL:-postgresql://feedferret:feedferret-change-me@postgres:5432/feedferret?schema=public}"

# Use the globally installed prisma if available, otherwise fallback to npx
PRISMA_CMD="prisma"
if ! command -v prisma >/dev/null 2>&1; then
    log "⚠️ Global prisma not found, using npx..."
    PRISMA_CMD="npx prisma"
fi

log "📂 Current database provider: $DATABASE_PROVIDER"
if [ "$DATABASE_PROVIDER" = "postgresql" ] || [ "$DATABASE_PROVIDER" = "postgres" ]; then
    DB_HOST_FOR_LOG=$(echo "$DATABASE_URL" | sed 's|.*@\([^:/]*\).*|\1|')
    DB_NAME_FOR_LOG=$(echo "$DATABASE_URL" | sed 's|.*/\([^?]*\).*|\1|')
    log "📂 Current database target: ${DB_HOST_FOR_LOG}/${DB_NAME_FOR_LOG}"
else
    log "📂 Current database target: sqlite"
fi

# Wait for Postgres to be ready (no-op for SQLite)
if [ "$DATABASE_PROVIDER" = "postgresql" ] || [ "$DATABASE_PROVIDER" = "postgres" ]; then
    log "⏳ Waiting for PostgreSQL to be ready..."
    DB_HOST=$(echo "$DATABASE_URL" | sed 's|.*@\([^:/]*\).*|\1|')
    DB_PORT=$(echo "$DATABASE_URL" | sed 's|.*:\([0-9][0-9]*\)/.*|\1|')
    DB_PORT="${DB_PORT:-5432}"
    RETRIES=30
    until node -e "
const net = require('net');
const s = net.createConnection($DB_PORT, '$DB_HOST');
s.on('connect', () => { s.destroy(); process.exit(0); });
s.on('error', () => { s.destroy(); process.exit(1); });
" 2>/dev/null; do
        RETRIES=$((RETRIES - 1))
        if [ "$RETRIES" -le 0 ]; then
            log "❌ PostgreSQL not reachable at ${DB_HOST}:${DB_PORT} after 30 attempts. Check DATABASE_URL and Postgres service."
            exit 1
        fi
        log "   ... retrying in 2s (${RETRIES} attempts left)"
        sleep 2
    done
    log "✅ PostgreSQL is ready."
fi

log "🧬 Preparing Prisma schema..."
node scripts/prepare-prisma-schema.mjs
log "🔄 Running database sync (db push)..."

# Sync schema with database
# Pass --url explicitly so the CLI does not need prisma.config.ts in the runner
$PRISMA_CMD db push --schema prisma/schema.generated.prisma --url "$DATABASE_URL" --accept-data-loss --skip-generate

log "✅ Database is ready."
log "🌟 Starting Next.js server..."

# Bind to all interfaces so the Docker healthcheck (curl localhost:3000) works.
# Docker sets HOSTNAME to the container ID by default; Next.js standalone picks
# that up and would otherwise bind only to the container's IP, not 127.0.0.1.
export HOSTNAME="0.0.0.0"

# server.js is the entry point for Next.js standalone mode
if [ -f "server.js" ]; then
    node server.js
else
    log "❌ Error: server.js not found! Standalone build might have failed."
    exit 1
fi
