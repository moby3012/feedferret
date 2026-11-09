#!/usr/bin/env node
/**
 * Optional micro-benchmark for the server-side perf quick wins
 * (FTS trigger, list/unread indexes, unread groupBy, SQLite pragmas).
 * NOT part of CI. Usage:
 *
 *   node scripts/bench-queries.mjs [--feeds 200] [--articles 50000] [--content-bytes 2000]
 *                                  [--iterations 30] [--keep]
 *
 * It creates a throw-away SQLite DB in the OS temp dir (via `prisma db push` of the
 * current schema), seeds it, then runs each scenario twice against the SAME data:
 *   before = old FTS trigger (fires on any UPDATE), no list/unread indexes,
 *            relation _count unread query, rollback journal (no pragmas)
 *   after  = narrowed FTS trigger, new indexes, groupBy unread query, WAL pragmas
 * and prints median / p95 in milliseconds.
 *
 * Requires `pnpm install` and a generated client (`pnpm run prisma:generate`).
 * The FTS DDL below mirrors lib/search-indexes.ts; keep them in sync.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");
const Database = require("better-sqlite3");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
}
const FEEDS = arg("feeds", 200);
const ARTICLES = arg("articles", 50_000);
const CONTENT_BYTES = arg("content-bytes", 2000);
const ITER = arg("iterations", 30);
const KEEP = process.argv.includes("--keep");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "feedferret-bench-"));
const dbFile = path.join(tmpDir, "bench.db");

// ---- schema ---------------------------------------------------------------
console.log(`[bench] temp db: ${dbFile}`);
execFileSync("node", ["scripts/prepare-prisma-schema.mjs"], { stdio: "ignore", env: { ...process.env, DATABASE_PROVIDER: "sqlite" } });
execFileSync("npx", ["prisma", "db", "push", "--schema", "prisma/schema.generated.prisma", "--accept-data-loss"], {
  stdio: "ignore",
  env: { ...process.env, DATABASE_URL: `file:${dbFile}`, DATABASE_PROVIDER: "sqlite" },
});

// ---- helpers --------------------------------------------------------------
const SQLITE_PRAGMAS = ["journal_mode = WAL", "synchronous = NORMAL", "busy_timeout = 5000", "temp_store = MEMORY", "cache_size = -20000"];

function makeClient(withPragmas) {
  const factory = new PrismaBetterSqlite3({ url: dbFile });
  if (withPragmas) {
    const connect = factory.connect.bind(factory);
    factory.connect = async () => {
      const adapter = await connect();
      for (const p of SQLITE_PRAGMAS) adapter.client.pragma(p);
      return adapter;
    };
  }
  return new PrismaClient({ adapter: factory, log: ["error"] });
}

const NEW_INDEXES = [
  "Article_userId_publishedAt_createdAt_id_idx",
  "Article_userId_isRead_isSpoiler_feedId_idx",
  "Article_feedId_publishedAt_createdAt_idx",
];
const OLD_INDEX = `CREATE INDEX IF NOT EXISTS "Article_feedId_publishedAt_idx" ON "Article"("feedId", "publishedAt")`;

const FTS_TABLE = `CREATE VIRTUAL TABLE IF NOT EXISTS article_fts USING fts5(id UNINDEXED, title, content, excerpt, author, tokenize='trigram', content='Article', content_rowid='rowid')`;
const FTS_AI = `CREATE TRIGGER IF NOT EXISTS article_fts_ai AFTER INSERT ON "Article" BEGIN INSERT INTO article_fts(rowid, id, title, content, excerpt, author) VALUES (new.rowid, new.id, new.title, new.content, new.excerpt, new.author); END`;
const FTS_AD = `CREATE TRIGGER IF NOT EXISTS article_fts_ad AFTER DELETE ON "Article" BEGIN INSERT INTO article_fts(article_fts, rowid, id, title, content, excerpt, author) VALUES ('delete', old.rowid, old.id, old.title, old.content, old.excerpt, old.author); END`;
const FTS_AU_BODY = `BEGIN INSERT INTO article_fts(article_fts, rowid, id, title, content, excerpt, author) VALUES ('delete', old.rowid, old.id, old.title, old.content, old.excerpt, old.author); INSERT INTO article_fts(rowid, id, title, content, excerpt, author) VALUES (new.rowid, new.id, new.title, new.content, new.excerpt, new.author); END`;
const FTS_AU_OLD = `CREATE TRIGGER article_fts_au AFTER UPDATE ON "Article" ${FTS_AU_BODY}`;
const FTS_AU_NEW = `CREATE TRIGGER article_fts_au AFTER UPDATE OF title, content, excerpt, author ON "Article" ${FTS_AU_BODY}`;

/** Switch the on-disk DB between the old and the new physical design. Prisma client must be disconnected. */
function applyVariant(variant) {
  const raw = new Database(dbFile);
  try {
    raw.pragma(variant === "after" ? "journal_mode = WAL" : "journal_mode = DELETE");
    raw.exec(`DROP TRIGGER IF EXISTS article_fts_au`);
    if (variant === "after") {
      raw.exec(FTS_AU_NEW);
      raw.exec(`DROP INDEX IF EXISTS "Article_feedId_publishedAt_idx"`);
      // Re-create new indexes from the pushed schema if a previous "before" run dropped them.
      raw.exec(`CREATE INDEX IF NOT EXISTS "Article_userId_publishedAt_createdAt_id_idx" ON "Article"("userId", "publishedAt" DESC, "createdAt" DESC, "id" DESC)`);
      raw.exec(`CREATE INDEX IF NOT EXISTS "Article_userId_isRead_isSpoiler_feedId_idx" ON "Article"("userId", "isRead", "isSpoiler", "feedId")`);
      raw.exec(`CREATE INDEX IF NOT EXISTS "Article_feedId_publishedAt_createdAt_idx" ON "Article"("feedId", "publishedAt" DESC, "createdAt" DESC)`);
    } else {
      raw.exec(FTS_AU_OLD);
      for (const name of NEW_INDEXES) raw.exec(`DROP INDEX IF EXISTS "${name}"`);
      raw.exec(OLD_INDEX);
    }
    raw.exec("ANALYZE");
  } finally {
    raw.close();
  }
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { median: q(0.5), p95: q(0.95) };
}

async function time(fn, n = ITER) {
  await fn(0); // warm-up (not recorded)
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn(i);
    samples.push(performance.now() - t);
  }
  return stats(samples);
}

// ---- seed -----------------------------------------------------------------
const WORDS = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua rss feed reader article news update release server database index query performance sqlite postgres".split(" ");
function text(bytes, rnd) {
  const out = [];
  let len = 0;
  while (len < bytes) {
    const w = WORDS[Math.floor(rnd() * WORDS.length)] + (rnd() < 0.05 ? Math.floor(rnd() * 1000) : "");
    out.push(w);
    len += w.length + 1;
  }
  return out.join(" ");
}
let seedState = 42;
const rnd = () => ((seedState = (seedState * 1664525 + 1013904223) % 4294967296) / 4294967296);

const USER_ID = "bench-user";
async function seed() {
  const db = makeClient(false);
  const t0 = performance.now();
  await db.user.create({ data: { id: USER_ID, email: "bench@example.com", name: "Bench" } });
  const feedIds = Array.from({ length: FEEDS }, (_, i) => `bench-feed-${i}`);
  await db.feed.createMany({
    data: feedIds.map((id, i) => ({ id, userId: USER_ID, url: `https://example.com/feed-${i}.xml`, name: `Feed ${i}` })),
  });
  const now = Date.now();
  const BATCH = 500;
  const ids = [];
  for (let start = 0; start < ARTICLES; start += BATCH) {
    const rows = [];
    for (let i = start; i < Math.min(ARTICLES, start + BATCH); i++) {
      const published = new Date(now - Math.floor(rnd() * 730 * 86_400_000));
      const id = `bench-art-${i}`;
      ids.push(id);
      rows.push({
        id,
        feedId: feedIds[Math.floor(rnd() * FEEDS)],
        userId: USER_ID,
        title: text(60, rnd),
        link: `https://example.com/a/${i}`,
        content: text(CONTENT_BYTES, rnd),
        excerpt: text(160, rnd),
        author: `Author ${i % 50}`,
        publishedAt: published,
        createdAt: published,
        isRead: rnd() < 0.8,
        isStarred: rnd() < 0.05,
        dedupeKey: `k-${i}`,
      });
    }
    await db.article.createMany({ data: rows });
    if ((start / BATCH) % 20 === 0) process.stdout.write(`\r[bench] seeded ${Math.min(ARTICLES, start + BATCH)}/${ARTICLES}`);
  }
  console.log(`\n[bench] seed done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  await db.$disconnect();

  // FTS index (created after seeding so inserts stay fast, then backfilled).
  const raw = new Database(dbFile);
  raw.exec(FTS_TABLE);
  raw.exec(FTS_AI);
  raw.exec(FTS_AD);
  raw.exec(`INSERT INTO article_fts(rowid, id, title, content, excerpt, author) SELECT rowid, id, title, content, excerpt, author FROM "Article"`);
  raw.close();
  return ids;
}

// ---- scenarios ------------------------------------------------------------
async function runVariant(variant, ids) {
  applyVariant(variant);
  const db = makeClient(variant === "after");
  await db.$queryRawUnsafe("SELECT 1");
  const res = {};

  // getArticles-like default list (mirrors app/actions/feeds.ts getArticles, "All" view).
  const listInclude = {
    feed: { select: { id: true, name: true, icon: true } },
    labels: { include: { label: true } },
    _count: { select: { duplicates: true } },
    canonical: { select: { feedId: true, feed: { select: { name: true } } } },
  };
  const orderBy = [{ publishedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }];
  res["list: all articles (take 200)"] = await time(() =>
    db.article.findMany({
      where: {
        userId: USER_ID,
        AND: [
          { NOT: { isDuplicate: true, duplicateOf: { not: null } } },
          { feed: { hideFromAllFeeds: false, OR: [{ categoryId: null }, { category: { hideFromAllFeeds: false } }] } },
          { isSpoiler: false },
        ],
      },
      include: listInclude,
      orderBy,
      take: 200,
    })
  );
  res["list: single feed (take 200)"] = await time((i) =>
    db.article.findMany({
      where: { userId: USER_ID, feedId: `bench-feed-${i % FEEDS}`, AND: [{ isSpoiler: false }] },
      include: listInclude,
      orderBy,
      take: 200,
    })
  );

  // Unread counts per feed (getFeeds).
  res["unread counts per feed"] = await time(async () => {
    if (variant === "before") {
      await db.feed.findMany({
        where: { userId: USER_ID },
        include: { category: true, _count: { select: { articles: { where: { isRead: false, isSpoiler: false } } } } },
        orderBy: [{ order: "asc" }, { name: "asc" }],
      });
    } else {
      await Promise.all([
        db.feed.findMany({ where: { userId: USER_ID }, include: { category: true }, orderBy: [{ order: "asc" }, { name: "asc" }] }),
        db.article.groupBy({ by: ["feedId"], where: { userId: USER_ID, isRead: false, isSpoiler: false }, _count: { _all: true } }),
      ]);
    }
  });

  // mark-read: single article update (toggleArticleRead), toggling to keep data stable.
  res["mark-read: single update"] = await time((i) => {
    const id = ids[(i * 7919) % ids.length];
    return db.article.update({ where: { id, userId: USER_ID }, data: { isRead: i % 2 === 0, readAt: new Date() } });
  }, ITER * 5);

  // bulk mark-read of 500 ids (markAllAsRead path).
  res["mark-read: updateMany 500 ids"] = await time((i) => {
    const slice = ids.slice((i * 500) % (ids.length - 500), (i * 500) % (ids.length - 500) + 500);
    return db.article.updateMany({ where: { id: { in: slice }, userId: USER_ID }, data: { isRead: i % 2 === 0, readAt: new Date() } });
  }, Math.max(5, Math.floor(ITER / 3)));

  await db.$disconnect();
  return res;
}

// EXPLAIN for the report.
function explain() {
  const raw = new Database(dbFile, { readonly: true });
  const plan = (sql) => raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(" | ");
  const out = {
    list: plan(`SELECT id FROM "Article" WHERE userId='${USER_ID}' AND isSpoiler=0 ORDER BY publishedAt DESC, createdAt DESC, id DESC LIMIT 200`),
    unread: plan(`SELECT feedId, COUNT(*) FROM "Article" WHERE userId='${USER_ID}' AND isRead=0 AND isSpoiler=0 GROUP BY feedId`),
  };
  raw.close();
  return out;
}

// ---- main -----------------------------------------------------------------
try {
  const ids = await seed();
  const sizeMb = (fs.statSync(dbFile).size / 1e6).toFixed(0);
  console.log(`[bench] db size ${sizeMb} MB, ${FEEDS} feeds, ${ARTICLES} articles, ~${CONTENT_BYTES} B content, ${ITER} iterations`);

  const before = await runVariant("before", ids);
  applyVariant("before");
  const planBefore = explain();
  const after = await runVariant("after", ids);
  const planAfter = explain();

  console.log("\n| scenario | before median | before p95 | after median | after p95 | speedup (median) |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const key of Object.keys(before)) {
    const b = before[key];
    const a = after[key];
    console.log(`| ${key} | ${b.median.toFixed(2)} ms | ${b.p95.toFixed(2)} ms | ${a.median.toFixed(2)} ms | ${a.p95.toFixed(2)} ms | ${(b.median / a.median).toFixed(1)}x |`);
  }
  console.log("\nEXPLAIN QUERY PLAN (list):\n  before:", planBefore.list, "\n  after: ", planAfter.list);
  console.log("EXPLAIN QUERY PLAN (unread groupBy):\n  before:", planBefore.unread, "\n  after: ", planAfter.unread);
} finally {
  if (KEEP) console.log(`[bench] kept ${tmpDir}`);
  else fs.rmSync(tmpDir, { recursive: true, force: true });
}
