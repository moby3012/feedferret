// Opt-in benchmark (PERF_WAVE2_BENCH=1): server behaviour at scale on a disposable SQLite DB (or Postgres, see PERF_BENCH_DATABASE_URL).
//
//   PERF_WAVE2_BENCH=1 [PERF_BENCH_RESULT=/tmp/out.json] npx vitest run tests/perf-wave2-benchmark.test.ts
//
// Seeds 1 user / 200 feeds / 50 k articles (6 k unread) and measures
//   1. GReader `unread-count` and `stream/contents` (route handler, no HTTP),
//   2. story clustering passes over a 5 k-article 48 h window + 800 pending,
//   3. request latency / event-loop delay while a background sync tick runs
//      (200 feeds served by an in-process HTTP server, cold + steady tick).
// Never runs in the normal suite and never touches DATABASE_URL (own temp DB).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const ENABLED = process.env.PERF_WAVE2_BENCH === "1";
const dir = ENABLED ? mkdtempSync(join(tmpdir(), "perf-wave2-")) : "";
if (ENABLED) {
  // PERF_BENCH_DATABASE_URL=postgresql://… runs the same benchmark on a disposable Postgres
  // (the schema is force-reset!); default is a temp SQLite file.
  process.env.DATABASE_PROVIDER = process.env.PERF_BENCH_DATABASE_URL ? "postgresql" : "sqlite";
  process.env.DATABASE_URL = process.env.PERF_BENCH_DATABASE_URL ?? `file:${join(dir, "bench.db")}`;
  process.env.TRUSTED_FEED_FETCHING = "true";
  process.env.DISABLE_BACKGROUND_SYNC = "true";
}

vi.mock("@/lib/greader", async (original) => ({
  ...(await original<typeof import("@/lib/greader")>()),
  authenticateGReaderRequest: vi.fn(async () => ({ id: "bench-user", email: "bench@example.org" })),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => ({ success: true }), getClientIdentifier: () => "u", RATE_LIMITS: { greader: {} } }));

const results: Record<string, unknown> = {};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const round = (n: number) => Math.round(n * 10) / 10;

let seedState = 12345;
const rnd = () => ((seedState = (seedState * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];

const FILLER = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey".split(" ");
const STORY_WORDS = Array.from({ length: 1800 }, (_, i) => `${["wahl", "markt", "klima", "energie", "satellit", "impfstoff", "fusion", "gesetz", "streik", "gipfel", "bericht", "studie"][i % 12]}${Math.floor(i / 12)}`);

describe.skipIf(!ENABLED)("wave-2 performance benchmark (50 k articles)", () => {
  let server: Server;
  let port = 0;
  const feedIds: string[] = [];

  beforeAll(async () => {
    execFileSync("node", ["scripts/prepare-prisma-schema.mjs"], { env: process.env, stdio: "pipe" });
    execFileSync("npx", ["prisma", "db", "push", "--schema", "prisma/schema.generated.prisma", "--accept-data-loss", ...(process.env.PERF_BENCH_DATABASE_URL ? ["--force-reset"] : [])], { env: process.env, stdio: "pipe" });
    const { db } = await import("@/lib/db");
    // Boot does this once in instrumentation.ts (first JSDOM window = ~300 ms stall otherwise).
    await (await import("@/lib/sanitize-html")).warmSanitizer();
    const { computeStorySig, serializeSig } = await import("@/lib/story-clustering/normalize");
    const now = Date.now();
    await db.user.create({ data: { id: "bench-user", email: "bench@example.org", name: "Bench", role: "ADMIN", storyClustering: true } });
    const cats = await Promise.all(["Tech", "World", "Local", "Science"].map((name, order) => db.category.create({ data: { name, userId: "bench-user", order } })));

    // In-process feed server (200 feeds x 20 items, GUIDs unique per tick via ?gen=).
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const m = /^\/f(\d+)\.xml$/.exec(url.pathname);
      if (!m) return void res.writeHead(404).end();
      const gen = url.searchParams.get("gen") ?? "0";
      const items = Array.from({ length: 20 }, (_, i) => {
        const guid = `f${m[1]}-g${gen === "0" ? "static" : gen}-${i}`;
        const title = `${pick(STORY_WORDS)} ${pick(STORY_WORDS)} ${pick(STORY_WORDS)} ${pick(FILLER)} item ${i}`;
        return `<item><title>${title}</title><link>https://example.com/${guid}</link><guid isPermaLink="false">${guid}</guid><pubDate>${new Date(now - i * 60000).toUTCString()}</pubDate><description>${"<p>Lorem ipsum dolor sit amet.</p>".repeat(6)}</description></item>`;
      });
      res.writeHead(200, { "content-type": "application/rss+xml" }).end(`<?xml version="1.0"?><rss version="2.0"><channel><title>F${m[1]}</title><link>https://example.com</link>${items.join("")}</channel></rss>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;

    for (let i = 0; i < 200; i++) {
      const f = await db.feed.create({
        data: {
          id: `bf${i}`, userId: "bench-user", name: `Feed ${i}`, url: `http://127.0.0.1:${port}/f${i}.xml?gen=0`, order: i,
          categoryId: cats[i % cats.length].id, lastFetchedAt: new Date(now - 3600_000), lastStatus: "ok", updateFrequency: 1,
        },
      });
      feedIds.push(f.id);
    }

    // 50 k articles over 120 days (recent-skewed); last 48 h left pending.
    const body = "<p>Benchmark body text for an article. ".repeat(40) + "</p>";
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 50_000; i++) {
      // Exactly 5 800 articles land in the last 48 h (5 000 processed + 800 pending): a window just
      // below the job's 6 000-row cap; the rest of the library is older.
      const age = i < 5800 ? rnd() * 47 * 3600e3 : 49 * 3600e3 + rnd() ** 1.3 * 120 * 86400e3;
      const pub = now - age;
      const ageD = age / 86400e3;
      const read = rnd() < (ageD < 7 ? 0.45 : 0.93);
      const id = `ba-${String(i).padStart(6, "0")}`;
      const inWindow = age < 48 * 3600e3;
      const feedId = pick(feedIds);
      const title = inWindow ? `${pick(STORY_WORDS)} ${pick(STORY_WORDS)} ${pick(STORY_WORDS)} ${pick(FILLER)} ${pick(FILLER)}` : `${pick(FILLER)} ${pick(FILLER)} ${i}`;
      rows.push({
        id, feedId, userId: "bench-user", title, link: `https://example.com/${id}`, dedupeKey: id, content: body, excerpt: "Benchmark excerpt",
        publishedAt: new Date(pub), createdAt: new Date(pub + 600_000), updatedAt: new Date(pub + 600_000), isRead: read,
        isStarred: rnd() < 0.05, isReadLater: rnd() < 0.02, readMinutes: 2, clusteredAt: inWindow ? null : new Date(pub),
      });
    }
    for (let i = 0; i < rows.length; i += 2000) await db.article.createMany({ data: rows.slice(i, i + 2000) as never });

    // Clustering fixture: boost the 48 h window to ~5 k *processed* articles (with signatures and
    // 400 clusters) plus 800 pending ones that the job still has to process.
    const recent = await db.article.findMany({ where: { userId: "bench-user", publishedAt: { gte: new Date(now - 48 * 3600e3) } }, select: { id: true, title: true, feedId: true, publishedAt: true }, orderBy: { id: "asc" } });
    const processed = recent.slice(0, Math.max(0, recent.length - 800));
    for (let i = 0; i < processed.length; i += 300) {
      const chunk = processed.slice(i, i + 300);
      await db.$transaction(chunk.map((a, k) => {
        const sig = computeStorySig({ title: a.title, excerpt: null, content: null, link: `https://example.com/${a.id}`, feedName: null, feedPriority: "main", imageUrl: null, readMinutes: 2, isDuplicate: false });
        return db.article.updateMany({ where: { id: a.id }, data: { storySig: serializeSig(sig), clusteredAt: a.publishedAt, updatedAt: a.publishedAt } });
      }));
    }
    results.seed = { articles: await db.article.count(), unread: await db.article.count({ where: { isRead: false } }), feeds: 200, windowProcessed: processed.length, pending: recent.length - processed.length };
    // Planner statistics like a warmed-up install (R1).
    await db.$executeRawUnsafe("ANALYZE");
  }, 600_000);

  afterAll(async () => {
    server?.close();
    const { db } = await import("@/lib/db");
    await db.$disconnect();
    console.log("PERF_WAVE2_RESULTS", JSON.stringify(results, null, 2));
    if (process.env.PERF_BENCH_RESULT) writeFileSync(process.env.PERF_BENCH_RESULT, JSON.stringify(results, null, 2));
    rmSync(dir, { recursive: true, force: true });
  });

  async function greader(path: string, query = "") {
    const { GET } = await import("@/app/api/greader/[...path]/route");
    const response = await GET(new Request(`http://localhost/api/greader/reader/api/0/${path}${query}`), { params: Promise.resolve({ path: ["reader", "api", "0", ...path.split("/")] }) });
    const text = await response.text();
    return { status: response.status, bytes: text.length, body: text };
  }

  it("GReader unread-count / stream/contents", async () => {
    await greader("unread-count?output=json"); // warm-up
    const t: number[] = [];
    let last = { status: 0, bytes: 0, body: "" };
    for (let i = 0; i < 15; i++) {
      const s = performance.now();
      last = await greader("unread-count", "?output=json");
      t.push(performance.now() - s);
    }
    expect(last.status).toBe(200);
    results.unreadCount = { medianMs: round(median(t)), p95Ms: round(pct(t, 0.95)), bytes: last.bytes, entries: JSON.parse(last.body).unreadcounts.length };
    const c: number[] = [];
    let contents = { status: 0, bytes: 0, body: "" };
    for (let i = 0; i < 5; i++) {
      const s = performance.now();
      contents = await greader("stream/contents/user/-/state/com.google/reading-list", "?n=1000&output=json");
      c.push(performance.now() - s);
    }
    results.streamContentsN1000 = { medianMs: round(median(c)), bytes: contents.bytes, items: JSON.parse(contents.body).items.length };
  }, 120_000);

  it("story clustering passes over a large window", async () => {
    const { runStoryClustering } = await import("@/lib/story-clustering/job");
    const passes: { ms: number; processed: number }[] = [];
    const wall = performance.now();
    for (let i = 0; i < 100; i++) {
      const s = performance.now();
      const r = await runStoryClustering({ budgetMs: 400 });
      passes.push({ ms: performance.now() - s, processed: r.processed });
      if (!r.morePending) break;
    }
    const total = passes.reduce((a, p) => a + p.processed, 0);
    results.clustering = {
      passes: passes.length, processed: total, wallMs: Math.round(performance.now() - wall),
      medianPassMs: round(median(passes.map((p) => p.ms))), maxPassMs: round(Math.max(...passes.map((p) => p.ms))),
    };
    expect(total).toBeGreaterThan(0);
  }, 600_000);

  for (const phase of ["cold tick (new items)", "steady tick (nothing new)"]) {
    it(`request latency during a background sync: ${phase}`, async () => {
      const { db } = await import("@/lib/db");
      const { syncAllFeeds } = await import("@/lib/rss-sync");
      // cold: first run of GUID generation 1 (all items new); steady: same generation again (nothing new).
      const generation = "1";
      for (let i = 0; i < 200; i++) {
        await db.feed.update({ where: { id: `bf${i}` }, data: { url: `http://127.0.0.1:${port}/f${i}.xml?gen=${generation}`, lastFetchedAt: new Date(Date.now() - 3600_000) } });
      }
      const latencies: number[] = [];
      const h = monitorEventLoopDelay({ resolution: 5 });
      h.enable();
      let running = true;
      const probe = (async () => {
        while (running) {
          // Latency a request would see: timer lateness (event loop busy) + the list query itself.
          const due = performance.now() + 25;
          await new Promise((r) => setTimeout(r, 25));
          const s = performance.now();
          await db.article.findMany({ where: { userId: "bench-user", isRead: false }, orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }], take: 50, select: { id: true, title: true, feedId: true } });
          latencies.push(Math.max(0, s - due) + (performance.now() - s));
        }
      })();
      const s = performance.now();
      const out = await syncAllFeeds();
      const tickMs = performance.now() - s;
      running = false;
      await probe;
      h.disable();
      results[phase] = {
        tickMs: Math.round(tickMs), feeds: out.length, synced: out.filter((r: { success: boolean; skipped?: boolean }) => r.success && !r.skipped).length,
        probes: latencies.length, p50Ms: round(median(latencies)), p95Ms: round(pct(latencies, 0.95)), p99Ms: round(pct(latencies, 0.99)), maxMs: round(Math.max(...latencies)),
        loopDelayP99Ms: round(h.percentile(99) / 1e6), loopDelayMaxMs: round(h.max / 1e6),
      };
      expect(out.length).toBe(200);
    }, 300_000);
  }
});
