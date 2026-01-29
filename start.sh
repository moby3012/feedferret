#!/bin/sh

# Fail on any error
set -e

echo "Starting deployment script..."

# Create the data directory if it doesn't exist
mkdir -p /app/data

# Ensure permissions (just in case)
# Note: In some restricted environments chown might fail, so we might want to be careful, 
# but since we are running as the user defined in Dockerfile or root, it depends.
# The Dockerfile switches to 'nextjs' user. 

echo "Running database migrations..."
# We use db push for sqlite dev.db or migrate deploy if we had a real migration history and prod DB
# The user's package.json uses 'prisma db push' for start, so we replicate that.
npx prisma db push --accept-data-loss

echo "Starting Next.js server..."
node server.js
