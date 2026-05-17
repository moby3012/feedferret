# Production Dockerfile
# ── base-runtime ─────────────────────────────────────────────────────────────
# Minimal runtime dependencies only — no build tools.
FROM node:22-slim AS base-runtime
RUN apt-get update && apt-get install -y openssl ca-certificates curl && rm -rf /var/lib/apt/lists/*

# ── base-build ────────────────────────────────────────────────────────────────
# Adds native build tools needed for packages that compile C extensions.
FROM base-runtime AS base-build
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.0.8
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
ARG AUTH_SECRET
ARG AUTH_URL
ARG AUTH_TRUST_HOST

ENV DATABASE_URL=$DATABASE_URL
ENV DATABASE_PROVIDER=$DATABASE_PROVIDER
ENV AUTH_SECRET=$AUTH_SECRET
ENV AUTH_URL=$AUTH_URL
ENV AUTH_TRUST_HOST=$AUTH_TRUST_HOST

RUN pnpm run build

# ── runner ────────────────────────────────────────────────────────────────────
FROM base-runtime AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV DATABASE_URL=postgresql://feedferret:feedferret-change-me@postgres:5432/feedferret?schema=public
ENV DATABASE_PROVIDER=postgresql
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm install -g pnpm@11.0.8

RUN groupadd --system --gid 1001 nodejs
RUN useradd --system --uid 1001 -g nodejs nextjs

# Create data directory for SQLite and ensure proper permissions
RUN mkdir -p /app/data && touch /app/data/dev.db && chown -R nextjs:nodejs /app/data

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# Copy Prisma schema and startup script
COPY --chown=nextjs:nodejs prisma ./prisma
COPY --chown=nextjs:nodejs scripts/prepare-prisma-schema.mjs ./scripts/prepare-prisma-schema.mjs
COPY --chown=nextjs:nodejs start.sh ./start.sh
RUN chmod +x ./start.sh

RUN npm install -g prisma@5.22.0

RUN chown -R nextjs:nodejs /app && chmod -R 770 /app/data

USER nextjs

EXPOSE 3000
ENV PORT=3000

CMD ["./start.sh"]
