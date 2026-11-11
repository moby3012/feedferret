import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ feeds: vi.fn(), log: vi.fn(), opml: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDatabaseProvider: () => "sqlite", db: { feed: { findMany: mocks.feeds, findUnique: vi.fn(async () => ({ id: "a", url: "https://example.com/rss" })), update: vi.fn(async () => ({})) } } }));
vi.mock("../../lib/system-log", () => ({ writeSystemLog: mocks.log }));
vi.mock("../../lib/dynamic-opml", () => ({ syncDynamicOpmlCategories: mocks.opml }));
vi.mock("../../lib/connector-secrets", () => ({ getConnectorSecretRules: async () => [], stripConnectorSecretsWith: (_r: unknown, url: string) => url, redactConnectorTextWith: (_r: unknown, text: string) => text }));
vi.mock("../../lib/feed-fetcher", () => ({ fetchFeedArticles: async () => ({ notModified: true, articles: [] }) }));
import { syncAllFeeds } from "../../lib/rss-sync";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
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

it("starts oldest due work then defers later due feeds, excluding muted and not-due feeds", async () => {
  vi.stubEnv("SYNC_ALL_BUDGET_MS", "10");
  vi.stubEnv("FEEDFERRET_SYNC_CONCURRENCY", "1");
  mocks.opml.mockResolvedValue(undefined);
  let calls = 0;
  vi.spyOn(Date, "now").mockImplementation(() => ++calls <= 2 ? 0 : 11);
  const base = { url: "https://example.com/rss", updateFrequency: 1, lastFetchedAt: null, user: { defaultUpdateFrequency: 1 } };
  mocks.feeds.mockResolvedValue([{ ...base, id: "b" }, { ...base, id: "a" }, { ...base, id: "muted", autoMuted: true }, { ...base, id: "c", lastFetchedAt: new Date(), updateFrequency: 99999 }]);
  // Muted and not-due feeds never enter the deferred count.
  const results = await syncAllFeeds();
  expect(results.find(r => r.feed === base.url && !r.skipped)).toMatchObject({ success: true });
  expect(results.filter(r => "deferred" in r && r.deferred)).toHaveLength(1);
});
