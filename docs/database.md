# Database providers, Postgres, backup, and restore

FeedFerret defaults to PostgreSQL. The bundled Docker Compose stack starts a Postgres 16 service automatically. SQLite is available as a lightweight alternative for local dev or single-user setups.

## Provider selection

Supported values:

- `postgresql` / `postgres` — **default**, uses PostgreSQL URLs, e.g. `postgresql://feedferret:secret@postgres:5432/feedferret?schema=public`
- `sqlite` — uses file-based `DATABASE_URL`, e.g. `file:/app/data/dev.db`

The source schema remains `prisma/schema.prisma`. `scripts/prepare-prisma-schema.mjs` writes an ignored `prisma/schema.generated.prisma` with the selected provider.

Useful scripts:

```bash
# Generate Prisma client for current provider
DATABASE_PROVIDER=sqlite pnpm run prisma:generate
DATABASE_PROVIDER=postgresql DATABASE_URL="postgresql://..." pnpm run prisma:generate

# Push schema to current database
DATABASE_PROVIDER=postgresql DATABASE_URL="postgresql://..." pnpm run prisma:push

# Build with selected provider
DATABASE_PROVIDER=postgresql DATABASE_URL="postgresql://..." pnpm run build
```

## Docker Compose: PostgreSQL (default)

Postgres starts automatically — no extra profile flags required:

```bash
cp .env.example .env
# Edit .env: set NEXTAUTH_SECRET, NEXTAUTH_URL, and POSTGRES_PASSWORD
docker compose up -d --build
```

FeedFerret waits for Postgres to pass its healthcheck before starting. Data lives in the `feedferret_postgres_data` volume. The service exposes `${POSTGRES_PORT:-5432}` on the host for local maintenance; restrict that port at the firewall for public servers.

## Docker Compose: SQLite (alternative)

Override provider and URL in `.env`, then start without Postgres:

```bash
DATABASE_PROVIDER=sqlite
DATABASE_URL=file:/app/data/dev.db
```

```bash
docker compose up feedferret -d --build
```

SQLite data lives in a bind-mount or volume at `/app/data`.

## Migration workflow

For now, the cross-provider workflow uses Prisma `db push` against the provider-specific generated schema. This is the same path the production container executes on startup:

```bash
DATABASE_PROVIDER=postgresql DATABASE_URL="postgresql://..." pnpm run prisma:push
```

Before switching an existing instance from SQLite to Postgres:

1. Stop FeedFerret.
2. Back up SQLite.
3. Start Postgres.
4. Run the schema push against Postgres.
5. Export/import application data through FeedFerret JSON/OPML export where applicable, or migrate records with a dedicated Prisma/data migration script.
6. Rebuild/restart with `DATABASE_PROVIDER=postgresql`.

## Backup and restore

### SQLite backup

```bash
# Backup from Docker volume to host file
mkdir -p backups
docker compose exec feedferret sh -lc 'cp /app/data/dev.db /tmp/feedferret-dev.db'
docker cp feedferret:/tmp/feedferret-dev.db backups/feedferret-$(date +%F).db

# Restore
cat backups/feedferret-YYYY-MM-DD.db | docker compose exec -T feedferret sh -lc 'cat > /app/data/dev.db'
docker compose restart feedferret
```

### PostgreSQL backup

```bash
# Backup
docker compose --profile postgres exec -T postgres pg_dump \
  -U "${POSTGRES_USER:-feedferret}" \
  -d "${POSTGRES_DB:-feedferret}" \
  > backups/feedferret-postgres-$(date +%F).sql

# Restore into an empty database
cat backups/feedferret-postgres-YYYY-MM-DD.sql | docker compose --profile postgres exec -T postgres psql \
  -U "${POSTGRES_USER:-feedferret}" \
  -d "${POSTGRES_DB:-feedferret}"
```

For large production instances, prefer scheduled `pg_dump`/managed-provider snapshots and test restores regularly.
