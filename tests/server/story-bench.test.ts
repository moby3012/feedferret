// K1 perf: clustering cost on a 5k-article / 48 h window (real SQLite file).
// Budget: an incremental tick of 200 new articles must fit the 400 ms tick
// budget of the reference machine (a laptop; ≈ 170 ms CPU there), which is
// ≈ 3× a fixed calibration workload on that machine. The gate is 5× (a
// regression of 1.6× fails), the engine's 0.8× (typical 0.5×).
//
// Speed-independent by construction: a fixed absolute number is either too
// tight for a slow CI runner (flaky) or too loose on a fast laptop (a 2×
// slowdown goes unnoticed). So every measurement is
//   · CPU time (process.cpuUsage: the work is synchronous in this file's own
//     process, so a busy machine does not inflate it much),
//   · the FLOOR of several samples (interference only ever adds time), and
//   · expressed as a MULTIPLE of the floor of `referenceCpuMs()`, a fixed
//     workload of the same kind (JS + the same SQLite path) run in this
//     process right before each sample.
// A slower or busier machine slows the reference by the same factor; a
// regression in the code under test does not. Measured ratios were the same
// within ±8 % on a quiet machine and with 24 / 60 busy-looping processes
// competing for 12 cores (tick 2.9–3.3, engine 0.46–0.57).
// Wall-clock is checked only on request (quiet machine): STORY_BENCH_STRICT=1
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
  getDatabaseProvider: () => "sqlite",
}));

import { clusterUser, PENDING_BATCH } from "../../lib/story-clustering/job";
import { ClusterEngine } from "../../lib/story-clustering/engine";
import { computeStorySig } from "../../lib/story-clustering/normalize";
import type { PendingItem, WindowItem } from "../../lib/story-clustering/types";

const dir = mkdtempSync(join(tmpdir(), "feedferret-story-bench-"));
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const H = 3_600_000;
const WINDOW_ARTICLES = 5_000;
const NEW_ARTICLES = 200;
/** Regression gate, as multiples of `referenceCpuMs()` measured right before (see the header). */
const TICK_RATIO = Number(process.env.STORY_BENCH_TICK_RATIO ?? 5);
const ENGINE_RATIO = Number(process.env.STORY_BENCH_ENGINE_RATIO ?? 0.8);
/** Opt-in: also hold the wall-clock time to the reference machine's budgets (quiet machine only). */
const STRICT = process.env.STORY_BENCH_STRICT === "1";
const STRICT_TICK_MS = 400;
const STRICT_ENGINE_MS = 150;
/** The job's own wall-clock budget: generous, so machine load can never stop a tick early (processed < batch). */
const JOB_BUDGET_MS = 30_000;
/** CPU time of this process in ms (user + system, all its threads). */
const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
/** Interference (other processes, GC, SMT neighbours) only ever ADDS time; a real regression raises the floor too. */
const floor = (xs: number[]) => Math.min(...xs);

/**
 * Fixed calibration workload, independent of the code under test (own PRNG and SQL, a scratch table): tokenising
 * / Set intersection / Map counting / sorting / JSON round-trips (what the clustering engine does) and batched
 * inserts + indexed selects through the same Prisma / SQLite adapter path as the job. The mix matters: CPU
 * speed, cache pressure and the native SQLite share all move together on a slow or busy machine, so the ratio
 * of the job to this stays put while a plain-JS-only reference would drift.
 * Returns its CPU time in ms: the best of a few repetitions, so a noisy sample cannot inflate the budget.
 */
async function referenceCpuMs(): Promise<number> {
  const one = async (round: number) => {
    let x = 12345 + round;
    const next = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0);
    const words = Array.from({ length: 600 }, (_, i) => `w${(i * 7919) % 997}${"abc"[i % 3]}`);
    const docs = Array.from({ length: 700 }, () => Array.from({ length: 8 }, () => words[next() % words.length]).join(" "));
    const sets = docs.map((d) => new Set(d.split(" ")));
    let acc = 0;
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < Math.min(i + 120, sets.length); j++) {
        let inter = 0;
        for (const w of sets[i]) if (sets[j].has(w)) inter++;
        acc += inter / (sets[i].size + sets[j].size - inter);
      }
    }
    const counts = new Map<string, number>();
    for (const d of docs) for (const w of d.split(" ")) counts.set(w, (counts.get(w) ?? 0) + 1);
    acc += [...counts.values()].sort((a, b) => b - a)[0];
    acc += JSON.parse(JSON.stringify(docs.map((d, i) => ({ i, t: d.split(" "), h: next() })))).length;
    await state.db.$executeRawUnsafe("DELETE FROM bench_ref");
    for (let batch = 0; batch < 20; batch++) {
      const params: string[] = [];
      for (let i = 0; i < 100; i++) params.push(`k${(batch * 100 + i) % 200}`, docs[(batch * 100 + i) % docs.length]);
      await state.db.$executeRawUnsafe(`INSERT INTO bench_ref (k, v) VALUES ${"(?, ?),".repeat(100).slice(0, -1)}`, ...params);
    }
    for (let i = 0; i < 200; i++) acc += (await state.db.$queryRawUnsafe<unknown[]>("SELECT id, v FROM bench_ref WHERE k = ?", `k${i}`)).length;
    return acc;
  };
  const once = async () => {
    let acc = 0;
    for (let round = 0; round < 2; round++) acc += await one(round);
    return acc;
  };
  await once(); // warm-up: JIT, statement cache
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const c0 = cpuMs();
    await once();
    best = Math.min(best, cpuMs() - c0);
  }
  return best;
}
const FEEDS = 40;

// Deterministic RNG + zipf-ish vocabulary of pseudo words.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(42);
const SYL = ["ka", "bo", "le", "mu", "ri", "to", "sa", "ne", "vi", "do", "pa", "gu", "he", "zo", "fi", "lu"];
const VOCAB = Array.from({ length: 4000 }, (_, i) => {
  let w = "";
  let n = i + 17;
  for (let k = 0; k < 3 || n > 0; k++, n = Math.floor(n / SYL.length)) w += SYL[n % SYL.length];
  return w + "x".repeat(i % 3);
});
const zipf = () => VOCAB[Math.floor(Math.pow(rand(), 2.2) * VOCAB.length)];
const headline = () => Array.from({ length: 6 + Math.floor(rand() * 4) }, zipf).join(" ");
/** Another outlet's wording of the same story: keeps ~70 % of the words, adds 2 new ones. */
const reword = (h: string) => {
  const w = h.split(" ").filter(() => rand() < 0.75);
  return [...w, zipf(), zipf()].sort(() => rand() - 0.5).join(" ");
};

interface Seed {
  id: string;
  feedId: string;
  title: string;
  hoursAgo: number;
}
let userId = "";
let feedIds: string[] = [];
const stories: string[] = [];
const timings: Record<string, number | string> = {};

function buildSeeds(count: number, prefix: string, storyShare: number, hoursSpan: number, hoursOffset = 0): Seed[] {
  const out: Seed[] = [];
  let i = 0;
  while (out.length < count) {
    const hoursAgo = hoursOffset + rand() * hoursSpan;
    const reuse = stories.length > 0 && rand() < storyShare;
    const title = reuse ? reword(stories[Math.floor(rand() * stories.length)]) : headline();
    if (!reuse) stories.push(title);
    out.push({ id: `${prefix}-${i}`, feedId: feedIds[Math.floor(rand() * FEEDS)], title, hoursAgo });
    i++;
  }
  return out;
}

const insert = (seeds: Seed[]) =>
  state.db.article.createMany({
    data: seeds.map((s) => ({
      id: s.id,
      userId,
      feedId: s.feedId,
      title: s.title,
      link: `https://example.test/${s.id}`,
      content: `<p>${s.title}</p>`,
      excerpt: s.title,
      publishedAt: new Date(NOW - s.hoursAgo * H),
    })),
  });

beforeAll(async () => {
  const url = `file:${join(dir, "bench.db")}`;
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.generated.prisma"], {
    env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: url },
    stdio: "pipe",
  });
  state.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  await state.db.$executeRawUnsafe("CREATE TABLE bench_ref (id INTEGER PRIMARY KEY, k TEXT NOT NULL, v TEXT NOT NULL)");
  await state.db.$executeRawUnsafe("CREATE INDEX bench_ref_k ON bench_ref (k)");
  userId = (await state.db.user.create({ data: { email: "bench@test" } })).id;
  feedIds = [];
  for (let f = 0; f < FEEDS; f++) feedIds.push((await state.db.feed.create({ data: { name: `Feed ${f}`, url: `https://f${f}.test/rss`, userId } })).id);
}, 60_000);

afterAll(async () => {
  console.log(`[story-bench] ${JSON.stringify(timings)}`);
  await state.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("story clustering performance (5k articles / 48 h, SQLite)", () => {
  it("backfills a 5k window in bounded rounds, then an incremental tick of 200 fits the 400 ms budget", async () => {
    const window = buildSeeds(WINDOW_ARTICLES, "w", 0.2, 46, 1);
    for (let i = 0; i < window.length; i += 1000) await insert(window.slice(i, i + 1000));

    // --- first-run backfill: repeated bounded rounds (what drainStoryClustering does)
    const backfillStart = performance.now();
    let rounds = 0;
    let maxRound = 0;
    for (;;) {
      const t0 = performance.now();
      const r = await clusterUser(userId, { budgetMs: 400, now: NOW });
      maxRound = Math.max(maxRound, performance.now() - t0);
      if (r.processed === 0) break;
      rounds++;
    }
    timings.backfillTotalMs = Math.round(performance.now() - backfillStart);
    timings.backfillRounds = rounds;
    timings.backfillMaxRoundMs = Math.round(maxRound);
    expect(await state.db.article.count({ where: { userId, clusteredAt: null } })).toBe(0);
    const clusters = await state.db.storyCluster.count({ where: { userId } });
    const clustered = await state.db.article.count({ where: { userId, clusterId: { not: null } } });
    timings.windowClusters = clusters;
    timings.windowClusteredArticles = clustered;
    expect(clusters).toBeGreaterThan(50);

    // --- incremental ticks: 5 × 200 new articles (≈ 40 % further sources of known stories);
    // the median resists one noisy sample on a shared machine.
    expect(NEW_ARTICLES).toBeLessThanOrEqual(PENDING_BATCH); // one round of the real tick
    const samples: number[] = [];
    const refs: number[] = [];
    const walls: number[] = [];
    let attached = 0;
    for (let k = 0; k < 5; k++) {
      await insert(buildSeeds(NEW_ARTICLES, `n${k}`, 0.4, 1.5, k * 0.5));
      refs.push(await referenceCpuMs());
      const c0 = cpuMs();
      const t0 = performance.now();
      // Generous job budget: a loaded machine must not stop the tick early (processed < batch);
      // the assertion below is on the CPU time the tick needed.
      const tick = await clusterUser(userId, { budgetMs: JOB_BUDGET_MS, now: NOW });
      walls.push(performance.now() - t0);
      samples.push(cpuMs() - c0);
      expect(tick.processed).toBe(NEW_ARTICLES);
      expect(tick.morePending).toBe(false);
      attached += tick.joined + tick.created;
    }
    const ratios = samples.map((x, i) => x / refs[i]);
    const tickRatio = floor(samples) / floor(refs);
    timings.incrementalTickCpuMsAll = samples.map((x) => Math.round(x)).join("/");
    timings.incrementalTickWallMsAll = walls.map((x) => Math.round(x)).join("/");
    timings.referenceCpuMsAll = refs.map((x) => Math.round(x)).join("/");
    timings.incrementalTickRatioAll = ratios.map((x) => x.toFixed(2)).join("/");
    timings.incrementalTickRatio = Number(tickRatio.toFixed(2));
    timings.incrementalAttachedTotal = attached;
    expect(tickRatio).toBeLessThan(TICK_RATIO);
    if (STRICT) expect(median(walls)).toBeLessThan(STRICT_TICK_MS);
  }, 120_000);

  it("pure engine: 200 pending against a 5k window", async () => {
    const rows = await state.db.article.findMany({
      // Only rows the job has signed (independent of how the previous test ended).
      where: { userId, publishedAt: { gte: new Date(NOW - 48 * H) }, storySig: { not: null } },
      select: { id: true, feedId: true, publishedAt: true, clusterId: true, storySig: true, title: true },
    });
    const window: WindowItem[] = rows.map((r) => ({ id: r.id, feedId: r.feedId, publishedAt: r.publishedAt.getTime(), clusterId: r.clusterId, sig: JSON.parse(r.storySig!) }));
    const pending: PendingItem[] = Array.from({ length: 200 }, (_, i) => ({
      id: `e-${i}`,
      feedId: feedIds[i % FEEDS],
      publishedAt: NOW - (i % 30) * H,
      sig: computeStorySig({ title: i % 2 ? reword(stories[i % stories.length]) : headline() }),
    }));
    const runs: number[] = [];
    const refs: number[] = [];
    const walls: number[] = [];
    for (let k = 0; k < 7; k++) {
      refs.push(await referenceCpuMs());
      const c0 = cpuMs();
      const t0 = performance.now();
      const engine = new ClusterEngine(pending, window, []);
      engine.step(Infinity);
      walls.push(performance.now() - t0);
      runs.push(cpuMs() - c0);
    }
    const ratios = runs.map((x, i) => x / refs[i]);
    const engineRatio = floor(runs) / floor(refs);
    timings.engineCpuMsAll = runs.map((x) => Math.round(x)).join("/");
    timings.engineWallMedianMs = Math.round(median(walls));
    timings.engineRatioAll = ratios.map((x) => x.toFixed(2)).join("/");
    timings.engineRatio = Number(engineRatio.toFixed(2));
    expect(engineRatio).toBeLessThan(ENGINE_RATIO);
    if (STRICT) expect(median(walls)).toBeLessThan(STRICT_ENGINE_MS);
  }, 120_000);
});

