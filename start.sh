#!/bin/sh

# Fail on any error
set -e

echo "🚀 Starting FeedFerret deployment script..."

# Create the data directory and ensure it exists
mkdir -p /app/data

export DATABASE_PROVIDER="${DATABASE_PROVIDER:-postgresql}"
export DATABASE_URL="${DATABASE_URL:-postgresql://feedferret:feedferret-change-me@postgres:5432/feedferret?schema=public}"

# Use the globally installed prisma if available, otherwise fallback to npx
PRISMA_CMD="prisma"
if ! command -v prisma >/dev/null 2>&1; then
    echo "⚠️ Global prisma not found, using npx..."
    PRISMA_CMD="npx prisma"
fi

echo "📂 Current database provider: $DATABASE_PROVIDER"
echo "📂 Current database URL: $DATABASE_URL"

# Wait for Postgres to be ready (no-op for SQLite)
if [ "$DATABASE_PROVIDER" = "postgresql" ] || [ "$DATABASE_PROVIDER" = "postgres" ]; then
    echo "⏳ Waiting for PostgreSQL to be ready..."
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
            echo "❌ PostgreSQL not reachable at ${DB_HOST}:${DB_PORT} after 30 attempts. Check DATABASE_URL and Postgres service."
            exit 1
        fi
        echo "   ... retrying in 2s (${RETRIES} attempts left)"
        sleep 2
    done
    echo "✅ PostgreSQL is ready."
fi

echo "🧬 Preparing Prisma schema..."
node scripts/prepare-prisma-schema.mjs
echo "🔄 Running database sync (db push)..."

# Sync schema with database
$PRISMA_CMD db push --schema prisma/schema.generated.prisma --accept-data-loss --skip-generate

echo "✅ Database is ready."
echo "🌟 Starting Next.js server..."

# server.js is the entry point for Next.js standalone mode
if [ -f "server.js" ]; then
    node server.js
else
    echo "❌ Error: server.js not found! Standalone build might have failed."
    exit 1
fi
