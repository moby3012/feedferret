import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ feeds: vi.fn(), log: vi.fn(), opml: vi.fn(), fetch: vi.fn(), lookup: vi.fn(), update: vi.fn(async () => ({})) }));
vi.mock("@/lib/db", () => ({ getDatabaseProvider: () => "sqlite", db: { article: { findMany: vi.fn(async () => []) }, feed: { findMany: mocks.feeds, findUnique: mocks.lookup, update: mocks.update } } }));
vi.mock("../../lib/system-log", () => ({ writeSystemLog: mocks.log }));
vi.mock("../../lib/dynamic-opml", () => ({ syncDynamicOpmlCategories: mocks.opml }));
vi.mock("../../lib/connector-secrets", () => ({ getConnectorSecretRules: async () => [], stripConnectorSecretsWith: (_r: unknown, url: string) => url, redactConnectorTextWith: (_r: unknown, text: string) => text }));
vi.mock("../../lib/feed-fetcher", () => ({ fetchFeedArticles: (...args: unknown[]) => mocks.fetch(...args) }));
import { HttpStatusError } from "../../lib/ssrf";
import { resetHostBackoff } from "../../lib/host-backoff";
import { syncAllFeeds, syncFeed } from "../../lib/rss-sync";
beforeEach(() => {
  mocks.lookup.mockImplementation(async ({ where }: any) => ({ id: where.id, url: "https://example.com/rss", nextSyncAt: new Date(0), updateFrequency: null, category: null, user: { defaultUpdateFrequency: 60 } }));
  mocks.fetch.mockResolvedValue({ notModified: true, articles: [] });
});
afterEach(() => { resetHostBackoff(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
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
  expect(Object.keys(patch[0].data).sort()).toEqual(status === 403 ? ["lastError", "lastStatus", "nextSyncAt"] : ["nextSyncAt"]);
  expect(patch[0].data.nextSyncAt.getTime()).toBeGreaterThanOrEqual(before + 3600000);
});

it("200 feeds sharing a busy host do not prevent another host using the pool", async () => {
  vi.stubEnv("FEEDFERRET_SYNC_CONCURRENCY", "4");
  const feeds = Array.from({ length: 200 }, (_, i) => ({ id: `shared-${i}`, userId: `user-${i}`, url: `https://shared.example/${i}` }));
  feeds.push({ id: "other", userId: "other-user", url: "https://independent.example/feed" });
  mocks.feeds.mockResolvedValue(feeds);
  mocks.lookup.mockImplementation(async ({ where }: any) => ({ ...feeds.find(feed => feed.id === where.id), nextSyncAt: new Date(0), updateFrequency: null, category: null, user: { defaultUpdateFrequency: 60 } }));
  let release!: () => void;
  let reached!: () => void;
  const otherReached = new Promise<void>(resolve => { reached = resolve; });
  mocks.fetch.mockImplementation(async (feed: { id: string }) => {
    if (feed.id === "shared-0") await new Promise<void>(resolve => { release = resolve; });
    if (feed.id === "other") reached();
    return { notModified: true, articles: [] };
  });
  const run = syncAllFeeds();
  try { await otherReached; } finally { release?.(); }
  const results = await run;
  expect(results.filter(result => "deferred" in result && result.deferred)).toHaveLength(199);
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
