// Opt-in benchmark (MARK_READ_BENCH=1): bulk mark-read paths at scale on a disposable SQLite DB
// (or Postgres via PERF_BENCH_DATABASE_URL — use an EMPTY throwaway database, the schema is pushed into it).
//
//   MARK_READ_BENCH=1 [MARK_READ_BENCH_RESULT=/tmp/out.json] npx vitest run tests/mark-read-scale-benchmark.test.ts
//
// Seeds user A (200 feeds + one 10 k "big" feed, 50 k articles, ~45 k unread, 2 KB bodies) and
// user B (5 k unread) and runs every bulk-read entry point against the same data, resetting the read
// state between scenarios: the UI server actions (mark all / undo / range), GReader
// `mark-all-as-read`, Fever `mark=group|feed`, REST v1 `articles/mark-all-read` and MCP
// `mark_all_read`. Reports wall time and the number of SQL statements per scenario, plus a
// concurrency scenario: a sync-like writer inserts new articles while "mark all" runs (insert
// latency, and whether any of the new rows were marked).
// Never runs in the normal suite and never touches DATABASE_URL (own temp DB).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const ENABLED = process.env.MARK_READ_BENCH === "1";
const dir = ENABLED ? mkdtempSync(join(tmpdir(), "mark-read-bench-")) : "";
const PG = !!process.env.PERF_BENCH_DATABASE_URL;
if (ENABLED) {
  process.env.DATABASE_PROVIDER = PG ? "postgresql" : "sqlite";
  process.env.DATABASE_URL = process.env.PERF_BENCH_DATABASE_URL ?? `file:${join(dir, "bench.db")}`;
  process.env.DISABLE_BACKGROUND_SYNC = "true";
}

const state = vi.hoisted(() => ({ user: "ua" as string }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: state.user } })) }));
vi.mock("@/lib/greader", async (original) => ({
  ...(await original<typeof import("@/lib/greader")>()),
  authenticateGReaderRequest: vi.fn(async () => ({ id: state.user, email: "a@example.org", apiTokenVersion: 0 })),
}));
vi.mock("@/lib/api-auth", async (original) => {
  const actual = await original<typeof import("@/lib/api-auth")>();
  const user = () => ({ id: state.user, email: "a@example.org", name: "A", role: "USER", isActive: true, tokenScope: "write" });
  return { ...actual, resolveApiUser: vi.fn(async () => user()), requireApiUser: vi.fn(async () => user()) };
});
vi.mock("@/lib/rate-limit", async (original) => {
  const actual = await original<typeof import("@/lib/rate-limit")>();
  return { ...actual, checkRateLimit: () => ({ success: true }), peekRateLimit: () => ({ success: true }) };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const stats = { statements: 0, slow: [] as Array<{ ms: number; sql: string }> };
const results: Record<string, unknown> = {};
const round = (n: number) => Math.round(n * 10) / 10;
const FEVER_KEY = "bench-fever-key";

describe.skipIf(!ENABLED)("bulk mark-read at scale (50 k articles)", () => {
  let db: any;
  const now = Date.now();
  const SEEDED_UNREAD_A = { count: 0 };

  beforeAll(async () => {
    execFileSync("node", ["scripts/prepare-prisma-schema.mjs"], { env: process.env, stdio: "pipe" });
    execFileSync("npx", ["prisma", "db", "push", "--schema", "prisma/schema.generated.prisma", "--accept-data-loss"], { env: process.env, stdio: "pipe" });

    // Our own client with query events (counts SQL statements), installed where lib/db looks for it.
    const { PrismaClient } = await import("@prisma/client");
    const { withExternalIds } = await import("@/lib/external-id-store");
    let adapter: unknown;
    if (PG) {
      const { PrismaPg } = await import("@prisma/adapter-pg");
      const pg = (await import("pg")).default;
      adapter = new PrismaPg(new pg.Pool({ connectionString: process.env.DATABASE_URL }));
    } else {
      const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
      const factory = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL!.replace(/^file:/, "") });
      const connect = factory.connect.bind(factory);
      factory.connect = async () => {
        const a = await connect();
        // Same pragmas as lib/db (importing lib/db here would create its client before ours is installed).
        const client = (a as unknown as { client: { pragma: (s: string) => unknown } }).client;
        for (const p of ["journal_mode = WAL", "synchronous = NORMAL", "busy_timeout = 5000", "temp_store = MEMORY", "cache_size = -20000"]) client.pragma(p);
        return a;
      };
      adapter = factory;
    }
    const base = new PrismaClient({ adapter: adapter as any, log: [{ emit: "event", level: "query" }] });
    (base as any).$on("query", (e: { duration: number; query: string }) => {
      stats.statements++;
      if (process.env.MARK_READ_BENCH_SLOW && e.duration > 50) stats.slow.push({ ms: Math.round(e.duration), sql: e.query.slice(0, 600) });
    });
    (globalThis as unknown as { prisma: unknown }).prisma = withExternalIds(base);
    db = (await import("@/lib/db")).db;
    if (PG) await db.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS pg_trgm").catch(() => {});
    const { ensureSearchIndexes } = await import("@/lib/search-indexes").catch(() => ({ ensureSearchIndexes: null as never }));
    if (typeof ensureSearchIndexes === "function") await (ensureSearchIndexes as (o?: unknown) => Promise<void>)({ backfill: "await" }).catch((e: unknown) => console.warn("search indexes", e));

    const { hashApiToken } = await import("@/lib/token");
    await db.user.create({ data: { id: "ua", email: "a@example.org", name: "A", apiFeverKey: hashApiToken(FEVER_KEY), apiPasswordHash: "x" } });
    await db.user.create({ data: { id: "ub", email: "b@example.org", name: "B" } });
    const cats = await Promise.all(["Tech", "World", "Local", "Science"].map((name, order) => db.category.create({ data: { id: `cat${order}`, name, userId: "ua", order } })));
    const feedIds: string[] = [];
    for (let i = 0; i < 200; i++) {
      await db.feed.create({ data: { id: `fa${i}`, userId: "ua", name: `Feed ${i}`, url: `https://example.com/a${i}.xml`, order: i, categoryId: cats[i % 4].id } });
      feedIds.push(`fa${i}`);
    }
    await db.feed.create({ data: { id: "big", userId: "ua", name: "Big", url: "https://example.com/big.xml", order: 999, categoryId: cats[0].id } });
    await db.feed.create({ data: { id: "fnew", userId: "ua", name: "Sync target", url: "https://example.com/new.xml", order: 1000 } });
    for (let i = 0; i < 20; i++) await db.feed.create({ data: { id: `fb${i}`, userId: "ub", name: `B ${i}`, url: `https://example.com/b${i}.xml`, order: i } });
    await db.label.create({ data: { id: "lab", userId: "ua", name: "Label" } });

    const body = "<p>Benchmark body text for an article. ".repeat(50) + "</p>";
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 50_000; i++) {
      const age = rnd() * 90 * 86400e3 + 3600e3;
      const read = rnd() < 0.1;
      if (!read) SEEDED_UNREAD_A.count++;
      rows.push({
        id: `a${String(i).padStart(6, "0")}`, feedId: i < 10_000 ? "big" : feedIds[i % 200], userId: "ua", title: `alpha ${i} ${["bravo", "charlie", "delta"][i % 3]}`,
        link: `https://example.com/a${i}`, dedupeKey: `a${i}`, content: body, excerpt: read ? "R" : "U", publishedAt: new Date(now - age),
        createdAt: new Date(now - age + 60_000), updatedAt: new Date(now - age + 60_000), isRead: read, readAt: read ? new Date(now - age) : null, isStarred: rnd() < 0.05,
      });
    }
    for (let i = 0; i < 5000; i++) {
      rows.push({
        id: `b${String(i).padStart(6, "0")}`, feedId: `fb${i % 20}`, userId: "ub", title: `alpha b${i}`, link: `https://example.com/b${i}`, dedupeKey: `b${i}`,
        content: body, excerpt: "U", publishedAt: new Date(now - i * 60_000), createdAt: new Date(now - i * 60_000), updatedAt: new Date(now - i * 60_000), isRead: false,
      });
    }
    for (let i = 0; i < rows.length; i += 2000) await db.article.createMany({ data: rows.slice(i, i + 2000) });
    const labelled = rows.filter((r, i) => r.userId === "ua" && i % 10 === 3).map((r) => ({ articleId: r.id as string, labelId: "lab", userId: "ua" }));
    for (let i = 0; i < labelled.length; i += 2000) await db.articleLabel.createMany({ data: labelled.slice(i, i + 2000) });
    await db.$executeRawUnsafe("ANALYZE");
    results.provider = PG ? "postgresql" : "sqlite";
    results.seed = { articlesA: 50_000, unreadA: SEEDED_UNREAD_A.count, articlesB: 5000, labelled: labelled.length };
  }, 900_000);

  afterAll(async () => {
    await db?.$disconnect();
    console.log("MARK_READ_BENCH_RESULTS", JSON.stringify(results, null, 2));
    if (process.env.MARK_READ_BENCH_RESULT) writeFileSync(process.env.MARK_READ_BENCH_RESULT, JSON.stringify(results, null, 2));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function reset() {
    await db.$executeRawUnsafe(`UPDATE "Article" SET "isRead" = CASE WHEN "excerpt" = 'R' THEN TRUE ELSE FALSE END, "readAt" = CASE WHEN "excerpt" = 'R' THEN "readAt" ELSE NULL END, "updatedAt" = "createdAt" WHERE "isRead" <> CASE WHEN "excerpt" = 'R' THEN TRUE ELSE FALSE END OR "updatedAt" <> "createdAt"`);
    await db.article.deleteMany({ where: { feedId: "fnew" } });
  }

  async function invariants() {
    const [unreadB, starredA, bumped] = await Promise.all([
      db.article.count({ where: { userId: "ub", isRead: false } }),
      db.article.count({ where: { userId: "ua", isStarred: true, isRead: false } }),
      db.article.count({ where: { userId: "ua", updatedAt: { gt: new Date(now + 1000) } } }),
    ]);
    return { unreadB, starredUnreadA: starredA, updatedAtBumped: bumped };
  }

  async function measure(name: string, run: () => Promise<unknown>, expectChanged?: number) {
    await reset();
    const before = await db.article.count({ where: { userId: "ua", isRead: false } });
    stats.statements = 0;
    const loop = monitorEventLoopDelay({ resolution: 5 });
    loop.enable();
    const t0 = performance.now();
    let error: string | undefined;
    let output: unknown;
    try {
      output = await run();
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 200) : String(e);
    }
    const ms = performance.now() - t0;
    loop.disable();
    const statements = stats.statements;
    const after = await db.article.count({ where: { userId: "ua", isRead: false } });
    const entry = { ms: round(ms), statements, loopMaxMs: round(loop.max / 1e6), changed: before - after, ...(error ? { error } : {}), ...(await invariants()) };
    results[name] = entry;
    console.log(name, JSON.stringify(entry));
    const slow = stats.slow.splice(0);
    if (slow.length) results[`${name}.slow`] = slow;
    if (expectChanged !== undefined && !error) expect(entry.changed).toBe(expectChanged);
    return output;
  }

  const greaderPost = async (path: string, form: Record<string, string>) => {
    const { POST } = await import("@/app/api/greader/[...path]/route");
    const res = await POST(new Request(`http://localhost/api/greader/reader/api/0/${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() }), { params: Promise.resolve({ path: ["reader", "api", "0", ...path.split("/")] }) });
    if (res.status !== 200) throw new Error(`greader ${res.status} ${await res.text()}`);
  };
  const feverPost = async (form: Record<string, string>) => {
    const { POST } = await import("@/app/api/fever/route");
    const res = await POST(new Request("http://localhost/api/fever?api", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ api_key: FEVER_KEY, ...form }).toString() }));
    const json = await res.json();
    if (json.auth !== 1) throw new Error(`fever auth ${JSON.stringify(json)}`);
  };

  it.skipIf(!PG || process.env.MARK_READ_BENCH_PAIRED !== "1")("paired: retained Article GIN versus removed Article GIN", async () => {
    const { markAllAsRead } = await import("@/app/actions/feeds");
    const { ARTICLE_TEXT_COLUMNS } = await import("@/lib/search-indexes");
    // Alternate variants on the SAME corpus. No content writes in the measured operation.
    // VACUUM outside timing drains pending GIN entries from setup/reset for both variants.
    const samples: Record<string, number[]> = { retained: [], removed: [] };
    for (const retained of [true, false, false, true, true, false]) {
      for (const column of ARTICLE_TEXT_COLUMNS) {
        await db.$executeRawUnsafe(retained
          ? `CREATE INDEX IF NOT EXISTS "Article_${column}_trgm_idx" ON "Article" USING GIN ("${column}" gin_trgm_ops)`
          : `DROP INDEX IF EXISTS "Article_${column}_trgm_idx"`);
      }
      await reset();
      await db.$executeRawUnsafe('VACUUM ANALYZE "Article"');
      await db.$executeRawUnsafe('VACUUM ANALYZE "ArticleSearch"');
      const key = retained ? "retained" : "removed";
      const name = `paired.${key}.${samples[key].length}`;
      await measure(name, () => markAllAsRead({ category: "All", cutoff: Date.now() } as never), SEEDED_UNREAD_A.count);
      samples[key].push((results[name] as { ms: number }).ms);
    }
    results.paired = Object.fromEntries(Object.entries(samples).map(([key, ms]) => [
      key, { samplesMs: ms, medianMs: [...ms].sort((a, b) => a - b)[1] },
    ]));
  }, 900_000);

  it("search: selective, broad, field and negative queries", async () => {
    const { buildAdvancedSearchWhere } = await import("@/lib/search");
    const search: Record<string, unknown> = {};
    for (const query of ["alpha 12345", "charlie", "title:12345", "-author:nobody content:Benchmark"]) {
      const samples: number[] = [];
      let count = 0;
      for (let i = 0; i < 6; i++) {
        const t = performance.now();
        const where = { AND: [{ userId: "ua" }, await buildAdvancedSearchWhere("ua", query)] };
        count = await db.article.count({ where });
        await db.article.findMany({ where, take: 50, orderBy: [{ publishedAt: "desc" }, { id: "desc" }], select: { id: true } });
        if (i) samples.push(performance.now() - t);
      }
      samples.sort((a, b) => a - b);
      search[query] = { medianMs: round(samples[2]), p95Ms: round(samples[4]), count };
    }
    results.search = search;
  }, 900_000);

  it("UI: mark all read (all / big feed / category / label / search)", async () => {
    state.user = "ua";
    const { markAllAsRead } = await import("@/app/actions/feeds");
    const cutoff = Date.now();
    await measure("ui.markAll.all", () => markAllAsRead({ category: "All", cutoff } as never));
    await measure("ui.markAll.bigFeed", () => markAllAsRead({ feedId: "big", cutoff } as never));
    await measure("ui.markAll.category", () => markAllAsRead({ category: "Category:", categoryId: "cat1", cutoff } as never));
    await measure("ui.markAll.label", () => markAllAsRead({ category: "Label:lab", cutoff } as never));
    await measure("ui.markAll.search", () => markAllAsRead({ category: "All Articles", search: "charlie", cutoff } as never));
  }, 900_000);

  it("UI: undo of a 45 k mark-all", async () => {
    state.user = "ua";
    const { markAllAsRead, markArticlesAsUnread } = await import("@/app/actions/feeds");
    await reset();
    const result = (await markAllAsRead({ category: "All", cutoff: Date.now() } as never)) as { undoToken: string | null };
    stats.statements = 0;
    const t0 = performance.now();
    let error: string | undefined;
    try {
      if (!result.undoToken) throw new Error("no undo token");
      await markArticlesAsUnread(result.undoToken);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const unread = await db.article.count({ where: { userId: "ua", isRead: false } });
    results["ui.undo.all"] = { ms: round(performance.now() - t0), statements: stats.statements, restoredTo: unread, ...(error ? { error } : {}) };
    console.log("ui.undo.all", JSON.stringify(results["ui.undo.all"]));
  }, 900_000);

  it("UI: mark up to here (range over the whole 10 k big feed)", async () => {
    state.user = "ua";
    const { markListRangeRead } = await import("@/app/actions/article-state");
    const newest = await db.article.findFirst({ where: { feedId: "big" }, orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }], select: { id: true } });
    const oldest = await db.article.findFirst({ where: { feedId: "big" }, orderBy: [{ publishedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }], select: { id: true } });
    await measure("ui.range.bigFeed", () => markListRangeRead({ listKey: "/?feed=big", sort: "new", fromId: newest.id, toId: oldest.id, maxCreatedAt: Date.now(), extraIds: [] }));
  }, 900_000);

  it("API: GReader / Fever / REST v1 / MCP", async () => {
    state.user = "ua";
    const ts = String(Date.now() * 1000);
    await measure("greader.markAll.readingList", () => greaderPost("mark-all-as-read", { s: "user/-/state/com.google/reading-list", ts }));
    await measure("greader.markAll.bigFeed", async () => {
      const feed = await db.feed.findUnique({ where: { id: "big" }, select: { extId: true } });
      const { decimalExternalId } = await import("@/lib/external-ids");
      await greaderPost("mark-all-as-read", { s: `feed/${decimalExternalId(feed.extId)}`, ts });
    });
    await measure("fever.group0", () => feverPost({ mark: "group", as: "read", id: "0", before: String(Math.floor(Date.now() / 1000)) }));
    await measure("v1.markAll", async () => {
      const route = await import("@/app/api/v1/[...path]/route");
      const res = await route.POST(new Request("http://localhost/api/v1/articles/mark-all-read", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ path: ["articles", "mark-all-read"] }) });
      if (res.status !== 200) throw new Error(`v1 ${res.status} ${await res.text()}`);
    });
    await measure("mcp.markAll", async () => {
      const { POST } = await import("@/app/api/mcp/route");
      const res = await POST(new Request("http://localhost/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "feedferret.mark_all_read", arguments: {} } }) }));
      const json = await res.json();
      if (json.result?.isError) throw new Error(`mcp ${JSON.stringify(json.result)}`);
    });
  }, 900_000);

  it("concurrency: a sync inserts new articles while mark-all runs", async () => {
    state.user = "ua";
    const { markAllAsRead } = await import("@/app/actions/feeds");
    await reset();
    const cutoff = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    let running = true;
    const latencies: number[] = [];
    const updateLatencies: number[] = [];
    let n = 0;
    // Sync-like writer: inserts new items (after the cutoff) and rewrites an existing unread item
    // of the view (upstream content change) — the second one needs the row lock mark-all takes.
    const writer = (async () => {
      while (running) {
        const t0 = performance.now();
        const batch = Array.from({ length: 20 }, () => ({ id: `new${n}`, feedId: "fnew", userId: "ua", title: `new ${n}`, link: `https://example.com/new${n}`, dedupeKey: `new${n++}`, content: "<p>new</p>", publishedAt: new Date(now - 30 * 86400e3), isRead: false }));
        await db.article.createMany({ data: batch });
        latencies.push(performance.now() - t0);
        const t1 = performance.now();
        await db.article.updateMany({ where: { id: `a${String(40_000 + (n % 9000)).padStart(6, "0")}` }, data: { title: `changed ${n}` } });
        updateLatencies.push(performance.now() - t1);
        await new Promise((r) => setTimeout(r, 10));
      }
    })();
    await new Promise((r) => setTimeout(r, 30));
    const t0 = performance.now();
    let error: string | undefined;
    try {
      await markAllAsRead({ category: "All", cutoff } as never);
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 200) : String(e);
    }
    const ms = performance.now() - t0;
    running = false;
    await writer;
    const inserted = await db.article.count({ where: { feedId: "fnew" } });
    const newMarked = await db.article.count({ where: { feedId: "fnew", isRead: true } });
    latencies.sort((a, b) => a - b);
    results["concurrency.markAllWithSync"] = {
      ms: round(ms), inserted, newMarkedRead: newMarked, insertBatches: latencies.length,
      insertP50: round(latencies[Math.floor(latencies.length / 2)] ?? 0), insertMax: round(latencies[latencies.length - 1] ?? 0),
      syncUpdateMax: round(Math.max(0, ...updateLatencies)), ...(error ? { error } : {}),
    };
    console.log("concurrency", JSON.stringify(results["concurrency.markAllWithSync"]));
  }, 900_000);

  it("concurrency: two overlapping mark-alls + a sync rewriting rows in reverse id order", async () => {
    state.user = "ua";
    const { markAllAsRead } = await import("@/app/actions/feeds");
    await reset();
    const cutoff = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    // Sync-like writer: transactions that update 50 unread rows of the big feed in DESCENDING id order
    // (the opposite of the bulk writer's lock order) — the classic deadlock partner.
    const victims = (await db.article.findMany({ where: { feedId: "big", isRead: false }, select: { id: true }, orderBy: { id: "desc" }, take: 2000 })).map((a: { id: string }) => a.id);
    let running = true;
    let syncTx = 0;
    const syncErrors: string[] = [];
    const sync = (async () => {
      for (let i = 0; running; i = (i + 50) % victims.length) {
        try {
          await db.$transaction(async (tx: typeof db) => {
            for (const id of victims.slice(i, i + 50)) await tx.article.updateMany({ where: { id }, data: { title: `sync ${i}`, updatedAt: new Date(now) } });
          }, { timeout: 30_000 });
          syncTx++;
        } catch (e) {
          syncErrors.push(e instanceof Error ? e.message.slice(0, 120) : String(e));
        }
      }
    })();
    const warn = vi.spyOn(console, "warn");
    const t0 = performance.now();
    const outcomes = await Promise.allSettled([markAllAsRead({ category: "All", cutoff } as never), markAllAsRead({ feedId: "big", cutoff } as never), markAllAsRead({ category: "Category:", categoryId: "cat0", cutoff } as never)]);
    const ms = performance.now() - t0;
    running = false;
    await sync;
    const counts = outcomes.map((o) => (o.status === "fulfilled" ? (o.value as { count: number; incomplete?: true }) : { error: String((o as PromiseRejectedResult).reason).slice(0, 160) }));
    const changedTotal = counts.reduce((sum, c) => sum + ("count" in c ? c.count : 0), 0);
    const left = await db.article.count({ where: { userId: "ua", isRead: false, createdAt: { lte: new Date(cutoff) } } });
    const chunkRetries = warn.mock.calls.filter((c) => c.some((part: unknown) => typeof part === "string" && part.includes("[bulk-read] chunk aborted"))).length;
    warn.mockRestore();
    results["concurrency.overlapping"] = { ms: round(ms), chunkRetries, outcomes: counts, changedTotal, unreadLeftBeforeCutoff: left, syncTx, syncErrors: syncErrors.slice(0, 3), syncErrorCount: syncErrors.length };
    console.log("overlapping", JSON.stringify(results["concurrency.overlapping"]));
    expect(outcomes.every((o) => o.status === "fulfilled" && !(o.value as { incomplete?: true }).incomplete)).toBe(true);
    // RETURNING attributes each row to exactly one of the overlapping calls.
    expect(changedTotal).toBe(SEEDED_UNREAD_A.count);
    expect(left).toBe(0);
  }, 900_000);
});
