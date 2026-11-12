import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ feeds: vi.fn(), log: vi.fn(), opml: vi.fn(), fetch: vi.fn(), update: vi.fn(async () => ({})) }));
vi.mock("@/lib/db", () => ({ getDatabaseProvider: () => "sqlite", db: { article: { findMany: vi.fn(async () => []) }, feed: { findMany: mocks.feeds, findUnique: vi.fn(async () => ({ id: "a", url: "https://example.com/rss", updateFrequency: null, category: null, user: { defaultUpdateFrequency: 60 } })), update: mocks.update } } }));
vi.mock("../../lib/system-log", () => ({ writeSystemLog: mocks.log }));
vi.mock("../../lib/dynamic-opml", () => ({ syncDynamicOpmlCategories: mocks.opml }));
vi.mock("../../lib/connector-secrets", () => ({ getConnectorSecretRules: async () => [], stripConnectorSecretsWith: (_r: unknown, url: string) => url, redactConnectorTextWith: (_r: unknown, text: string) => text }));
vi.mock("../../lib/feed-fetcher", () => ({ fetchFeedArticles: (...args: unknown[]) => mocks.fetch(...args) }));
import { HttpStatusError } from "../../lib/ssrf";
import { resetHostBackoff } from "../../lib/host-backoff";
import { syncAllFeeds, syncFeed } from "../../lib/rss-sync";
mocks.fetch.mockResolvedValue({ notModified: true, articles: [] });
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
    orderBy: [{ nextSyncAt: "asc" }, { id: "asc" }],
  }));
});

it.each([429, 503, 403])("defers HTTP %i without feed failure bookkeeping or auto-mute", async (status) => {
  mocks.update.mockClear();
  mocks.fetch.mockRejectedValueOnce(new HttpStatusError(status, "upstream busy", 3600000));
  const before = Date.now();
  const result = await syncFeed("u", "a", { background: true });
  expect(result).toMatchObject({ success: true, skipped: true, deferred: true });
  const patch = mocks.update.mock.calls[0] as unknown as [{ data: { nextSyncAt: Date } }];
  expect(Object.keys(patch[0].data)).toEqual(["nextSyncAt"]);
  expect(patch[0].data.nextSyncAt.getTime()).toBeGreaterThanOrEqual(before + 3600000);
});
