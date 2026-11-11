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
All Prisma commands (`generate`, `migrate`, `db push`) use the generated schema.

Supported `DATABASE_PROVIDER` values: `postgresql`, `postgres`, `sqlite`, `file`.

---

## Migrations at startup

Every start (`start.sh` in the Docker image, `pnpm start`) runs
`scripts/db-migrate.sh`. `FEEDFERRET_DB_SYNC` selects what it does:

| `FEEDFERRET_DB_SYNC` | Behaviour |
|---|---|
| `migrate` (default, unset) | `prisma migrate deploy` with `prisma/migrations/<provider>`. Adopts an older `db push` database once (see below). |
| `push` | Fallback/rollback: `prisma db push` **without** `--accept-data-loss` (`scripts/db-sync.sh`). Prisma refuses changes that would lose data. |
| `push-unsafe` | Pre-migrations behaviour: `db push --accept-data-loss`. Logged as a WARNING. One-off use only, after a verified backup. |
| `skip` | Do not touch the schema (for example when migrations run as a separate job). |

The script fails closed. If anything unexpected happens, it exits non-zero and the
container does not start, so the app never runs on a half-migrated or unverified schema.
Nothing on the default path drops data. Set `FEEDFERRET_DB_DRIFT_CHECK=0` to skip
the log-only drift check that runs after `migrate deploy` and takes about a second.

`scripts/db-state.mjs` classifies the database:

- **empty**: `migrate deploy` creates everything from `00000000000000_init`.
- **migrated** (`_prisma_migrations` exists): `migrate deploy` applies pending migrations.
- **legacy** (`User` exists, no migration history): the database was created by the old
  `db push` startup. Without a shadow database, there are two schemas it can be compared
  with: the current schema and the frozen baseline (`prisma/baseline.schema.prisma`). Both
  are prepared for the provider and for `PRISMA_PG_TRGM`. The checks run in this order:
  1. It matches the **current** schema: every migration is marked as applied
     (`migrate resolve --applied`, oldest first), so nothing is pending. This also covers
     installs that are already *ahead* of the baseline, because a later schema was pushed.
  2. It matches the **baseline**: only `00000000000000_init` is marked as applied.
     `migrate deploy` then runs the newer migrations normally.
  3. It is behind the baseline, and the gap is only additive (for example, an old install
     that is missing newer nullable columns). The gap is applied with `db push` to the
     baseline, **without** `--accept-data-loss`. The database is compared again, then
     handled as in step 2.
  4. It is between the baseline and the current schema. The newer objects are already
     pushed, so reaching the baseline would mean dropping them. The baseline is never
     pushed in this case. If the gap to the *current* schema is additive, and every
     migration after the baseline is plain additive SQL with no `ff:allow-destructive`,
     the current schema is pushed (without `--accept-data-loss`). Running those additive
     migrations would give the same result. The database is compared again, then handled
     as in step 1.
  5. Anything else (destructive SQL in every direction: `DROP`, type changes, SQLite
     `RedefineTables`, …): the start stops and nothing is changed. Take a backup, start once
     with `FEEDFERRET_DB_SYNC=push`, then unset it. Use `push-unsafe` only if you accept the
     losses that Prisma lists. The next start adopts the database as in step 1.

  Then `migrate deploy` runs as usual.

On Postgres, `migrate deploy` takes an advisory lock, so parallel replicas are safe. The
`pg_trgm` handling is unchanged: the extension is created before migrating. If the
role is not allowed to create it, startup logs a warning, sets `PRISMA_PG_TRGM=0` and
continues without trigram indexes. `PRISMA_SCHEMA_OVERRIDE` (dev/CI only) is always
ignored by startup.

SQLite: relative `file:` URLs are resolved by the Prisma CLI against `prisma/` (the
config file directory), while the app resolves them against the working directory.
Use absolute paths, such as `file:/app/data/dev.db`, as the Docker image does.

### Production cut-over (first deploy with migrations)

1. Take a `pg_dump -Fc` backup and **test the restore** into a scratch database. Keep the dump.
2. Optional dry run in the running (old) container:
   `DATABASE_PROVIDER=postgresql node scripts/prepare-prisma-schema.mjs && prisma migrate diff --config prisma/startup.config.mjs --from-config-datasource --to-schema prisma/schema.generated.prisma`
   should print an empty diff. If it lists changes, look at them before deploying.
   If later migrations are merged before the cut-over, the log says `all N migration(s)`
   (the database already has their objects, from the old `db push`) or `matches the baseline`.
   In the second case, `migrate deploy` then applies the newer migrations.
3. Deploy with `FEEDFERRET_DB_SYNC` unset. Expected log:
   ```
   🔎 Database state: legacy
   🧭 Legacy database (created by db push, no migration history): adopting the migration history.
   ✅ Legacy database matches the current schema: marking all 1 migration(s) as applied.
   Migration 00000000000000_init marked as applied.
   🔄 Applying migrations (prisma migrate deploy)...
   No pending migrations to apply.
   ✅ Database schema matches prisma/schema.prisma.
   ```
4. Verify: `SELECT migration_name, finished_at FROM _prisma_migrations;` returns one row,
   `00000000000000_init`. From the second start on, the log shows `Database state: migrated`
   and `No pending migrations to apply`.

### Rollback

- Set `FEEDFERRET_DB_SYNC=push` and redeploy, or roll back the image. `db push` ignores
  `_prisma_migrations` (CI checks this), so switching back to `migrate` later works.
- An older image (pre-migrations) also starts fine. It runs `db push --accept-data-loss` and leaves
  `_prisma_migrations` alone. Only roll back across a schema migration if that migration
  was additive (see expand/contract).
- If data was lost: restore the backup from step 1.

### Recovering from a failed migration

`migrate deploy` stops at the failing migration and the container restarts in a loop,
logging `prisma migrate deploy failed`. A failed migration can be partially applied
(statements before the failing one may have run), so check before retrying.

1. Read the error in the log, and check `SELECT * FROM _prisma_migrations WHERE finished_at IS NULL;`.
2. Fix the cause. This can be data that violates a new constraint, or a missing privilege.
   Undo or finish any statements of the migration that already ran, by hand.
3. Mark it as rolled back so it runs again:
   `prisma migrate resolve --config prisma/startup.config.mjs --rolled-back <migration_name>`
   (in the container). If you completed its changes by hand, use `--applied <migration_name>` instead.
4. Restart. To get the app up while you investigate, start with `FEEDFERRET_DB_SYNC=skip`, but only
   if the running image works with the old schema.

## Schema changes (developer workflow)

`prisma/migrations/{sqlite,postgresql}` contain independent provider histories
with identical migration names and provider-specific lock files. The initial
`00000000000000_init` baseline was generated from the current schema (including
the Article user/feed/createdAt index). `prisma/baseline.schema.prisma` freezes
that source and is used for the legacy adoption above. The old, incomplete SQLite SQL is in `prisma/migrations-archive`,
unused by tooling and excluded from Docker images. **Never edit applied SQL, the
`00000000000000_init` baseline or `prisma/baseline.schema.prisma`** (checksums and
legacy adoption depend on them). To reproduce the baseline from its frozen source:
`node scripts/generate-migration-baseline.mjs` (review only).

**Expand/contract rule:** every migration must be safe for the image that is still
running while it deploys, and for a rollback to the previous image:

- *Expand* first: add nullable or defaulted columns, new tables and new indexes. Ship code that
  writes both old and new shapes.
- *Contract* in a later release, after no deployed code reads the old shape: drop the
  old column or table. This SQL needs `-- ff:allow-destructive <reason>` and review.
- Never rename in one step (add new + backfill + switch reads + drop old later).

To add a schema change for **both** providers:

1. Fetch `origin/main`, rebase your branch, then edit `prisma/schema.prisma`.
2. Run `pnpm db:migration:new descriptive_snake_case_name`. It diffs the fetched
   `origin/main` schema against your working schema, without a database, and
   writes the same UTC timestamp/name in both provider directories. Generate
   once per schema change; do not stack repeated diffs against the same base.
3. Review both SQL files. Keep no-op SQL in the other provider if a change is
   provider-specific. Destructive SQL (including SQLite `RedefineTables`) needs an
   explicit `-- ff:allow-destructive <reason>` line and review. This marker documents intent, not permission to drop prod data.
   SQLite `RedefineTables` drops the FTS triggers on `Article`. `ensureSqliteFts` recreates them on the next boot,
   which always directly follows the migration.
4. Run `pnpm db:migrations:check`, `node scripts/test-migrations.mjs sqlite`,
   and `MIGRATION_TEST_ADMIN_URL=postgresql://... node scripts/test-migrations.mjs postgresql`
   against a **throwaway Postgres 16 server**. The integration script creates
   and removes unique databases/roles; the admin needs CREATEDB/CREATEROLE.
   It verifies history-to-schema drift (a failure means run
   `pnpm db:migration:new`), apply-from-empty, restricted extension privileges,
   and the startup script (`db-migrate.sh`): legacy adoption with preserved rows and
   search objects, idempotent second start, the `push` fallback, and fail-closed
   destructive cases. CI runs both providers. After rebase, prepare and
   `pnpm exec prisma validate` for each `DATABASE_PROVIDER=sqlite` and `DATABASE_PROVIDER=postgresql`.
5. Commit both provider directories with the schema change; run normal checks
   and Docker smoke for both providers.

The shared CLI config selects the migration directory for `DATABASE_PROVIDER`;
`PRISMA_SCHEMA_OVERRIDE` may select another prepared schema (relative to the
config file), and `SHADOW_DATABASE_URL` configures a disposable shadow DB for CI.
Migration history paths stay relative to the selected config, independently
of the override. `prisma.config.ts` and `prisma/startup.config.mjs` both work.

Postgres migration SQL installs `pg_trgm` in a privilege/error-guarded DO block.
An existence guard also avoids requiring database CREATE when the `public`
schema already exists. All `gin_trgm_ops` indexes must be in a DO block that checks the extension is
installed; the generator wraps them and CI rejects unguarded occurrences.
Without extension privileges, tables still migrate and search uses its runtime
fallback.

SQLite FTS virtual/shadow/bookkeeping tables stay **external**, created by
`ensureSearchIndexes()`, and never belong in migration SQL. `migrate deploy`
does not diff/drop them, and `checkSqliteFtsAndRepair` repairs index consistency.

---

## Full-text search

Article search (`lib/search.ts`) supports structured operators (`author:`, `intitle:`, `is:unread`, `label:`, date ranges, `OR` groups) plus free-text terms. Free-text terms are accelerated with an index appropriate to the active provider. Setup is automatic and idempotent — it runs once at server startup (`instrumentation.ts` → `ensureSearchIndexes()` in `lib/search-indexes.ts`) and is safe to run on every restart. If it fails for any reason, it logs a warning and search keeps working unaccelerated — a broken index setup never blocks startup or feed sync.

**PostgreSQL:** `CREATE EXTENSION IF NOT EXISTS pg_trgm` plus GIN trigram indexes (`gin_trgm_ops`) on `Article.title`, `.content`, `.excerpt`, `.author` and `.entities`. The indexes are declared in `prisma/schema.prisma` as `//@postgresql @@index(...)` lines that `scripts/prepare-prisma-schema.mjs` enables only for Postgres, so schema diffs keep them; the Postgres migrations create them in a guarded block, and startup (`scripts/db-migrate.sh`) creates the extension first, and if that is not allowed it leaves the indexes out (`PRISMA_PG_TRGM=0`) and logs a warning. `ensureSearchIndexes()` still creates the same indexes idempotently as a fallback. This accelerates the existing `ILIKE '%term%'` queries with no change to query logic. Requires the connecting role to have privileges to create the extension (true for the default superuser role in the bundled Docker image; a restricted/managed Postgres role without `CREATE EXTENSION` rights will just log the startup warning and fall back to unaccelerated `ILIKE`).

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
