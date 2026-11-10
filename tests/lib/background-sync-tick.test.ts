// Background sync tick (audit R5): post-sync jobs run one after the other (never concurrently),
// are isolated from each other's failures, and the tick itself never overlaps.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ order: [] as string[], active: 0, maxActive: 0, delayMs: 0, failing: new Set<string>() }));

function job(name: string) {
  return vi.fn(async () => {
    calls.order.push(`${name}:start`);
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

import { runBackgroundSyncTick } from "@/lib/background-sync";
import { syncAllFeeds } from "@/lib/rss-sync";

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)["__feedferret_background_sync__"];
  calls.order.length = 0;
  calls.active = 0;
  calls.maxActive = 0;
  calls.delayMs = 0;
  calls.failing.clear();
  vi.clearAllMocks();
});

describe("background sync tick", () => {
  it("runs the post-sync jobs strictly one after the other, retention last", async () => {
    calls.delayMs = 2;
    await runBackgroundSyncTick();
    expect(calls.maxActive).toBe(1);
    const starts = calls.order.filter((e) => e.endsWith(":start")).map((e) => e.replace(":start", ""));
    expect(starts).toEqual(["sync", "clustering", "optimize", "digest", "notify", "retention", "cleanup", "briefing"]);
  });

  it("one failing job does not stop the following ones, and the tick can run again", async () => {
    calls.failing.add("digest");
    calls.failing.add("retention");
    await runBackgroundSyncTick();
    for (const following of [mocks.notify, mocks.cleanup, mocks.briefing]) expect(following).toHaveBeenCalledTimes(1);
    await runBackgroundSyncTick();
    expect(syncAllFeeds).toHaveBeenCalledTimes(2);
  });

  it("retention runs at most once a day, not on every tick", async () => {
    await runBackgroundSyncTick();
    await runBackgroundSyncTick();
    expect(mocks.retention).toHaveBeenCalledTimes(1);
    expect(mocks.optimize).toHaveBeenCalledTimes(2);
  });

  it("a tick requested while one is still running is ignored (no overlap, no second sync)", async () => {
    calls.delayMs = 15;
    const first = runBackgroundSyncTick();
    await runBackgroundSyncTick(); // returns immediately
    expect(syncAllFeeds).toHaveBeenCalledTimes(1);
    await first;
    expect(calls.maxActive).toBe(1);
    expect(syncAllFeeds).toHaveBeenCalledTimes(1);
  });
});
