import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import type { ArticleDetail } from "@/features/articles/types";
import {
  DEFAULT_LIMITS,
  clearAllOffline,
  deleteArticles,
  enforceLimits,
  getActiveUser,
  getBody,
  getUsage,
  hasBody,
  listRows,
  patchStored,
  planEviction,
  purgeOtherUsers,
  resetOfflineDbForTests,
  saveArticle,
  setActiveUser,
  touchArticle,
} from "@/features/offline/store";

function detail(id: string, o: Partial<ArticleDetail> = {}): ArticleDetail {
  return {
    id,
    feedId: "f1",
    title: `Title ${id}`,
    link: `https://example.com/${id}`,
    excerpt: "excerpt",
    author: null,
    publishedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    imageUrl: null,
    kind: "article",
    media: null,
    readMinutes: 3,
    isRead: false,
    isStarred: false,
    isReadLater: false,
    isSpoiler: false,
    isDuplicate: false,
    duplicateCount: 0,
    canonicalFeedName: null,
    labelIds: [],
    html: `<p>body of ${id}</p>`,
    contentFormat: "html",
    aiSummary: null,
    aiSummarizedAt: null,
    readAt: null,
    ...o,
  } as ArticleDetail;
}

beforeEach(async () => {
  await clearAllOffline();
});

describe("offline store", () => {
  it("round-trips a body and keeps the list row light", async () => {
    await saveArticle("u1", detail("a", { isReadLater: true }), { now: 10 });
    expect((await getBody("u1", "a"))?.html).toBe("<p>body of a</p>");
    const [row] = await listRows("u1");
    expect(row).toMatchObject({ id: "a", readLater: true, savedAt: 10, openedAt: null });
    expect(row.item).not.toHaveProperty("html");
    expect(row.item.title).toBe("Title a");
  });

  it("isolates users: nothing of u1 is visible to u2", async () => {
    await saveArticle("u1", detail("a"), { opened: true });
    await saveArticle("u2", detail("b"), { opened: true });
    expect(await getBody("u2", "a")).toBeUndefined();
    expect((await listRows("u2")).map((r) => r.id)).toEqual(["b"]);
    expect(await hasBody("u1", "b")).toBe(false);
  });

  it("purgeOtherUsers keeps only the current account (account switch)", async () => {
    await saveArticle("u1", detail("a"));
    await saveArticle("u2", detail("b"));
    await purgeOtherUsers("u2");
    expect(await listRows("u1")).toEqual([]);
    expect(await getBody("u1", "a")).toBeUndefined();
    expect((await listRows("u2")).length).toBe(1);
  });

  it("clearAllOffline (logout) removes rows, bodies and the active user", async () => {
    await saveArticle("u1", detail("a"));
    await setActiveUser("u1");
    await clearAllOffline();
    expect(await listRows("u1")).toEqual([]);
    expect(await getBody("u1", "a")).toBeUndefined();
    expect(await getActiveUser()).toBeUndefined();
  });

  it("opening bumps lastAccess/openedAt, saving does not reset them", async () => {
    await saveArticle("u1", detail("a"), { now: 1 });
    await touchArticle("u1", "a", 50);
    await saveArticle("u1", detail("a", { isStarred: true }), { now: 99 }); // background refresh
    const [row] = await listRows("u1");
    expect(row).toMatchObject({ savedAt: 1, lastAccess: 50, openedAt: 50 });
    expect(row.item.isStarred).toBe(true);
  });

  it("patchStored mirrors flags into row and body", async () => {
    await saveArticle("u1", detail("a", { isReadLater: true }));
    await patchStored("u1", "a", { isReadLater: false, isRead: true });
    const [row] = await listRows("u1");
    expect(row.readLater).toBe(false);
    expect(row.item.isRead).toBe(true);
    expect((await getBody("u1", "a"))?.isRead).toBe(true);
  });

  it("deleteArticles removes row and body", async () => {
    await saveArticle("u1", detail("a"));
    await deleteArticles("u1", ["a"]);
    expect(await hasBody("u1", "a")).toBe(false);
    expect(await getBody("u1", "a")).toBeUndefined();
  });

  it("reports usage", async () => {
    await saveArticle("u1", detail("a"));
    await saveArticle("u1", detail("b"));
    const usage = await getUsage("u1");
    expect(usage.count).toBe(2);
    expect(usage.bytes).toBeGreaterThan(100);
  });

  it("enforceLimits keeps the 50 most recently opened articles, never touching read-later ones", async () => {
    for (let i = 0; i < 60; i++) await saveArticle("u1", detail(`r${i}`), { opened: true, now: 1000 + i });
    await saveArticle("u1", detail("later", { isReadLater: true }), { now: 1 });
    const evicted = await enforceLimits("u1");
    expect(evicted.length).toBe(10);
    const ids = new Set((await listRows("u1")).map((r) => r.id));
    expect(ids.has("later")).toBe(true);
    expect(ids.has("r0")).toBe(false);
    expect(ids.has("r59")).toBe(true);
    expect(ids.size).toBe(51);
  });

  it("survives a closed/unavailable IndexedDB without throwing", async () => {
    await resetOfflineDbForTests();
    const real = globalThis.indexedDB;
    // @ts-expect-error simulate private mode
    globalThis.indexedDB = undefined;
    try {
      expect(await saveArticle("u1", detail("a"))).toBe(false);
      expect(await listRows("u1")).toEqual([]);
      await expect(clearAllOffline()).resolves.toBeUndefined();
    } finally {
      globalThis.indexedDB = real;
      await resetOfflineDbForTests();
    }
  });
});

describe("planEviction", () => {
  const row = (key: string, readLater: boolean, lastAccess: number, bytes = 10) => ({ key, readLater, lastAccess, bytes });

  it("drops nothing within limits", () => {
    expect(planEviction([row("a", true, 1), row("b", false, 2)])).toEqual([]);
  });

  it("trims recents to maxRecent, oldest access first", () => {
    const rows = [row("a", false, 1), row("b", false, 2), row("c", false, 3)];
    expect(planEviction(rows, { ...DEFAULT_LIMITS, maxRecent: 2 })).toEqual(["a"]);
  });

  it("over the byte budget: recents go first (LRU), then read-later (LRU)", () => {
    const rows = [row("l-old", true, 1, 40), row("l-new", true, 5, 40), row("r1", false, 3, 40)];
    expect(planEviction(rows, { maxRecent: 50, maxEntries: 10, maxBytes: 90 })).toEqual(["r1"]);
    expect(planEviction(rows, { maxRecent: 50, maxEntries: 10, maxBytes: 50 }).sort()).toEqual(["l-old", "r1"]);
  });

  it("over the entry budget", () => {
    const rows = [row("a", true, 1), row("b", true, 2), row("c", true, 3)];
    expect(planEviction(rows, { maxRecent: 50, maxEntries: 2, maxBytes: 1e9 })).toEqual(["a"]);
  });

  it("default budget is 50 MB", () => {
    expect(DEFAULT_LIMITS.maxBytes).toBe(50 * 1024 * 1024);
  });
});
