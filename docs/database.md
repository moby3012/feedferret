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

> **Note for Coolify and other build platforms:** `DATABASE_PROVIDER` must be set as both a **runtime environment variable** and a **build argument**. The Prisma client is compiled at image build time and must match the runtime provider. If only set at runtime, the container will start but queries may fail silently.

---

## Docker Compose: PostgreSQL (default)

Postgres starts automatically — no profile flags required:

```bash
cp .env.example .env
# Edit .env: set NEXTAUTH_SECRET, NEXTAUTH_URL, and POSTGRES_PASSWORD
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
