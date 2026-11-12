// Startup schema sync (scripts/db-sync.sh): provider schema variants and the Prisma CLI config.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { prepareSchema } from "../../scripts/prepare-prisma-schema.mjs";
import { buildPrismaCliConfig, SQLITE_EXTERNAL_TABLES } from "../../prisma/cli-config.mjs";
import { ARTICLE_TEXT_COLUMNS } from "../../lib/search-indexes";

const source = readFileSync("prisma/schema.prisma", "utf8");
const trgmIndexes = (schema: string) =>
  [...schema.matchAll(/^\s*@@index\(\[(\w+)\(ops: raw\("gin_trgm_ops"\)\)\], type: Gin, map: "ArticleSearch_(\w+)_trgm_idx"\)$/gm)].map((m) => {
    expect(m[1]).toBe(m[2]);
    return m[1];
  });

describe("prepareSchema", () => {
  it("declares exactly the pg_trgm indexes ensureSearchIndexes() creates, for Postgres only", () => {
    const pg = prepareSchema(source, "postgresql");
    expect(pg).toMatch(/provider = "postgresql"/);
    expect(trgmIndexes(pg)).toEqual([...ARTICLE_TEXT_COLUMNS]);

    const sqlite = prepareSchema(source, "sqlite");
    expect(sqlite).toMatch(/provider = "sqlite"/);
    expect(trgmIndexes(sqlite)).toEqual([]);
    expect(sqlite).not.toMatch(/^\s*@@index\(.*type: Gin/m);
  });

  it("leaves the trigram indexes out when pg_trgm is unavailable", () => {
    expect(trgmIndexes(prepareSchema(source, "postgresql", { skipTrgm: true }))).toEqual([]);
  });
});

describe("buildPrismaCliConfig", () => {
  it("marks the FTS tables as external on SQLite only", () => {
    const sqlite = buildPrismaCliConfig({ schema: "s.prisma", env: { DATABASE_PROVIDER: "sqlite", DATABASE_URL: "file:./x.db" } });
    expect(sqlite).toMatchObject({
      schema: "s.prisma",
      datasource: { url: "file:./x.db" },
      experimental: { externalTables: true },
      tables: { external: SQLITE_EXTERNAL_TABLES },
    });
    for (const provider of ["postgres", "postgresql", "POSTGRESQL"]) {
      const pg = buildPrismaCliConfig({ schema: "s.prisma", env: { DATABASE_PROVIDER: provider, DATABASE_URL: "postgresql://x" } }) as Record<string, unknown>;
      expect(pg.tables).toBeUndefined();
      expect(pg.experimental).toBeUndefined();
    }
  });

  it("covers the FTS5 shadow tables and bookkeeping tables", () => {
    expect([...SQLITE_EXTERNAL_TABLES].sort()).toEqual(
      ["article_fts", "article_fts_backfill", "article_fts_config", "article_fts_content", "article_fts_data", "article_fts_docsize", "article_fts_idx", "article_fts_meta"]
    );
  });
});

describe('migration CLI paths', () => {
  it.each(['sqlite', 'file', 'postgres', 'postgresql'])('selects a history relative to each config for %s', (provider) => {
    const selected = provider.startsWith('postgres') ? 'postgresql' : 'sqlite';
    const env = { DATABASE_PROVIDER: provider, SHADOW_DATABASE_URL: 'postgresql://shadow', PRISMA_SCHEMA_OVERRIDE: 'frozen.prisma' };
    for (const [schema, prefix] of [['prisma/schema.generated.prisma', 'prisma/'], ['schema.generated.prisma', '']]) {
      expect(buildPrismaCliConfig({ schema, env })).toMatchObject({
        schema: 'frozen.prisma', migrations: { path: `${prefix}migrations/${selected}` },
        datasource: { shadowDatabaseUrl: 'postgresql://shadow' },
      });
    }
  });
});
