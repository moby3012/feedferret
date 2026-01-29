# Production Dockerfile
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat openssl

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app

# Install package manager
COPY package.json pnpm-lock.yaml* ./
RUN npm install -g pnpm && pnpm i

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
ENV NEXT_TELEMETRY_DISABLED 1

# Add build arguments for Next.js build time
ARG DATABASE_URL
ARG AUTH_SECRET
ARG NEXTAUTH_URL
ARG AUTH_TRUST_HOST

# Make them available as environment variables
ENV DATABASE_URL=$DATABASE_URL
ENV AUTH_SECRET=$AUTH_SECRET
ENV NEXTAUTH_URL=$NEXTAUTH_URL
ENV AUTH_TRUST_HOST=$AUTH_TRUST_HOST

RUN npm install -g pnpm && pnpm run build

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV production
ENV DATABASE_URL=file:/app/data/dev.db
ENV NEXT_TELEMETRY_DISABLED 1

RUN addgroup -S -g 1001 nodejs
RUN adduser -S -u 1001 -G nodejs nextjs

# Create data directory for SQLite and ensure proper permissions
RUN mkdir -p /app/data && touch /app/data/dev.db && chown -R nextjs:nodejs /app/data

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# Copy Prisma schema and startup script
COPY --chown=nextjs:nodejs prisma ./prisma
COPY --chown=nextjs:nodejs start.sh ./start.sh
RUN chmod +x ./start.sh

# Install prisma globally in the runner so we can run migrations
RUN npm install -g prisma@5.22.0

# Final check of permissions for the root directory and data folder
RUN chown -R nextjs:nodejs /app && chmod -R 770 /app/data

USER nextjs

EXPOSE 3000

ENV PORT 3000

# server.js is created by next build from the standalone output
# server.js is created by next build from the standalone output
CMD ["./start.sh"]
