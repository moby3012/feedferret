// K1 perf: clustering cost on a 5k-article / 48 h window (real SQLite file).
// Budget: an incremental tick of 200 new articles must fit the 400 ms tick
// budget (CI runners are slower and noisy → 4× slack there; locally strict).
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
const BUDGET_MS = process.env.CI ? 1_600 : 400;
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

    // --- incremental ticks: 3 × 200 new articles (≈ 40 % further sources of known stories);
    // the median resists one noisy sample on a shared machine.
    expect(NEW_ARTICLES).toBeLessThanOrEqual(PENDING_BATCH); // one round of the real tick
    const samples: number[] = [];
    let attached = 0;
    for (let k = 0; k < 3; k++) {
      await insert(buildSeeds(NEW_ARTICLES, `n${k}`, 0.4, 1.5, k * 0.5));
      const t0 = performance.now();
      const tick = await clusterUser(userId, { budgetMs: 400, now: NOW });
      samples.push(performance.now() - t0);
      expect(tick.processed).toBe(NEW_ARTICLES);
      expect(tick.morePending).toBe(false);
      attached += tick.joined + tick.created;
    }
    const sorted = [...samples].sort((a, b) => a - b);
    timings.incrementalTickMsAll = samples.map((x) => Math.round(x)).join("/");
    timings.incrementalTickMedianMs = Math.round(sorted[1]);
    timings.incrementalAttachedTotal = attached;
    expect(sorted[1]).toBeLessThan(BUDGET_MS);
  }, 120_000);

  it("pure engine: 200 pending against a 5k window", async () => {
    const rows = await state.db.article.findMany({
      where: { userId, publishedAt: { gte: new Date(NOW - 48 * H) } },
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
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      const engine = new ClusterEngine(pending, window, []);
      engine.step(Infinity);
      runs.push(performance.now() - t0);
    }
    runs.sort((a, b) => a - b);
    timings.engineMedianMs = Math.round(runs[2]);
    timings.engineMaxMs = Math.round(runs[4]);
    expect(runs[2]).toBeLessThan(CI_ENGINE_BUDGET);
  });
});

const CI_ENGINE_BUDGET = process.env.CI ? 600 : 150;
