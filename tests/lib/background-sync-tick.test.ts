// Background sync tick (audit R5): bounded post-sync jobs run one after the other inside the tick,
// digest / notifications / retention run in an off-tick lane; every job is time-boxed, isolated from
// the others' failures and single-flight, so a hanging job can never stop feed sync.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  order: [] as string[], active: 0, maxActive: 0, delayMs: 0, failing: new Set<string>(),
  hanging: new Set<string>(), releases: [] as Array<() => void>,
}));

function job(name: string) {
  return vi.fn(async () => {
    calls.order.push(`${name}:start`);
    if (calls.hanging.has(name)) {
      // Never settles on its own (tarpit endpoint); the test can release it at the end.
      await new Promise<void>((resolve) => calls.releases.push(resolve));
      calls.order.push(`${name}:released`);
      return undefined;
    }
    calls.active++;
    calls.maxActive = Math.max(calls.maxActive, calls.active);
    if (calls.delayMs) await new Promise((r) => setTimeout(r, calls.delayMs));
    calls.active--;
    calls.order.push(`${name}:end`);
    if (calls.failing.has(name)) throw new Error(`${name} exploded`);
    return name === "retention" ? { usersProcessed: 1, deleted: 0 } : name === "clustering" ? { processed: 0, created: 0, joined: 0, singles: 0, ms: 0, morePending: false } : undefined;
  });
}

const mocks = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>);
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/logger", () => ({ logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock("@/lib/external-id-store", () => ({ backfillExternalIds: vi.fn(async () => undefined) }));
vi.mock("@/lib/rss-sync", () => ({
  syncAllFeeds: vi.fn(async () => {
    calls.order.push("sync:start");
    if (calls.delayMs) await new Promise((r) => setTimeout(r, calls.delayMs));
    calls.order.push("sync:end");
    return [{ success: true, skipped: false }];
  }),
}));
vi.mock("@/lib/digest-scheduler", () => ({ runDigestScheduler: (mocks.digest = job("digest")) }));
vi.mock("@/lib/notifications", () => ({ flushDueNotifications: (mocks.notify = job("notify")) }));
vi.mock("@/lib/retention", () => ({ applyRetentionPoliciesForAllUsers: (mocks.retention = job("retention")) }));
vi.mock("@/lib/db-maintenance", () => ({ optimizeSqlitePlannerStatsIfDue: (mocks.optimize = job("optimize")) }));
vi.mock("@/lib/briefing/generate", () => ({ cleanupBriefingData: (mocks.briefing = job("briefing")) }));
vi.mock("@/lib/story-clustering/job", () => ({
  runStoryClustering: (mocks.clustering = job("clustering")),
  drainStoryClustering: vi.fn(),
  cleanupStoryClusters: (mocks.cleanup = job("cleanup")),
}));

import { runBackgroundSyncTick, settleBackgroundLane } from "@/lib/background-sync";
import { syncAllFeeds } from "@/lib/rss-sync";

const started = (name: string) => calls.order.filter((e) => e === `${name}:start`).length;
const tickOrder = () => calls.order.filter((e) => e.endsWith(":start")).map((e) => e.replace(":start", ""));

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)["__feedferret_background_sync__"];
  process.env.FEEDFERRET_BACKGROUND_JOB_TIMEOUT_MS = "40";
  calls.order.length = 0;
  calls.active = 0;
  calls.maxActive = 0;
  calls.delayMs = 0;
  calls.failing.clear();
  calls.hanging.clear();
  calls.releases.splice(0).forEach((release) => release());
  vi.clearAllMocks();
});

describe("background sync tick", () => {
  it("runs bounded jobs in the tick and digest / notifications / retention afterwards in the lane, one at a time", async () => {
    calls.delayMs = 2;
    await runBackgroundSyncTick();
    await settleBackgroundLane();
    expect(calls.maxActive).toBe(1);
    expect(tickOrder()).toEqual(["sync", "clustering", "optimize", "digest", "notify", "retention", "cleanup", "briefing"]);
  });

  it("the tick does not wait for the lane: a hanging digest cannot delay the next feed sync", async () => {
    calls.hanging.add("digest");
    const t0 = Date.now();
    await runBackgroundSyncTick(); // returns although digest never settles
    expect(Date.now() - t0).toBeLessThan(35); // well below the 40 ms job timeout
    await runBackgroundSyncTick();
    expect(syncAllFeeds).toHaveBeenCalledTimes(2);
    await settleBackgroundLane();
  });

  it("a never-resolving in-tick job times out: the following job runs, the tick ends, the next tick starts, and the hung job is not started twice", async () => {
    calls.hanging.add("clustering");
    await runBackgroundSyncTick();
    expect(started("optimize")).toBe(1); // ran after the hung job timed out
    await settleBackgroundLane();
    await runBackgroundSyncTick(); // tick is not stuck: it syncs again ...
    expect(syncAllFeeds).toHaveBeenCalledTimes(2);
    expect(started("clustering")).toBe(1); // ... but skips the job that is still hanging
    expect(started("optimize")).toBe(2);
    // once the hung run finally settles, the job is eligible again
    calls.releases.splice(0).forEach((release) => release());
    await new Promise((r) => setTimeout(r, 5));
    await settleBackgroundLane();
    await runBackgroundSyncTick();
    expect(started("clustering")).toBe(2);
    await settleBackgroundLane();
  });

  it("a hanging lane job (tarpit push endpoint) does not block the other lane jobs, and is never piled up on later ticks", async () => {
    calls.hanging.add("notify");
    await runBackgroundSyncTick();
    await settleBackgroundLane(); // lane ends after the 40 ms timeout
    expect(started("retention")).toBe(1);
    expect(started("briefing")).toBe(1);
    await runBackgroundSyncTick();
    await settleBackgroundLane();
    expect(started("digest")).toBe(2);
    expect(started("notify")).toBe(1); // skipped: previous run still hanging
    expect(calls.maxActive).toBe(1);
  });

  it("one failing job does not stop the following ones, and the tick can run again", async () => {
    calls.failing.add("digest");
    calls.failing.add("retention");
    await runBackgroundSyncTick();
    await settleBackgroundLane();
    for (const following of [mocks.notify, mocks.cleanup, mocks.briefing]) expect(following).toHaveBeenCalledTimes(1);
    await runBackgroundSyncTick();
    expect(syncAllFeeds).toHaveBeenCalledTimes(2);
    await settleBackgroundLane();
  });

  it("retention runs at most once a day, not on every tick", async () => {
    await runBackgroundSyncTick();
    await settleBackgroundLane();
    await runBackgroundSyncTick();
    await settleBackgroundLane();
    expect(mocks.retention).toHaveBeenCalledTimes(1);
    expect(mocks.optimize).toHaveBeenCalledTimes(2);
  });

  it("a tick requested while one is still running is ignored (no overlap, no second sync)", async () => {
    calls.delayMs = 15;
    const first = runBackgroundSyncTick();
    await runBackgroundSyncTick(); // returns immediately
    expect(syncAllFeeds).toHaveBeenCalledTimes(1);
    await first;
    await settleBackgroundLane();
    expect(calls.maxActive).toBe(1);
    expect(syncAllFeeds).toHaveBeenCalledTimes(1);
  });
});
