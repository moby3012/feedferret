// Shared Prisma CLI configuration (db push / migrate diff / db execute).
//
// Deliberately a plain object with NO imports: the production runner image has no
// `prisma/config` package next to the app (the CLI is installed globally), so a config
// that imports `defineConfig` cannot be loaded there (see the 2026-11-09 outage, #238).
// The Prisma CLI accepts a plain default-exported object just as well.
//
// Used by:
//   - prisma/startup.config.mjs  (start.sh / scripts/db-sync.sh, runner image)
//   - prisma.config.ts           (local dev, `pnpm run prisma:*`)

/**
 * Tables that exist in the SQLite database but are created at runtime by
 * lib/search-indexes.ts, not by the Prisma schema: the FTS5 virtual table, the shadow
 * tables SQLite creates for it, and our two bookkeeping tables. Without this list
 * `prisma db push --accept-data-loss` tries to drop them on every start and fails on the
 * second boot (`no such table: article_fts_config`, because dropping the virtual table
 * already removed its shadow tables) -> container restart loop.
 *
 * Keep in sync with lib/search-indexes.ts (tests/lib/prisma-cli-config.test.ts checks it).
 */
export const SQLITE_EXTERNAL_TABLES = [
  "article_fts",
  "article_fts_data",
  "article_fts_idx",
  "article_fts_docsize",
  "article_fts_config",
  "article_fts_content",
  "article_fts_meta",
  "article_fts_backfill",
];

/** @param {string | undefined} provider */
export function isPostgresProvider(provider) {
  const p = (provider || "sqlite").toLowerCase();
  return p === "postgres" || p === "postgresql";
}

/**
 * @param {{ schema: string, env?: Record<string, string | undefined> }} options
 *   `schema` is resolved relative to the config file that returns this object.
 */
export function buildPrismaCliConfig({ schema, env = process.env }) {
  // Both entry-point configs resolve paths relative to themselves. Keep migrations
  // beside the default schema even when a baseline schema override is supplied.
  const schemaDir = schema.slice(0, schema.lastIndexOf("/") + 1);
  const provider = isPostgresProvider(env.DATABASE_PROVIDER) ? "postgresql" : "sqlite";
  const config = {
    schema: env.PRISMA_SCHEMA_OVERRIDE || schema,
    migrations: { path: `${schemaDir}migrations/${provider}` },
    datasource: {
      url: env.DATABASE_URL || "file:./dev.db",
      ...(env.SHADOW_DATABASE_URL ? { shadowDatabaseUrl: env.SHADOW_DATABASE_URL } : {}),
    },
  };
  // Postgres needs no external tables (pg_trgm indexes are declared in the schema, see
  // scripts/prepare-prisma-schema.mjs), and Prisma would require schema-qualified names there.
  if (!isPostgresProvider(env.DATABASE_PROVIDER)) {
    config.experimental = { externalTables: true };
    config.tables = { external: [...SQLITE_EXTERNAL_TABLES] };
  }
  return config;
}
