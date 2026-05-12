# Database providers, Postgres, backup, and restore

FeedFerret defaults to SQLite for simple self-hosting, but the Prisma schema can be generated for PostgreSQL by setting `DATABASE_PROVIDER=postgresql` before `prisma generate`, `prisma db push`, or `next build`.

## Provider selection

Supported values:

- `sqlite` — default, uses file-based `DATABASE_URL`, e.g. `file:/app/data/dev.db`
- `postgresql` / `postgres` — uses PostgreSQL URLs, e.g. `postgresql://feedferret:secret@postgres:5432/feedferret?schema=public`

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

## Docker Compose: SQLite

SQLite is the default profile:

```bash
cp .env.example .env
# Set NEXTAUTH_SECRET / AUTH_SECRET and NEXTAUTH_URL
DATABASE_PROVIDER=sqlite \
DATABASE_URL=file:/app/data/dev.db \
docker compose up -d --build
```

SQLite data lives in the `feedferret_db_data` volume.

## Docker Compose: PostgreSQL

Start the bundled Postgres service with the `postgres` profile and point FeedFerret at it:

```bash
cat >> .env <<'EOF'
DATABASE_PROVIDER=postgresql
DATABASE_URL=postgresql://feedferret:feedferret-change-me@postgres:5432/feedferret?schema=public
POSTGRES_DB=feedferret
POSTGRES_USER=feedferret
POSTGRES_PASSWORD=feedferret-change-me
EOF

docker compose --profile postgres up -d --build
```

Postgres data lives in the `feedferret_postgres_data` volume. The service exposes `${POSTGRES_PORT:-5432}` on the host for local maintenance and migration tests; restrict that port at the firewall for public servers.

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
