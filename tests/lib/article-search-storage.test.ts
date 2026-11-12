import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
const pgUrl = process.env.SEARCH_TEST_PG_URL; // disposable, EMPTY database only
const provider = pgUrl ? "postgresql" : "sqlite";
vi.mock("@/lib/db", () => ({
  get db() { return state.db; },
  getDatabaseProvider: () => process.env.SEARCH_TEST_PG_URL ? "postgresql" : "sqlite",
}));
import { articleSearchProjectionStatus, backfillArticleSearch, ensureArticleSearchStorage, isArticleSearchReady, setPostgresSearchIndexStatus, POSTGRES_SEARCH_DDL, SQLITE_SEARCH_TRIGGERS } from "@/lib/article-search-storage";
import pg from "pg";
import { buildAdvancedSearchWhere } from "@/lib/search";
import { ensureSearchIndexes, postgresSearchIndexStatus } from "@/lib/search-indexes";
import { pureDdlViolations } from "../../scripts/migration-utils.mjs";

const dir = mkdtempSync(join(tmpdir(), "ff-search-projection-"));
const url = pgUrl ?? `file:${join(dir, "test.db")}`;
const root = `prisma/migrations/${provider}`;
const migration = readdirSync(root).find(name => name.endsWith("_article_search_table"))!;
const oldTime = new Date("2025-01-01T00:00:00Z");
const queries = [
  "needle", "ab", "ü", "üni", "Alpha", '"punctuation:"', "needle OR Jane", "Alpha needle",
  "title:Alpha", "-title:Alpha", 'author:"Jane Doe"', "-author:Jane", "content:needle",
  "-content:needle", "entity:EZB", "-entity:EZB", 'entity:"Angela Merkel"',
  "url:needle", "feed:match", "#match", "label:match", "%", "_", 'title:"Other title"',
  "is:unread content:needle OR is:read", "unknown:needle",
];
const expected = new Map<string, string[]>();
const ids = async (where: object) => (await state.db.article.findMany({
  where: { AND: [{ userId: "a" }, where] }, orderBy: { id: "asc" }, select: { id: true },
})).map(row => row.id);

beforeAll(async () => {
  // Real upgrade: apply the preceding history, seed legacy rows, then deploy the new migration.
  // A separate migrations directory lets Prisma stop immediately before the projection.
  const { cpSync, mkdirSync } = await import("node:fs");
  const migrations = join(dir, "migrations");
  mkdirSync(migrations);
  for (const name of readdirSync(root).filter(name => name !== migration)) {
    cpSync(join(root, name), join(migrations, name), { recursive: true });
  }
  const config = join(dir, "prisma.config.mjs");
  const schema = join(process.cwd(), "prisma/schema.generated.prisma");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(config, `export default ${JSON.stringify({ schema, migrations: { path: migrations }, datasource: { url } })}`);
  const deploy = () => execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy", "--config", config], { stdio: "pipe" });
  deploy();
  state.db = new PrismaClient({ adapter: pgUrl ? new PrismaPg({ connectionString: url }) : new PrismaBetterSqlite3({ url }) });
  await state.db.user.createMany({ data: [{ id: "a", email: "a@example.test" }, { id: "b", email: "b@example.test" }] });
  await state.db.feed.createMany({ data: [
    { id: "fa", userId: "a", name: "Feed match", url: "https://example.test/a" },
    { id: "fb", userId: "b", name: "Other", url: "https://example.test/b" },
  ] });
  await state.db.label.create({ data: { id: "label", userId: "a", name: "Label match" } });
  await state.db.article.createMany({ data: Array.from({ length: 16 }, (_, i) => ({
    id: `a${i}`, userId: i === 15 ? "b" : "a", feedId: i === 15 ? "fb" : "fa",
    title: i % 3 === 0 ? "Alpha ünicode punctuation: yes" : "Other title",
    content: i % 4 === 0 ? "Body needle suffix" : "Plain body",
    excerpt: i % 3 === 1 ? "excerpt needle" : null,
    author: i % 4 === 1 ? "Jane Doe" : i % 4 === 2 ? "Somebody" : null,
    entities: i % 2 === 0 ? '["EZB","Angela Merkel"]' : null,
    link: `https://example.test/${i === 14 ? "needle" : i}`,
    publishedAt: oldTime, updatedAt: oldTime,
  })) });
  await state.db.articleLabel.create({ data: { userId: "a", articleId: "a13", labelId: "label" } });
  cpSync(join(root, migration), join(migrations, migration), { recursive: true });
  deploy();
}, 60_000);

afterAll(async () => {
  await state.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

it("backfills exactly, installs the reviewed triggers, and cannot silently adopt non-DDL", async () => {
  expect(await state.db.articleSearch.count()).toBe(16);
  if (!pgUrl) {
    // Rows inserted/updated by triggers before the copy must not break or overwrite it.
    await state.db.$executeRawUnsafe('UPDATE "Article" SET title = \'newer title\' WHERE id = \'a1\'');
    await state.db.$executeRawUnsafe('INSERT INTO "ArticleSearch" (rowid, id, title, content, excerpt, author, entities) SELECT rowid, id, title, content, excerpt, author, entities FROM "Article" WHERE true ON CONFLICT (id) DO NOTHING');
    expect((await state.db.articleSearch.findUnique({ where: { id: "a1" } }))?.title).toBe("newer title");
    expect(await state.db.articleSearch.count()).toBe(16);
  }
  const sql = readFileSync(join(root, migration, "migration.sql"), "utf8");
  for (const statement of provider === "sqlite" ? SQLITE_SEARCH_TRIGGERS : Object.values(POSTGRES_SEARCH_DDL)) {
    expect(sql).toContain(statement);
  }
  // Backfill and triggers must execute. Broadening pure-DDL adoption would silently lose search.
  expect(pureDdlViolations(sql).length).toBeGreaterThan(0);
  expect(await state.db.articleSearch.findUnique({ where: { id: "a0" } })).toMatchObject({
    title: "Alpha ünicode punctuation: yes", content: "Body needle suffix", entities: '["EZB","Angela Merkel"]',
  });
});

it("preserves search results, NULL negation, user isolation, wildcard and field semantics", async () => {
  // Unwrap only the storage relation to execute the former Article-column predicates.
  function legacy(value: unknown): any {
    if (Array.isArray(value)) return value.map(legacy);
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, any>;
    if (object.search) return legacy(object.search.is);
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, legacy(item)]));
  }
  for (const query of queries) {
    const where = await buildAdvancedSearchWhere("a", query);
    const old = await ids(legacy(where));
    expected.set(query, old);
    expect(await ids(where), query).toEqual(old);
    expect(old, query).not.toContain("a15");
  }
  if (!pgUrl) {
    // Simulate an upgraded install with the old Article-backed FTS and a stale ready marker.
    await state.db.$executeRawUnsafe("CREATE VIRTUAL TABLE article_fts USING fts5(id UNINDEXED, title, content, excerpt, author, tokenize='trigram', content='Article', content_rowid='rowid')");
    await state.db.$executeRawUnsafe("CREATE TABLE article_fts_meta (id INTEGER PRIMARY KEY, backfilled_at TEXT)");
    await state.db.$executeRawUnsafe("INSERT INTO article_fts_meta VALUES (1, 'old-ready-marker')");
  }
  await ensureSearchIndexes({ backfill: "await", postgresUrl: url });
  expect(isArticleSearchReady()).toBe(true);
  for (const query of queries) {
    expect(await ids(await buildAdvancedSearchWhere("a", query)), `indexed: ${query}`).toEqual(expected.get(query));
  }
});

it("serves complete results from the Article columns while the projection is incomplete (deferred copy)", async () => {
  const db = state.db;
  // Upgrade whose migration copy was deferred by a lock timeout: projection empty, not yet verified.
  await db.$executeRawUnsafe('DELETE FROM "ArticleSearch"');
  (globalThis as Record<string, unknown>).__feedferret_article_search_projection__ = { state: "backfilling", missing: 16 };
  expect(isArticleSearchReady()).toBe(false);
  for (const query of queries) {
    expect(await ids(await buildAdvancedSearchWhere("a", query)), `unverified: ${query}`).toEqual(expected.get(query));
  }
  expect(expected.get("needle")!.length).toBeGreaterThan(0);
  expect(expected.get("-author:Jane")!.length).toBeGreaterThan(0);
  // The startup check repairs it and only then switches search to the projection.
  await ensureArticleSearchStorage({ yieldMs: 0 });
  if (pgUrl) {
    // Postgres: a complete projection is not enough while its trigram indexes are still building.
    setPostgresSearchIndexStatus({ state: "building", detail: "test" });
    expect(isArticleSearchReady()).toBe(false);
    expect(JSON.stringify(await buildAdvancedSearchWhere("a", "title:Alpha"))).not.toContain('"search"');
    setPostgresSearchIndexStatus({ state: "ready" });
  }
  expect(isArticleSearchReady()).toBe(true);
  expect(JSON.stringify(await buildAdvancedSearchWhere("a", "title:Alpha"))).toContain('"search"');
  for (const query of queries) {
    expect(await ids(await buildAdvancedSearchWhere("a", query)), `repaired: ${query}`).toEqual(expected.get(query));
  }
});

it.runIf(pgUrl)("copy and backfill never deadlock with a bulk mark-read (SELECT … FOR UPDATE, then UPDATE), in either order", async () => {
  const sql = readFileSync(join(root, migration, "migration.sql"), "utf8");
  const phase = sql.slice(sql.indexOf("BEGIN;\nSET LOCAL lock_timeout"), sql.indexOf("COMMIT;", sql.indexOf("BEGIN;\nSET LOCAL lock_timeout")));
  expect(phase).toContain('LOCK TABLE "Article" IN EXCLUSIVE MODE');
  const client = async () => { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; };
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const errors: string[] = [];
  const track = <T,>(p: Promise<T>, who: string) => p.catch((err: { code?: string; message: string }) => { errors.push(`${who}: ${err.code ?? ""} ${err.message}`); });
  const lockHolders = async (c: pg.Client, mode: string) => (await c.query(
    `SELECT count(*)::int AS n FROM pg_locks WHERE relation = '"Article"'::regclass AND mode = $1 AND granted`, [mode])).rows[0].n;
  // bulk-read.ts pattern: row-lock the batch, then update it, in one transaction.
  const bulkWriter = async (c: pg.Client, beforeUpdate: () => Promise<void>) => {
    await c.query("BEGIN");
    await c.query(`SELECT id FROM "Article" WHERE "userId" = 'a' ORDER BY id FOR UPDATE`);
    await beforeUpdate();
    await c.query(`UPDATE "Article" SET "isRead" = NOT "isRead" WHERE "userId" = 'a'`);
    await c.query("COMMIT");
  };
  const copies: Record<string, (c: pg.Client) => Promise<unknown>> = {
    migration: (c) => c.query(phase + "COMMIT;"),
    app: async () => backfillArticleSearch({ yieldMs: 0 }),
  };
  const [w, k, probe] = [await client(), await client(), await client()];
  try {
    for (const [name, copy] of Object.entries(copies)) {
      // Order 1: the writer holds its row locks first; the copy starts, then the writer updates.
      await state.db.$executeRawUnsafe('DELETE FROM "ArticleSearch"');
      let copying: Promise<unknown> = Promise.resolve();
      await track(bulkWriter(w, async () => {
        copying = track(copy(k), `${name} copy (writer first)`);
        await sleep(1500); // > deadlock_timeout: a cycle would be detected by now
      }), `writer (${name} copy second)`);
      await copying;
      expect(await state.db.articleSearch.count()).toBe(await state.db.article.count());
    }
    // Order 2: the copy runs and holds the EXCLUSIVE lock first (its transaction kept open), then
    // the writer row-locks and updates. The app batches take the same lock in the same way.
    await state.db.$executeRawUnsafe('DELETE FROM "ArticleSearch"');
    await track(k.query(phase), "migration copy (copy first)"); // BEGIN; SET LOCAL; DO … (no COMMIT yet)
    expect(await lockHolders(probe, "ExclusiveLock")).toBe(1);
    const writing = track(bulkWriter(w, async () => {}), "writer (copy first)");
    await sleep(1500);
    await track(k.query("COMMIT"), "migration copy commit");
    await writing;
    expect(await state.db.articleSearch.count()).toBe(await state.db.article.count());
    expect(errors).toEqual([]);

    // Control: the previous SHARE-mode copy deadlocks with the same writer (proves the test bites).
    await state.db.$executeRawUnsafe('DELETE FROM "ArticleSearch"');
    let control: Promise<unknown> = Promise.resolve();
    await track(bulkWriter(w, async () => {
      control = track(k.query(phase.replace("IN EXCLUSIVE MODE", "IN SHARE MODE").replace(
        "EXCEPTION WHEN lock_not_available OR deadlock_detected OR query_canceled", "EXCEPTION WHEN lock_not_available") + "COMMIT;"), "SHARE copy");
      await sleep(1500);
    }), "writer vs SHARE copy");
    await control;
    await w.query("ROLLBACK").catch(() => {});
    await k.query("ROLLBACK").catch(() => {});
    expect(errors.join("\n")).toMatch(/40P01/);
  } finally {
    for (const c of [w, k, probe]) await c.end().catch(() => {});
    await ensureArticleSearchStorage({ yieldMs: 0 });
  }
}, 60_000);

it("startup self-check finds and repairs an incomplete projection", async () => {
  const db = state.db;
  const total = await db.article.count();
  // e.g. the migration backfill was deferred by a lock conflict, or a dump was restored without it.
  await db.$executeRawUnsafe(`DELETE FROM "ArticleSearch" WHERE id IN ('a1', 'a2', 'a3')`);
  expect(await db.articleSearch.count()).toBe(total - 3);
  const status = await ensureArticleSearchStorage({ yieldMs: 0 });
  expect(status).toMatchObject({ state: "complete", missing: 0 });
  expect(articleSearchProjectionStatus().detail).toBe("backfilled 3");
  expect(await db.articleSearch.count()).toBe(total);
  expect(await db.articleSearch.findUnique({ where: { id: "a1" } })).toMatchObject({ excerpt: "excerpt needle", author: "Jane Doe" });
  // Complete projection: no work, no rewrite.
  expect(await ensureArticleSearchStorage()).toMatchObject({ state: "complete", missing: 0 });
  expect(articleSearchProjectionStatus().detail).toBeUndefined();
});

it.runIf(pgUrl)("builds the GIN indexes concurrently, rebuilds INVALID leftovers, then drops the legacy Article indexes", async () => {
  const db = state.db;
  const indexes = async () => (await db.$queryRawUnsafe<{ name: string; valid: boolean }[]>(
    `SELECT c.relname AS name, i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
     WHERE c.relname LIKE 'Article%\\_trgm\\_idx' ORDER BY 1`)).map(row => `${row.name}:${row.valid}`);
  expect(postgresSearchIndexStatus().state).toBe("ready");
  expect(await indexes()).toEqual(["author", "content", "entities", "excerpt", "title"].map(c => `ArticleSearch_${c}_trgm_idx:true`));
  // A killed CREATE INDEX CONCURRENTLY leaves an INVALID index behind; simulate one that fails mid-build.
  await db.$executeRawUnsafe('DROP INDEX "ArticleSearch_title_trgm_idx"');
  await expect(db.$executeRawUnsafe(
    'CREATE INDEX CONCURRENTLY "ArticleSearch_title_trgm_idx" ON "ArticleSearch" USING GIN ((title || (1 / (length(title) - length(title)))::text) gin_trgm_ops)'
  )).rejects.toThrow();
  expect(await indexes()).toContain("ArticleSearch_title_trgm_idx:false");
  // Rollback to an older image recreates the legacy Article indexes.
  await db.$executeRawUnsafe('CREATE INDEX "Article_title_trgm_idx" ON "Article" USING GIN ("title" gin_trgm_ops)');
  await ensureSearchIndexes({ postgresUrl: url });
  expect(postgresSearchIndexStatus().state).toBe("ready");
  expect(await indexes()).toEqual(["author", "content", "entities", "excerpt", "title"].map(c => `ArticleSearch_${c}_trgm_idx:true`));
  const def = await db.$queryRawUnsafe<{ indexdef: string }[]>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'ArticleSearch_title_trgm_idx'`);
  expect(def[0].indexdef).toContain("gin (title gin_trgm_ops)");
});

it("syncs content and deletes, while state/bookkeeping/no-op writes leave search untouched", async () => {
  const db = state.db;
  const before = await db.articleSearch.findUnique({ where: { id: "a0" } });
  if (pgUrl) {
    await db.$executeRawUnsafe('CREATE TABLE search_write_audit (id TEXT)');
    await db.$executeRawUnsafe('CREATE FUNCTION search_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO search_write_audit VALUES (NEW.id); RETURN NEW; END $$');
    await db.$executeRawUnsafe('CREATE TRIGGER search_audit AFTER UPDATE ON "ArticleSearch" FOR EACH ROW EXECUTE FUNCTION search_audit()');
  } else {
    await db.$executeRawUnsafe('CREATE TABLE search_write_audit (id TEXT)');
    await db.$executeRawUnsafe('CREATE TRIGGER search_audit AFTER UPDATE ON "ArticleSearch" BEGIN INSERT INTO search_write_audit VALUES (NEW.id); END');
  }
  await db.$executeRawUnsafe('UPDATE "Article" SET "isRead" = true, "readAt" = CURRENT_TIMESTAMP, "isStarred" = true, "fullTextAttempts" = 2 WHERE id = \'a0\'');
  await db.$executeRawUnsafe('UPDATE "Article" SET title = title, content = content WHERE id = \'a0\'');
  expect(await db.$queryRawUnsafe('SELECT * FROM search_write_audit')).toEqual([]);
  expect(await db.articleSearch.findUnique({ where: { id: "a0" } })).toEqual(before);
  expect((await db.article.findUnique({ where: { id: "a0" } }))?.updatedAt).toEqual(oldTime);
  await db.$executeRawUnsafe('UPDATE "Article" SET title = \'changed\', content = \'new body\', excerpt = NULL, author = \'new author\', entities = NULL WHERE id = \'a0\'');
  expect(await db.articleSearch.findUnique({ where: { id: "a0" } })).toMatchObject({
    title: "changed", content: "new body", excerpt: null, author: "new author", entities: null,
  });
  expect(await db.$queryRawUnsafe('SELECT * FROM search_write_audit')).toHaveLength(1);
  await db.article.delete({ where: { id: "a0" } });
  expect(await db.articleSearch.findUnique({ where: { id: "a0" } })).toBeNull();
  await db.feed.delete({ where: { id: "fb" } });
  expect(await db.articleSearch.findUnique({ where: { id: "a15" } })).toBeNull();
});


it("covers bulk ingestion, identity cascades and user deletion", async () => {
  const db = state.db;
  await db.article.createMany({ data: [0, 1].map(i => ({
    id: `fresh${i}`, userId: "a", feedId: "fa", title: "fresh headline",
    content: "fresh body", link: `https://example.test/fresh${i}`, publishedAt: oldTime,
  })) });
  expect(await db.articleSearch.count({ where: { id: { in: ["fresh0", "fresh1"] } } })).toBe(2);
  await db.$executeRawUnsafe('UPDATE "Article" SET id = \'renamed\' WHERE id = \'fresh0\'');
  expect(await db.articleSearch.findUnique({ where: { id: "fresh0" } })).toBeNull();
  expect(await db.articleSearch.findUnique({ where: { id: "renamed" } })).toMatchObject({ content: "fresh body" });
  await db.user.delete({ where: { id: "a" } });
  expect(await db.articleSearch.count()).toBe(0);
});
