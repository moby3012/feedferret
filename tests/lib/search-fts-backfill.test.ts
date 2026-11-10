// SQLite search at scale (audit R2 + R3) against a real temporary database:
//  - a term with more FTS hits than Prisma's 32 766 bind-variable limit must not 500 (P2029),
//  - the first-time FTS backfill runs in the background in chunks, search stays complete
//    (LIKE path) while it runs, and the sync triggers never corrupt the half-built index,
//  - PRAGMA optimize populates sqlite_stat1.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
  getDatabaseProvider: () => "sqlite",
}));

import { checkSqliteFtsAndRepair, checkSqliteFtsConsistency, ensureSearchIndexes, isSqliteFtsReady, runSqliteFtsBackfill } from "../../lib/search-indexes";
import { buildAdvancedSearchWhere, MAX_SEARCH_TOKENS } from "../../lib/search";
import { optimizeSqlitePlannerStats } from "../../lib/db-maintenance";
import { SQLITE_EXTERNAL_TABLES } from "../../prisma/cli-config.mjs";

const dir = mkdtempSync(join(tmpdir(), "feedferret-search-scale-"));
const template = join(dir, "template.db");
const U = { alice: "", bob: "", feed: "", bobFeed: "" };

function resetProcessCaches() {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.__feedferret_fts_ready__;
  delete g.__feedferret_fts_backfill__;
  delete g.__feedferret_sqlite_optimize__;
}

async function openFreshDb(name: string) {
  resetProcessCaches();
  if (state.db) await state.db.$disconnect();
  const file = join(dir, name);
  copyFileSync(template, file);
  state.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
  return state.db;
}

async function seedUsers(db: PrismaClient) {
  U.alice = (await db.user.create({ data: { email: `alice-${Math.random()}@test`, name: "Alice" } })).id;
  U.bob = (await db.user.create({ data: { email: `bob-${Math.random()}@test`, name: "Bob" } })).id;
  U.feed = (await db.feed.create({ data: { name: "A", url: `https://a.example/${Math.random()}`, userId: U.alice } })).id;
  U.bobFeed = (await db.feed.create({ data: { name: "B", url: `https://b.example/${Math.random()}`, userId: U.bob } })).id;
}

async function bulkArticles(db: PrismaClient, userId: string, feedId: string, count: number, make: (i: number) => { title: string; content: string }, prefix: string) {
  const CHUNK = 500;
  for (let start = 0; start < count; start += CHUNK) {
    await db.article.createMany({
      data: Array.from({ length: Math.min(CHUNK, count - start) }, (_, j) => {
        const i = start + j;
        const { title, content } = make(i);
        return {
          id: `${prefix}${String(i).padStart(6, "0")}`, userId, feedId, title, content,
          link: `https://x.example/${prefix}${i}`, dedupeKey: `${prefix}${i}`,
          publishedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000),
        };
      }),
    });
  }
}

const ftsMatches = async (db: PrismaClient, term: string) =>
  (await db.$queryRawUnsafe<{ id: string }[]>(`SELECT a.id AS id FROM "Article" a WHERE a.rowid IN (SELECT rowid FROM article_fts WHERE article_fts MATCH ?) ORDER BY a.id`, `"${term}"`)).map((r) => r.id);

beforeAll(() => {
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.generated.prisma"], {
    env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: `file:${template}` },
    stdio: "pipe",
  });
});
afterAll(async () => {
  if (state.db) await state.db.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => resetProcessCaches());

describe("search with more matches than Prisma's bind-variable limit", () => {
  it("does not fail (P2029) for a term that matches 34 000 rows, and still pages + counts correctly", async () => {
    const db = await openFreshDb("scale.db");
    await seedUsers(db);
    const N = 34_000; // > 32 766
    await bulkArticles(db, U.alice, U.feed, N, (i) => ({ title: `Story ${i}`, content: `<p>the database index number ${i}${i === 7 ? " zebracrossing" : ""}</p>` }), "a");
    // Same term in another user's rows must not count towards (or leak into) Alice's results.
    await bulkArticles(db, U.bob, U.bobFeed, 40, (i) => ({ title: `Bob ${i}`, content: "<p>the database index</p>" }), "b");

    await ensureSearchIndexes({ backfill: "await" });
    expect(await isSqliteFtsReady()).toBe(true);

    const where = await buildAdvancedSearchWhere(U.alice, "database");
    // Over the cap → no IN list at all (LIKE path), so there is nothing to overflow.
    expect(JSON.stringify(where)).not.toContain('"in"');
    const scoped = { AND: [{ userId: U.alice }, where] };
    expect(await db.article.count({ where: scoped })).toBe(N);
    const page = await db.article.findMany({ where: scoped, orderBy: [{ publishedAt: "desc" }, { id: "desc" }], take: 50, select: { id: true, userId: true } });
    expect(page).toHaveLength(50);
    expect(page.every((r) => r.userId === U.alice)).toBe(true);

    // Rare term: FTS is used (bounded id list), scoped to the user.
    const rare = await buildAdvancedSearchWhere(U.alice, "zebracrossing");
    expect(JSON.stringify(rare)).toContain('"in"');
    expect((await db.article.findMany({ where: { AND: [{ userId: U.alice }, rare] }, select: { id: true } })).map((r) => r.id)).toEqual(["a000007"]);

    // Several broad terms together are fine too.
    const multi = await buildAdvancedSearchWhere(U.alice, "database index the");
    expect(await db.article.count({ where: { AND: [{ userId: U.alice }, multi] } })).toBe(N);
  }, 180_000);
});

describe("chunked background FTS backfill", () => {
  it("keeps search complete while the backfill is pending and leaves a consistent index afterwards", async () => {
    const db = await openFreshDb("backfill.db");
    await seedUsers(db);
    await bulkArticles(db, U.alice, U.feed, 700, (i) => ({ title: `Old story ${i}`, content: `<p>legacy body ${i} pangolin</p>` }), "o");

    // Schema + triggers + progress row only; the caller drives the backfill.
    await ensureSearchIndexes({ backfill: "none" });
    expect(await isSqliteFtsReady()).toBe(false);

    // While rows are still pending the triggers must leave them alone…
    await db.article.update({ where: { id: "o000010" }, data: { title: "Renamed narwhal story" } });
    await db.article.delete({ where: { id: "o000020" } });
    // …but a row created after the backfill started is a normal trigger-indexed row.
    await bulkArticles(db, U.alice, U.feed, 3, (i) => ({ title: `Fresh ${i}`, content: "<p>new body quokka</p>" }), "n");

    // Not ready → search uses the LIKE path and still finds un-indexed (pending) rows.
    const pending = await buildAdvancedSearchWhere(U.alice, "narwhal");
    expect(JSON.stringify(pending)).not.toContain('"in"');
    expect((await db.article.findMany({ where: { AND: [{ userId: U.alice }, pending] }, select: { id: true } })).map((r) => r.id)).toEqual(["o000010"]);

    await runSqliteFtsBackfill({ yieldMs: 0 });
    expect(await isSqliteFtsReady()).toBe(true);
    // Single-flight state is released, marker present, progress row gone.
    expect(await db.$queryRawUnsafe(`SELECT 1 FROM article_fts_backfill`)).toEqual([]);

    // FTS5 verifies the index against the content table: catches double/missing/phantom entries.
    await db.$executeRawUnsafe(`INSERT INTO article_fts(article_fts, rank) VALUES ('integrity-check', 1)`);
    expect(await ftsMatches(db, "narwhal")).toEqual(["o000010"]);
    expect(await ftsMatches(db, "quokka")).toEqual(["n000000", "n000001", "n000002"]);
    expect((await ftsMatches(db, "pangolin")).length).toBe(699); // 700 − the one deleted while pending
    expect(await ftsMatches(db, "legacy body 20 pangolin")).toEqual([]); // the deleted row left no phantom entry

    // After completion the triggers are active for every row.
    await db.article.update({ where: { id: "o000030" }, data: { content: "<p>axolotl</p>" } });
    await db.article.delete({ where: { id: "o000031" } });
    await db.$executeRawUnsafe(`INSERT INTO article_fts(article_fts, rank) VALUES ('integrity-check', 1)`);
    expect(await ftsMatches(db, "axolotl")).toEqual(["o000030"]);
    expect(await ftsMatches(db, "pangolin")).not.toContain("o000031");

    // Idempotent on the next boot: no second backfill, no duplicate index entries.
    await ensureSearchIndexes({ backfill: "await" });
    await db.$executeRawUnsafe(`INSERT INTO article_fts(article_fts, rank) VALUES ('integrity-check', 1)`);
  }, 120_000);

  it("resumes from the persisted progress row", async () => {
    const db = await openFreshDb("resume.db");
    await seedUsers(db);
    await bulkArticles(db, U.alice, U.feed, 400, (i) => ({ title: `Story ${i}`, content: `<p>body ${i} capybara</p>` }), "r");
    await ensureSearchIndexes({ backfill: "none" });
    // Simulate "process died after the first chunk".
    const mid = (await db.$queryRawUnsafe<{ r: number | bigint }[]>(`SELECT rowid AS r FROM "Article" ORDER BY rowid LIMIT 1 OFFSET 149`))[0].r;
    await db.$transaction([
      db.$executeRawUnsafe(`INSERT INTO article_fts(rowid, id, title, content, excerpt, author) SELECT rowid, id, title, content, excerpt, author FROM "Article" WHERE rowid <= ?`, Number(mid)),
      db.$executeRawUnsafe(`UPDATE article_fts_backfill SET done_rowid = ? WHERE id = 1`, Number(mid)),
    ]);
    resetProcessCaches();
    await ensureSearchIndexes({ backfill: "await" }); // "next boot"
    expect(await isSqliteFtsReady()).toBe(true);
    await db.$executeRawUnsafe(`INSERT INTO article_fts(article_fts, rank) VALUES ('integrity-check', 1)`);
    expect((await ftsMatches(db, "capybara")).length).toBe(400);
  }, 60_000);
});

describe("FTS table dropped behind our back", () => {
  it("rebuilds when `prisma db push` removed article_fts but left a stale 'complete' marker", async () => {
    const db = await openFreshDb("dropped.db");
    await seedUsers(db);
    await bulkArticles(db, U.alice, U.feed, 120, (i) => ({ title: `Story ${i}`, content: `<p>body ${i} wombat</p>` }), "d");
    await ensureSearchIndexes({ backfill: "await" });
    expect(await isSqliteFtsReady()).toBe(true);

    // What db push does to unmanaged objects (the marker table survived in practice).
    await db.$executeRawUnsafe(`DROP TABLE article_fts`);
    resetProcessCaches();

    await ensureSearchIndexes({ backfill: "none" });
    expect(await isSqliteFtsReady()).toBe(false); // empty index must not be trusted
    const where = await buildAdvancedSearchWhere(U.alice, "wombat");
    expect(JSON.stringify(where)).not.toContain('"in"'); // LIKE path while rebuilding

    await runSqliteFtsBackfill({ yieldMs: 0 });
    expect(await isSqliteFtsReady()).toBe(true);
    expect((await ftsMatches(db, "wombat")).length).toBe(120);
  }, 60_000);
});

describe("startup `prisma db push` with the FTS index in place", () => {
  it("is repeatable and leaves article_fts + its shadow/bookkeeping tables intact (was a restart loop)", async () => {
    const db = await openFreshDb("push.db");
    await seedUsers(db);
    await bulkArticles(db, U.alice, U.feed, 60, (i) => ({ title: `Story ${i}`, content: `<p>body ${i} fossa</p>` }), "p");
    await ensureSearchIndexes({ backfill: "await" });
    const ftsTables = async () =>
      (await db.$queryRawUnsafe<{ name: string }[]>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'article_fts%' ORDER BY name`)).map((r) => r.name);
    const before = await ftsTables();
    // Every FTS object on disk must be declared external, or db push would try to drop it.
    expect(before).toEqual([...SQLITE_EXTERNAL_TABLES].filter((t) => before.includes(t)).sort());
    expect(before.every((t) => SQLITE_EXTERNAL_TABLES.includes(t))).toBe(true);
    const file = join(dir, "push.db");
    await db.$disconnect();

    for (let boot = 0; boot < 2; boot++) {
      execFileSync("pnpm", ["exec", "prisma", "db", "push", "--config", "prisma/startup.config.mjs", "--accept-data-loss"], {
        env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: `file:${file}` },
        stdio: "pipe",
      });
    }

    state.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
    expect(await ftsTables()).toEqual(before);
    resetProcessCaches();
    expect(await isSqliteFtsReady()).toBe(true);
    await state.db.$executeRawUnsafe(`INSERT INTO article_fts(article_fts, rank) VALUES ('integrity-check', 1)`);
    expect((await ftsMatches(state.db, "fossa")).length).toBe(60);
  }, 60_000);
});

describe("boot-time FTS consistency check", () => {
  const updatedAts = async (db: PrismaClient) =>
    (await db.article.findMany({ select: { id: true, updatedAt: true }, orderBy: { id: "asc" } })).map((r) => `${r.id}@${r.updatedAt.toISOString()}`);

  it("passes on a healthy index and leaves it alone", async () => {
    const db = await openFreshDb("check-ok.db");
    await seedUsers(db);
    await bulkArticles(db, U.alice, U.feed, 150, (i) => ({ title: `Healthy "quoted" story ${i}`, content: `<p>body ${i} ocelot</p>` }), "h");
    await ensureSearchIndexes({ backfill: "await" });
    expect(await checkSqliteFtsConsistency()).toEqual({ ok: true });
    expect(await checkSqliteFtsAndRepair({ backfill: "await" })).toEqual({ ok: true });
    expect(await isSqliteFtsReady()).toBe(true);
    // The next boot runs the check (await mode) and keeps the marker.
    resetProcessCaches();
    await ensureSearchIndexes({ backfill: "await" });
    expect(await isSqliteFtsReady()).toBe(true);
    expect(await db.$queryRawUnsafe(`SELECT 1 FROM article_fts_backfill`)).toEqual([]);
  }, 60_000);

  it("rebuilds an index with missing rows on the next boot, without touching Article.updatedAt", async () => {
    const db = await openFreshDb("check-missing.db");
    await seedUsers(db);
    await bulkArticles(db, U.alice, U.feed, 200, (i) => ({ title: `Story ${i}`, content: `<p>body ${i} tapir</p>` }), "m");
    await ensureSearchIndexes({ backfill: "await" });
    const before = await updatedAts(db);

    // Lose 3 rows from the index (what a crash between Article write and index write, or a
    // restored partial backup, looks like).
    await db.$executeRawUnsafe(
      `INSERT INTO article_fts(article_fts, rowid, id, title, content, excerpt, author)
       SELECT 'delete', rowid, id, title, content, excerpt, author FROM "Article" WHERE id IN ('m000005', 'm000006', 'm000007')`
    );
    expect(await checkSqliteFtsConsistency()).toEqual({ ok: false, reason: "indexed 197 of 200 articles" });

    resetProcessCaches();
    await ensureSearchIndexes({ backfill: "await" }); // "next boot"
    expect(await isSqliteFtsReady()).toBe(true);
    expect(await checkSqliteFtsConsistency()).toEqual({ ok: true });
    await db.$executeRawUnsafe(`INSERT INTO article_fts(article_fts, rank) VALUES ('integrity-check', 1)`);
    expect((await ftsMatches(db, "tapir")).length).toBe(200);
    expect(await updatedAts(db)).toEqual(before);
  }, 60_000);

  it("detects an index whose content no longer matches the newest article and rebuilds it in the background", async () => {
    const db = await openFreshDb("check-stale.db");
    await seedUsers(db);
    await bulkArticles(db, U.alice, U.feed, 50, (i) => ({ title: `Story ${i}`, content: `<p>body ${i} margay</p>` }), "s");
    await ensureSearchIndexes({ backfill: "await" });
    // Same row count, but the newest row was indexed with other text (e.g. trigger missing during an update).
    await db.$executeRawUnsafe(`DROP TRIGGER article_fts_au`);
    await db.article.update({ where: { id: "s000049" }, data: { title: "Completely different headline" } });
    const result = await checkSqliteFtsConsistency();
    expect(result.ok).toBe(false);

    const repaired = await checkSqliteFtsAndRepair({ backfill: "none" });
    expect(repaired.ok).toBe(false);
    // Search stops trusting the index immediately and uses the LIKE path…
    expect(await isSqliteFtsReady()).toBe(false);
    const where = await buildAdvancedSearchWhere(U.alice, "different headline");
    expect(JSON.stringify(where)).not.toContain('"in"');
    // …until the background rebuild is done.
    await ensureSearchIndexes({ backfill: "none" }); // restores the trigger
    await runSqliteFtsBackfill({ yieldMs: 0 });
    expect(await isSqliteFtsReady()).toBe(true);
    expect(await ftsMatches(db, "different headline")).toEqual(["s000049"]);
    expect(await checkSqliteFtsConsistency()).toEqual({ ok: true });
  }, 60_000);
});

describe("terms with a mid-sized hit count (SQLite: 999 bind variables in Prisma 7)", () => {
  it("does not fail (P2029) for a term with 3 000 hits and still uses FTS for one with 400", async () => {
    const db = await openFreshDb("mid.db");
    await seedUsers(db);
    await bulkArticles(db, U.alice, U.feed, 3000, (i) => ({ title: `Story ${i} jaguarundi${i < 400 ? " kinkajou" : ""}`, content: `<p>body ${i}</p>` }), "j");
    await ensureSearchIndexes({ backfill: "await" });
    for (const [term, expected, usesFts] of [["jaguarundi", 3000, false], ["kinkajou", 400, true]] as const) {
      const where = await buildAdvancedSearchWhere(U.alice, term);
      expect(JSON.stringify(where).includes('"in"')).toBe(usesFts);
      const scoped = { AND: [{ userId: U.alice }, where] };
      expect(await db.article.count({ where: scoped })).toBe(expected);
      expect(await db.article.findMany({ where: scoped, take: 5, orderBy: { publishedAt: "desc" } })).toHaveLength(5);
    }
  }, 60_000);
});

describe("query size caps", () => {
  it("huge queries (many tokens, very long terms) neither throw nor exceed SQLite limits", async () => {
    const db = await openFreshDb("caps.db");
    await seedUsers(db);
    // 300 hits per term: with a naive per-term id list, 24 such terms would need 7 200 binds.
    await bulkArticles(db, U.alice, U.feed, 300, (i) => ({ title: `Story ${i} serval`, content: `<p>body ${i}</p>` }), "c");
    await ensureSearchIndexes({ backfill: "await" });

    const manyTokens = Array.from({ length: 2000 }, (_, i) => `serval${i % 3 === 0 ? "" : ` -nomatch${i}`}`).join(" ");
    const longTerm = "serval".repeat(20_000); // 120 000 chars, > SQLITE_MAX_LIKE_PATTERN_LENGTH
    const orGroups = Array.from({ length: 500 }, (_, i) => `story${i}`).join(" OR ");
    for (const q of [manyTokens, longTerm, orGroups]) {
      const where = await buildAdvancedSearchWhere(U.alice, q);
      const scoped = { AND: [{ userId: U.alice }, where] };
      await expect(db.article.count({ where: scoped })).resolves.toBeTypeOf("number");
      await expect(db.article.findMany({ where: scoped, take: 20, select: { id: true } })).resolves.toBeInstanceOf(Array);
    }
    // Tokens past the cap are ignored: the query only gets broader.
    const capped = Array.from({ length: MAX_SEARCH_TOKENS }, () => "serval").join(" ") + " nothingmatchesthis";
    expect(await db.article.count({ where: { AND: [{ userId: U.alice }, await buildAdvancedSearchWhere(U.alice, capped)] } })).toBe(300);
  }, 60_000);
});

describe("SQLite planner statistics", () => {
  it("PRAGMA optimize creates sqlite_stat1 and is safe to repeat", async () => {
    const db = await openFreshDb("stats.db");
    await seedUsers(db);
    await bulkArticles(db, U.alice, U.feed, 800, (i) => ({ title: `S${i}`, content: "<p>x</p>" }), "s");
    expect(await db.$queryRawUnsafe(`SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'`)).toEqual([]);
    const first = await optimizeSqlitePlannerStats({ full: true });
    expect(first.ran).toBe(true);
    const stats = await db.$queryRawUnsafe<{ tbl: string }[]>(`SELECT DISTINCT tbl FROM sqlite_stat1`);
    expect(stats.map((s) => s.tbl)).toContain("Article");
    expect((await optimizeSqlitePlannerStats()).ran).toBe(true);
  }, 60_000);
});
