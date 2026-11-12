vi.mock("@/lib/media-proxy", () => ({ presentMedia: async (items: unknown[]) => items }));
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const prefs = { defaultArticleSort: "newest", defaultViewMode: "list" } as Record<string, unknown>;
  return {
    prefs,
    getBootstrap: vi.fn(async () => ({
      feeds: [{ id: "f1", name: "Feed" }],
      categories: [{ id: "c1" }],
      labels: [{ id: "l1" }],
      savedSearches: [{ id: "s1" }],
      prefs,
      counts: { unreadTotal: 3, byFeed: { f1: 3 }, byLabel: {}, later: 0, starred: 0, spoiler: 0, notifications: 0 },
      notifications: [{ id: "n1" }],
    })),
    listArticles: vi.fn(async (_userId: string, _params: unknown) => ({ items: [{ id: "a1", title: "First" }], nextCursor: "cur" })),
    getArticleDetail: vi.fn(async (_userId: string, id: string) => (id === "missing" ? null : { id, html: "<p>body</p>" })),
    getBriefingState: vi.fn(async (_userId: string, _scope: unknown) => ({ briefing: null, briefingId: null, totalUnread: 3, generatedAt: null as string | null })),
  };
});
vi.mock("@/server/bootstrap", () => ({ getBootstrap: h.getBootstrap }));
vi.mock("@/server/articles/list", () => ({ listArticles: h.listArticles }));
vi.mock("@/server/articles/detail", () => ({ getArticleDetail: h.getArticleDetail }));
vi.mock("@/lib/briefing/generate", () => ({ getBriefingState: h.getBriefingState }));

import { buildBootstrapState } from "../../server/bootstrap-state";
import { qk } from "../../features/articles/keys";
import { briefingKey } from "../../features/briefing/api";
import { listKeyOfLoc, parseLoc } from "../../features/reader/nav/location";

const keysOf = (state: Awaited<ReturnType<typeof buildBootstrapState>>) => state.queries.map((q) => JSON.stringify(q.queryKey));
const dataOf = (state: Awaited<ReturnType<typeof buildBootstrapState>>, key: readonly unknown[]) =>
  state.queries.find((q) => JSON.stringify(q.queryKey) === JSON.stringify(key))?.state.data;

beforeEach(() => {
  h.prefs.defaultArticleSort = "newest";
  h.listArticles.mockClear();
  h.getArticleDetail.mockClear();
  h.getBriefingState.mockClear();
});

describe("buildBootstrapState (cold-start cache, spec §2.5)", () => {
  it("seeds every entity key, the counts and the first page of the URL's list under the client's own keys", async () => {
    const state = await buildBootstrapState("u1", "/");
    const clientKey = listKeyOfLoc(parseLoc(""), "new")!;
    expect(keysOf(state).sort()).toEqual(
      [qk.feeds, qk.categories, qk.labels, qk.savedSearches, qk.prefs, qk.counts, qk.notifications, qk.list(clientKey), briefingKey("new")].map((k) => JSON.stringify(k)).sort(),
    );
    // useInfiniteQuery's shape: one page, first page param null.
    expect(dataOf(state, qk.list(clientKey))).toEqual({ pages: [{ items: [{ id: "a1", title: "First" }], nextCursor: "cur" }], pageParams: [null] });
    expect(h.listArticles).toHaveBeenCalledWith("u1", { scope: { kind: "all" }, show: "unread", sort: "new", limit: 50 });
    expect(state.queries.every((q) => q.state.status === "success")).toBe(true);
  });

  it("uses the user's default sort and the URL's scope / show (same key the shell binds)", async () => {
    h.prefs.defaultArticleSort = "oldest";
    const state = await buildBootstrapState("u1", "/?feed=f1&show=all");
    const clientKey = listKeyOfLoc(parseLoc("?feed=f1&show=all"), "old")!;
    expect(keysOf(state)).toContain(JSON.stringify(qk.list(clientKey)));
    expect(h.listArticles).toHaveBeenCalledWith("u1", { scope: { kind: "feed", id: "f1" }, show: "all", sort: "old", limit: 50 });
  });

  it("adds the open article's detail; a foreign / unknown id is left to the client", async () => {
    const open = await buildBootstrapState("u1", "/?a=a1");
    expect(dataOf(open, qk.article("a1"))).toEqual({ id: "a1", html: "<p>body</p>" });
    const missing = await buildBootstrapState("u1", "/?a=missing");
    expect(keysOf(missing)).not.toContain(JSON.stringify(qk.article("missing")));
  });

  it("a tab root without scope prefetches no list", async () => {
    const state = await buildBootstrapState("u1", "/?tab=feeds");
    expect(h.listArticles).not.toHaveBeenCalled();
    expect(keysOf(state).some((k) => k.startsWith('["list"'))).toBe(false);
  });

  it("the Neu list (all, unread) also seeds the briefing card's GET state; other lists do not", async () => {
    const state = await buildBootstrapState("u1", "/");
    expect(h.getBriefingState).toHaveBeenCalledWith("u1", { kind: "new" });
    expect(dataOf(state, briefingKey("new"))).toMatchObject({ briefing: null, totalUnread: 3 });
    for (const href of ["/?feed=f1", "/?show=all", "/?v=later", "/?tab=feeds"]) {
      h.getBriefingState.mockClear();
      expect(keysOf(await buildBootstrapState("u1", href))).not.toContain(JSON.stringify(briefingKey("new")));
      expect(h.getBriefingState).not.toHaveBeenCalled();
    }
  });

  it("a failing briefing query leaves the card to its own GET", async () => {
    h.getBriefingState.mockRejectedValueOnce(new Error("db down"));
    const state = await buildBootstrapState("u1", "/");
    expect(keysOf(state)).not.toContain(JSON.stringify(briefingKey("new")));
    expect(keysOf(state).some((k) => k.startsWith('["list"'))).toBe(true);
  });

  it("a failing list query still boots the shell (entities hydrated, the client fetches the list)", async () => {
    h.listArticles.mockRejectedValueOnce(new Error("boom"));
    const state = await buildBootstrapState("u1", "/?label=gone");
    expect(keysOf(state)).toContain(JSON.stringify(qk.feeds));
    expect(keysOf(state).some((k) => k.startsWith('["list"'))).toBe(false);
  });
});
