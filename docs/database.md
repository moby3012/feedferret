# Database: PostgreSQL and SQLite

FeedFerret supports two database providers. The right choice depends on your use case:

| | **PostgreSQL** | **SQLite** |
|---|---|---|
| **Recommended for** | Production, multi-user, shared hosting | Personal use, local dev, minimal infra |
| **How to set up** | Included in Docker Compose, zero config | Single file, no extra service |
| **Docker Compose** | `docker compose up -d --build` | `docker compose up feedferret -d --build` |
| **Backup** | `pg_dump` | Copy one `.db` file |
| **Scales to** | Multiple replicas, managed cloud DBs | Single container only |

---

## Environment variables

Both providers require two variables: `DATABASE_PROVIDER` and `DATABASE_URL`.

**PostgreSQL:**
```env
DATABASE_PROVIDER="postgresql"
DATABASE_URL="postgresql://feedferret:your-password@postgres:5432/feedferret?schema=public"
POSTGRES_DB="feedferret"
POSTGRES_USER="feedferret"
POSTGRES_PASSWORD="your-password"
```

**SQLite:**
```env
DATABASE_PROVIDER="sqlite"
DATABASE_URL="file:/app/data/dev.db"
```

> **Note for Coolify and other build platforms:** `DATABASE_PROVIDER` must be set as both a **runtime environment variable** and a **build argument**. Use `postgresql` for PostgreSQL deploys. The Prisma client is compiled at image build time and must match the runtime provider. If only set at runtime, the container will start but queries may fail silently.

For Coolify, prefer the repo's Docker Compose deployment type so `docker-compose.yaml` supplies matching build args and runtime environment. Also set `AUTH_URL=https://your-domain.example.com` and `AUTH_TRUST_HOST=true` so onboarding and NextAuth callbacks work behind Coolify's reverse proxy.

---

## Docker Compose: PostgreSQL (default)

Postgres starts automatically — no profile flags required:

```bash
cp .env.example .env
# Edit .env: set AUTH_SECRET, AUTH_URL, and POSTGRES_PASSWORD
docker compose up -d --build
```

FeedFerret waits for Postgres to pass its healthcheck before starting. Data lives in the `feedferret_postgres_data` Docker volume.

The Postgres service exposes port `5432` on the host for maintenance access. For public servers, remove or firewall that port — the app communicates with Postgres over the internal Docker network.

---

## Docker Compose: SQLite (alternative)

Override the provider in `.env` and start only the app container:

```env
DATABASE_PROVIDER="sqlite"
DATABASE_URL="file:/app/data/dev.db"
```

```bash
docker compose up feedferret -d --build
```

Data lives in the `feedferret_db_data` Docker volume. No Postgres container is started.

---

## How provider selection works

The source schema is always `prisma/schema.prisma` (provider = `sqlite` as a template).  
At build time and at container startup, `scripts/prepare-prisma-schema.mjs` reads `DATABASE_PROVIDER` and writes `prisma/schema.generated.prisma` with the correct provider.  
All Prisma commands (`generate`, `db push`) use the generated schema.

Supported `DATABASE_PROVIDER` values: `postgresql`, `postgres`, `sqlite`, `file`.

---

## Schema changes: `db push`, not `prisma/migrations`

Startup (`start.sh` in the Docker image, `pnpm run start` → `prisma:push`) runs
`scripts/db-sync.sh`, which prepares the provider schema and applies it with
`prisma db push --config prisma/startup.config.mjs --accept-data-loss`.
The config (`prisma/cli-config.mjs`) declares the SQLite FTS tables as external
tables, so `db push` never touches them; on Postgres the script creates the
`pg_trgm` extension first, because the trigram search indexes are part of the
Postgres schema variant (see [Full-text search](#full-text-search)).
`prisma/schema.prisma` is therefore the **source of truth** for both SQLite and
PostgreSQL, and every schema change must be **additive** (new nullable /
defaulted columns, new tables) so `db push` never needs to drop data.

The SQL files under `prisma/migrations/` are an **archival, SQLite-flavoured
change log** (what changed and when, handy for hand-written upgrades). They are
**not executed** at startup or in CI and are not used for PostgreSQL. When you
change `schema.prisma`, adding a matching migration file is nice for the
history, but the schema file is what actually reaches users' databases.

---

## Full-text search

Article search (`lib/search.ts`) supports structured operators (`author:`, `intitle:`, `is:unread`, `label:`, date ranges, `OR` groups) plus free-text terms. Free-text terms are accelerated with an index appropriate to the active provider. Setup is automatic and idempotent — it runs once at server startup (`instrumentation.ts` → `ensureSearchIndexes()` in `lib/search-indexes.ts`) and is safe to run on every restart. If it fails for any reason, it logs a warning and search keeps working unaccelerated — a broken index setup never blocks startup or feed sync.

**PostgreSQL:** `CREATE EXTENSION IF NOT EXISTS pg_trgm` plus GIN trigram indexes (`gin_trgm_ops`) on `Article.title`, `.content`, `.excerpt`, `.author` and `.entities`. The indexes are declared in `prisma/schema.prisma` as `//@postgresql @@index(...)` lines that `scripts/prepare-prisma-schema.mjs` enables only for Postgres, so `db push` keeps them across deploys (they used to be dropped and rebuilt on every start); `scripts/db-sync.sh` creates the extension before `db push`, and if that is not allowed it leaves the indexes out (`PRISMA_PG_TRGM=0`) and logs a warning. `ensureSearchIndexes()` still creates the same indexes idempotently as a fallback. This accelerates the existing `ILIKE '%term%'` queries with no change to query logic. Requires the connecting role to have privileges to create the extension (true for the default superuser role in the bundled Docker image; a restricted/managed Postgres role without `CREATE EXTENSION` rights will just log the startup warning and fall back to unaccelerated `ILIKE`).

**SQLite:** an FTS5 virtual table (`article_fts`) using the `trigram` tokenizer (requires SQLite ≥ 3.34, bundled with `better-sqlite3`), kept in sync via `AFTER INSERT/UPDATE/DELETE` triggers on `Article`, with a one-time backfill for pre-existing rows on first setup. The `trigram` tokenizer was specifically chosen because — unlike SQLite's default word-based tokenizers — it matches arbitrary substrings the same way `LIKE '%term%'` does, so switching a term over to the FTS index doesn't change what counts as a match. Two cases still use the original `LIKE`-based query directly, both simply falling back to (never returning less than) the pre-FTS behavior: terms shorter than 3 characters (the trigram tokenizer can't index anything shorter), and any runtime error against `article_fts` (e.g. before the first startup has provisioned it). `link` and feed/label names aren't part of the FTS index, so those always stay on the `LIKE` path and are OR'd together with the FTS match for title/content/excerpt/author.

The FTS objects (`article_fts`, its shadow tables `article_fts_data/_idx/_docsize/_config/_content`, and the bookkeeping tables `article_fts_meta`/`article_fts_backfill`) are not in the Prisma schema; they are listed as external tables in `prisma/cli-config.mjs` so `db push` leaves them alone. On every start, once the index is complete, a cheap background consistency check (indexed row count vs. `Article` row count, plus a probe `MATCH` on the newest article) runs after a short grace period; if it fails, the index is reset and rebuilt with the same chunked background backfill as on first setup, while search uses the `LIKE` path. The full FTS5 `integrity-check` is not run at boot: it is O(index) and synchronous (≈6 s for 50 k articles), which would stall the server's event loop and hold the write lock. Free-text queries are capped at 32 tokens / 1000 characters, which keeps every query below SQLite's bind-variable and expression limits.

---

## Switching providers

There is no automated data migration between providers. To switch:

1. Stop FeedFerret.
2. Export your data: OPML export (Settings → Import/Export) and/or JSON export for full data.
3. Start the new provider (update `.env`, rebuild).
4. Import via the OPML/JSON import flow.

For large instances with users and article history, a custom Prisma migration script is more practical than OPML re-import.

---

## Backup and restore

### PostgreSQL

```bash
# Backup
mkdir -p backups
docker compose exec -T postgres pg_dump \
  -U "${POSTGRES_USER:-feedferret}" \
  -d "${POSTGRES_DB:-feedferret}" \
  > backups/feedferret-postgres-$(date +%F).sql

# Restore into an empty database
cat backups/feedferret-postgres-YYYY-MM-DD.sql \
  | docker compose exec -T postgres psql \
      -U "${POSTGRES_USER:-feedferret}" \
      -d "${POSTGRES_DB:-feedferret}"
```

For production: prefer scheduled `pg_dump` via cron or a managed Postgres provider's snapshot feature. Test restores regularly.

### SQLite

```bash
# Backup
mkdir -p backups
docker compose exec feedferret sh -lc 'cp /app/data/dev.db /tmp/feedferret-backup.db'
docker cp feedferret:/tmp/feedferret-backup.db backups/feedferret-$(date +%F).db

# Restore
cat backups/feedferret-YYYY-MM-DD.db \
  | docker compose exec -T feedferret sh -lc 'cat > /app/data/dev.db'
docker compose restart feedferret
```

---

## Developer scripts

```bash
# Generate Prisma client for a specific provider
DATABASE_PROVIDER=sqlite pnpm run prisma:generate
DATABASE_PROVIDER=postgresql DATABASE_URL="postgresql://..." pnpm run prisma:generate

# Push schema to database (apply changes without migration files)
DATABASE_PROVIDER=postgresql DATABASE_URL="postgresql://..." pnpm run prisma:push

# Build image with a specific provider baked in
DATABASE_PROVIDER=postgresql DATABASE_URL="postgresql://..." pnpm run build
```
