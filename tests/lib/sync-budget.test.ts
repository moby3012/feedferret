import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ feeds: vi.fn(), log: vi.fn(), opml: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDatabaseProvider: () => "sqlite", db: { feed: { findMany: mocks.feeds } } }));
vi.mock("../../lib/system-log", () => ({ writeSystemLog: mocks.log }));
vi.mock("../../lib/dynamic-opml", () => ({ syncDynamicOpmlCategories: mocks.opml }));
import { syncAllFeeds } from "../../lib/rss-sync";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it("defers feeds when preparation exhausts the budget without acquiring job locks", async () => {
  vi.stubEnv("SYNC_ALL_BUDGET_MS", "10");
  mocks.opml.mockResolvedValue(undefined);
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  mocks.feeds.mockImplementation(async () => { now = 11; return [{ id: "f", url: "https://example.com/rss" }]; });
  mocks.log.mockResolvedValue(undefined);
  const results = await syncAllFeeds();
  expect(results[0]).toMatchObject({ skipped: true, deferred: true });
  expect(mocks.log).toHaveBeenCalledWith("warn", "sync", expect.any(String), { deferred: 1, budgetMs: 10 });
});
