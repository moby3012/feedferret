#!/bin/sh

# Fail on any error
set -e

echo "🚀 Starting FeedFerret deployment script..."

# Create the data directory and ensure it exists
mkdir -p /app/data

export DATABASE_PROVIDER="${DATABASE_PROVIDER:-sqlite}"
export DATABASE_URL="${DATABASE_URL:-file:/app/data/dev.db}"

# Use the globally installed prisma if available, otherwise fallback to npx
PRISMA_CMD="prisma"
if ! command -v prisma >/dev/null 2>&1; then
    echo "⚠️ Global prisma not found, using npx..."
    PRISMA_CMD="npx prisma"
fi

echo "📂 Current database provider: $DATABASE_PROVIDER"
echo "📂 Current database URL: $DATABASE_URL"
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
