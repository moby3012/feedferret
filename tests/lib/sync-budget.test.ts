import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ feeds: vi.fn(), log: vi.fn(), opml: vi.fn(), fetch: vi.fn(), lookup: vi.fn(), update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })) }));
vi.mock("@/lib/db", () => ({ getDatabaseProvider: () => "sqlite", db: { article: { findMany: vi.fn(async () => []) }, feed: { findMany: mocks.feeds, findUnique: mocks.lookup, update: mocks.update, updateMany: mocks.updateMany } } }));
vi.mock("../../lib/system-log", () => ({ writeSystemLog: mocks.log }));
vi.mock("../../lib/dynamic-opml", () => ({ syncDynamicOpmlCategories: mocks.opml }));
vi.mock("../../lib/connector-secrets", () => ({ getConnectorSecretRules: async () => [], stripConnectorSecretsWith: (_r: unknown, url: string) => url, redactConnectorTextWith: (_r: unknown, text: string) => text }));
vi.mock("../../lib/feed-fetcher", () => ({ fetchFeedArticles: (...args: unknown[]) => mocks.fetch(...args) }));
import { HttpStatusError } from "../../lib/ssrf";
import { resetHostBackoff } from "../../lib/host-backoff";
import { syncAllFeeds, syncFeed } from "../../lib/rss-sync";
beforeEach(() => {
  mocks.opml.mockResolvedValue(undefined); mocks.log.mockResolvedValue(undefined);
  mocks.lookup.mockImplementation(async ({ where }: any) => ({ id: where.id, url: "https://example.com/rss", nextSyncAt: new Date(0), updateFrequency: null, category: null, user: { defaultUpdateFrequency: 60 } }));
  mocks.fetch.mockResolvedValue({ notModified: true, articles: [] });
});
afterEach(() => { vi.useRealTimers(); resetHostBackoff(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it("defers feeds when preparation exhausts the budget without acquiring job locks", async () => {
  vi.stubEnv("SYNC_ALL_BUDGET_MS", "10");
  mocks.opml.mockResolvedValue(undefined);
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  mocks.feeds.mockImplementation(async () => { now = 11; return [{ id: "f", url: "https://example.com/rss", updateFrequency: 1, lastFetchedAt: null, user: { defaultUpdateFrequency: 1 } }]; });
  mocks.log.mockResolvedValue(undefined);
  const results = await syncAllFeeds();
  expect(results[0]).toMatchObject({ skipped: true, deferred: true });
  expect(mocks.log).toHaveBeenCalledWith("warn", "sync", expect.any(String), { deferred: 1, budgetMs: 10 });
});

it("uses indexed due selection then defers later work when the budget expires", async () => {
  vi.stubEnv("SYNC_ALL_BUDGET_MS", "10");
  vi.stubEnv("FEEDFERRET_SYNC_CONCURRENCY", "1");
  mocks.opml.mockResolvedValue(undefined);
  let calls = 0;
  vi.spyOn(Date, "now").mockImplementation(() => ++calls <= 2 ? 0 : 11);
  const base = { url: "https://example.com/rss", updateFrequency: 1, lastFetchedAt: null, user: { defaultUpdateFrequency: 1 } };
  mocks.feeds.mockResolvedValue([{ ...base, id: "b" }, { ...base, id: "a" }, { ...base, id: "muted", autoMuted: true }]);
  // The DB filters not-due and muted subscriptions; retain the defensive muted guard.
  const results = await syncAllFeeds();
  expect(results.find(r => r.feed === base.url && !r.skipped)).toMatchObject({ success: true });
  expect(results.filter(r => "deferred" in r && r.deferred)).toHaveLength(1);
  expect(mocks.feeds).toHaveBeenLastCalledWith(expect.objectContaining({
    where: expect.objectContaining({ archivedAt: null, autoMuted: false, OR: expect.any(Array) }),
    orderBy: [{ nextSyncAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
  }));
});

it.each([429, 503, 403])("defers HTTP %i without feed failure bookkeeping or auto-mute", async (status) => {
  mocks.update.mockClear();
  mocks.fetch.mockRejectedValueOnce(new HttpStatusError(status, "upstream busy", 3600000));
  const before = Date.now();
  const result = await syncFeed("u", "a", { background: true });
  expect(result).toMatchObject({ success: true, skipped: true, deferred: true });
  const patch = mocks.update.mock.calls[0] as unknown as [{ data: { nextSyncAt: Date } }];
  expect(Object.keys(patch[0].data).sort()).toEqual(status === 403 ? ["failingSince", "lastError", "lastStatus", "nextSyncAt"] : ["nextSyncAt"]);
  expect(patch[0].data.nextSyncAt.getTime()).toBeGreaterThanOrEqual(before + 3600000);
});

it("drains 200 same-host feeds at two-second spacing up to budget while other hosts progress", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(1000000);
  vi.stubEnv("SYNC_ALL_BUDGET_MS", "240000");
  vi.stubEnv("FEED_HOST_SPACING_MS", "2000");
  vi.stubEnv("FEEDFERRET_SYNC_CONCURRENCY", "4");
  const feeds = Array.from({ length: 200 }, (_, i) => ({ id: `shared-${i}`, userId: `user-${i}`, url: `https://shared.example/${i}` }));
  for (let i = 0; i < 5; i++) feeds.push({ id: `other-${i}`, userId: "other-user", url: `https://independent${i}.example/feed` });
  mocks.feeds.mockResolvedValue(feeds);
  mocks.lookup.mockImplementation(async ({ where }: any) => ({ ...feeds.find(feed => feed.id === where.id), nextSyncAt: new Date(0), updateFrequency: null, category: null, user: { defaultUpdateFrequency: 60 } }));
  const starts: { id: string; at: number }[] = [];
  mocks.update.mockClear(); mocks.updateMany.mockClear();
  mocks.fetch.mockImplementation(async (feed: { id: string }) => {
    starts.push({ id: feed.id, at: Date.now() });
    return { notModified: true, articles: [] };
  });
  const run = syncAllFeeds();
  await vi.advanceTimersByTimeAsync(240000);
  const results = await run;
  const shared = starts.filter(start => start.id.startsWith("shared"));
  expect(shared).toHaveLength(120);
  expect(shared.every((start, i) => !i || start.at - shared[i - 1].at >= 2000)).toBe(true);
  expect(starts.filter(start => start.id.startsWith("other")).every(start => start.at < 1002000)).toBe(true);
  expect(results.filter(result => "deferred" in result && result.deferred)).toHaveLength(80);
  // Completed feeds write their success state; only leftovers get scheduling-only writes (none needed for a
  // leftover whose lane frees up within a second: it simply stays due).
  const patches = mocks.update.mock.calls as unknown as [{ data: Record<string, unknown> }][];
  expect(patches.filter(call => Object.keys(call[0].data).length === 1 && "nextSyncAt" in call[0].data)).toHaveLength(0);
  const deferrals = mocks.updateMany.mock.calls as unknown as [{ data: { nextSyncAt: Date } }][];
  expect(deferrals).toHaveLength(80);
  // Leftovers queue behind the lane at the configured spacing, starting when the budget ends.
  const times = deferrals.map(([call]) => call.data.nextSyncAt.getTime());
  expect(times[0]).toBeGreaterThanOrEqual(1000000 + 240000);
  expect(times.every((time, i) => !i || time - times[i - 1] === 2000)).toBe(true);
});
it("persists a capped retry time for a seven-day host quota", async () => {
  mocks.update.mockClear();
  mocks.fetch.mockRejectedValueOnce(new HttpStatusError(429, "quota", 7 * 86400000));
  const before = Date.now();
  await syncFeed("u", "a");
  const patch = mocks.update.mock.calls[0] as unknown as [{ data: { nextSyncAt: Date } }];
  expect(patch[0].data.nextSyncAt.getTime()).toBeGreaterThanOrEqual(before + 86400000);
  expect(patch[0].data.nextSyncAt.getTime()).toBeLessThanOrEqual(Date.now() + 86400000);
});
it("applies the existing Google News floor when persisting the next fetch", async () => {
  mocks.update.mockClear();
  mocks.lookup.mockResolvedValue({ id: "google", url: "https://news.google.com/rss/search?q=testing&ceid=US:en", nextSyncAt: new Date(0), updateFrequency: 5, category: null, user: { defaultUpdateFrequency: 60 } });
  const before = Date.now();
  await syncFeed("u", "google");
  const patch = mocks.update.mock.calls[0] as unknown as [{ data: { nextSyncAt: Date } }];
  expect(patch[0].data.nextSyncAt.getTime()).toBeGreaterThanOrEqual(before + 30 * 60000);
});

it("persists Google News exponential delay using the newly incremented failure count", async () => {
  mocks.update.mockClear();
  mocks.lookup.mockResolvedValue({ id: "google", url: "https://news.google.com/rss/search?q=testing&ceid=US:en", nextSyncAt: new Date(0), updateFrequency: 5, category: null, consecutiveFailureCount: 2, autoMuted: false, user: { defaultUpdateFrequency: 60, autoMuteFailingFeedsAfter: 0 } });
  mocks.fetch.mockRejectedValueOnce(new Error("network failed"));
  const before = Date.now();
  await syncFeed("u", "google");
  const patch = mocks.update.mock.calls[0] as unknown as [{ data: { nextSyncAt: Date } }];
  expect(patch[0].data.nextSyncAt.getTime()).toBeGreaterThanOrEqual(before + 240 * 60000);
});

it("grows feed-specific blocked delays with duration and caps them at 24 hours", async () => {
  const now = Date.now();
  mocks.lookup.mockResolvedValue({ id: "blocked", url: "https://blocked.example/feed", nextSyncAt: new Date(0), lastStatus: "attention", lastError: "HTTP 403: feed_blocked", failingSince: new Date(now - 3 * 86400000), user: { defaultUpdateFrequency: 60 } });
  mocks.fetch.mockRejectedValueOnce(new HttpStatusError(403, "blocked"));
  mocks.update.mockClear();
  await syncFeed("u", "blocked");
  const patch = mocks.update.mock.calls[0] as unknown as [{ data: { nextSyncAt: Date; failingSince: Date } }];
  expect(patch[0].data.nextSyncAt.getTime()).toBeGreaterThanOrEqual(now + 86400000);
  expect(patch[0].data.nextSyncAt.getTime()).toBeLessThanOrEqual(Date.now() + 86400000);
  expect(patch[0].data.failingSince.getTime()).toBe(now - 3 * 86400000);
});

it.each([
  ["a freshly fetched feed keeps its interval", 0, 60 * 60000, 60 * 60000],
  ["an overdue feed is spread within the jitter window", -3 * 3600000, 1000, 15 * 60000 + 1000],
])("adopting an unscheduled feed: %s", async (_label, fetchedOffset, min, max) => {
  const now = Date.now();
  mocks.lookup.mockResolvedValue({ id: "legacy", url: "https://legacy.example/feed", nextSyncAt: null, lastFetchedAt: new Date(now + fetchedOffset), consecutiveFailureCount: 0, updateFrequency: null, category: null, user: { defaultUpdateFrequency: 60 } });
  mocks.fetch.mockClear(); mocks.updateMany.mockClear();
  expect(await syncFeed("u", "legacy", { background: true })).toMatchObject({ skipped: true, deferredReason: "initial_schedule" });
  expect(mocks.fetch).not.toHaveBeenCalled();
  const patch = mocks.updateMany.mock.calls[0] as unknown as [{ data: { nextSyncAt: Date } }];
  const delay = patch[0].data.nextSyncAt.getTime() - now;
  expect(delay).toBeGreaterThanOrEqual(min - 50);
  expect(delay).toBeLessThanOrEqual(max + 50);
});

it("a plain 503 pauses that host's lane for the rest of the run; leftovers are scheduled after the pause", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(1000000);
  vi.stubEnv("SYNC_ALL_BUDGET_MS", "60000");
  vi.stubEnv("FEED_HOST_SPACING_MS", "2000");
  const feeds = [0, 1, 2].map(i => ({ id: `s-${i}`, userId: "u", url: `https://plain503.example/${i}` }));
  feeds.push({ id: "other", userId: "u", url: "https://fine.example/feed" });
  mocks.feeds.mockResolvedValue(feeds);
  mocks.lookup.mockImplementation(async ({ where }: any) => ({ ...feeds.find(feed => feed.id === where.id), nextSyncAt: new Date(0), updateFrequency: null, category: null, user: { defaultUpdateFrequency: 60 } }));
  const fetched: string[] = [];
  mocks.fetch.mockImplementation(async (feed: { id: string }) => {
    fetched.push(feed.id);
    if (feed.id.startsWith("s-")) throw new HttpStatusError(503, "busy");
    return { notModified: true, articles: [] };
  });
  mocks.updateMany.mockClear();
  const run = syncAllFeeds();
  await vi.advanceTimersByTimeAsync(60000);
  const results = await run;
  expect(fetched.sort()).toEqual(["other", "s-0"]);
  expect(results.filter(result => "deferredReason" in result && result.deferredReason === "sync_budget")).toHaveLength(2);
  const leftovers = mocks.updateMany.mock.calls as unknown as [{ where: { id: string }; data: { nextSyncAt: Date } }][];
  expect(leftovers.map(([call]) => call.where.id).sort()).toEqual(["s-1", "s-2"]);
  expect(leftovers.every(([call]) => call.data.nextSyncAt.getTime() >= 1000000 + 120000)).toBe(true);
});

it("one feed throwing (e.g. deleted mid-run) does not abort the run; the others are still fetched", async () => {
  vi.stubEnv("FEEDFERRET_SYNC_CONCURRENCY", "1");
  const feeds = ["gone", "kept-1", "kept-2"].map(id => ({ id, userId: "u", url: `https://${id}.example/feed` }));
  mocks.feeds.mockResolvedValue(feeds);
  mocks.lookup.mockImplementation(async ({ where }: any) => where.id === "gone" ? null : ({ ...feeds.find(feed => feed.id === where.id), nextSyncAt: new Date(0), updateFrequency: null, category: null, user: { defaultUpdateFrequency: 60 } }));
  const fetched: string[] = [];
  mocks.fetch.mockImplementation(async (feed: { id: string }) => { fetched.push(feed.id); return { notModified: true, articles: [] }; });
  const results = await syncAllFeeds();
  expect(fetched.sort()).toEqual(["kept-1", "kept-2"]);
  expect(results.find(result => result.feed.includes("gone"))).toMatchObject({ success: false, error: "Feed not found" });
});

it("a never-fetched feed without a schedule (e.g. just imported) is fetched by the first background sync", async () => {
  mocks.lookup.mockResolvedValue({ id: "imported", url: "https://imported.example/feed", nextSyncAt: null, lastFetchedAt: null, consecutiveFailureCount: 0, updateFrequency: null, category: null, user: { defaultUpdateFrequency: 60 } });
  mocks.fetch.mockClear(); mocks.updateMany.mockClear();
  const result = await syncFeed("u", "imported", { background: true });
  expect(result).not.toMatchObject({ deferredReason: "initial_schedule" });
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});
