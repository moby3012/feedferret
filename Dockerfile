# Production Dockerfile
# ── base-runtime ─────────────────────────────────────────────────────────────
# Minimal runtime dependencies only — no build tools.
FROM node:22.23.4-slim AS base-runtime
RUN apt-get update && apt-get install -y openssl ca-certificates curl && rm -rf /var/lib/apt/lists/*

# ── base-build ────────────────────────────────────────────────────────────────
# Adds native build tools needed for packages that compile C extensions.
FROM base-runtime AS base-build
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@9.14.2
ENV CI=true

# ── deps ──────────────────────────────────────────────────────────────────────
FROM base-build AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ── builder ───────────────────────────────────────────────────────────────────
FROM base-build AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1

ARG DATABASE_URL=postgresql://feedferret:feedferret-change-me@postgres:5432/feedferret?schema=public
ARG DATABASE_PROVIDER=postgresql

ENV DATABASE_URL=$DATABASE_URL
ENV DATABASE_PROVIDER=$DATABASE_PROVIDER

# AUTH_SECRET/AUTH_URL/AUTH_TRUST_HOST are runtime-only (see docker-compose.yaml
# 'environment:') and deliberately NOT build args: auth.ts falls back to a
# placeholder secret during `next build`, and baking real secrets into build
# ARGs/ENVs would persist them in the image's layer history.
RUN pnpm run build

# ── runner ────────────────────────────────────────────────────────────────────
FROM base-runtime AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV DATABASE_URL=postgresql://feedferret:feedferret-change-me@postgres:5432/feedferret?schema=public
ENV DATABASE_PROVIDER=postgresql
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm install -g pnpm@9.14.2

RUN groupadd --system --gid 1001 nodejs
RUN useradd --system --uid 1001 -g nodejs nextjs

# Create data directory for SQLite and ensure proper permissions
RUN mkdir -p /app/data && touch /app/data/dev.db && chown -R nextjs:nodejs /app/data

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# Defense in depth: Next's standalone file tracing can pick up prisma.config.ts from the
# project root when some server code does a dynamic fs access (see lib/ai/fake.ts and
# scripts/docker-smoke.sh, which fails CI if this file or any source tree ships).
# The globally installed Prisma CLI would then auto-load it at startup and fail to
# resolve "prisma/config" (not in the standalone node_modules), so `db push` in
# start.sh aborts and the container never starts. The runner must not contain this file.
RUN rm -f ./prisma.config.ts ./prisma.config.js ./prisma.config.mjs
# Copy Prisma schema and startup scripts.
# The CLI config used at startup is prisma/startup.config.mjs (+ prisma/cli-config.mjs):
# a plain object without any `prisma/config` import, so the global CLI can load it here.
# It marks the SQLite FTS tables as external so `db push` leaves them alone.
COPY --chown=nextjs:nodejs prisma ./prisma
COPY --chown=nextjs:nodejs scripts/prepare-prisma-schema.mjs ./scripts/prepare-prisma-schema.mjs
# Startup schema: scripts/db-migrate.sh (migrate deploy, default) + db-sync.sh (db push fallback).
COPY --chown=nextjs:nodejs scripts/db-common.sh ./scripts/db-common.sh
COPY --chown=nextjs:nodejs scripts/db-migrate.sh ./scripts/db-migrate.sh
COPY --chown=nextjs:nodejs scripts/db-sync.sh ./scripts/db-sync.sh
COPY --chown=nextjs:nodejs scripts/db-state.mjs ./scripts/db-state.mjs
COPY --chown=nextjs:nodejs scripts/migration-utils.mjs ./scripts/migration-utils.mjs
COPY --chown=nextjs:nodejs start.sh ./start.sh
# Stored-secret status CLI (M8): `node scripts/secrets-cli.mjs status`. Plain ESM, read-only.
COPY --chown=nextjs:nodejs scripts/secrets-cli.mjs ./scripts/secrets-cli.mjs
COPY --chown=nextjs:nodejs lib/secret-box-core.mjs ./lib/secret-box-core.mjs
RUN chmod +x ./start.sh

RUN npm install -g prisma@7.8.0

RUN chown -R nextjs:nodejs /app && chmod -R 770 /app/data

USER nextjs

EXPOSE 3000
ENV PORT=3000

CMD ["./start.sh"]
