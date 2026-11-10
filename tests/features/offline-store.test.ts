import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import type { ArticleDetail } from "@/features/articles/types";
import {
  DEFAULT_LIMITS,
  OFFLINE_MAX_AGE_MS,
  claimSession,
  clearAllOffline,
  clearOfflineArticles,
  deleteArticles,
  enforceLimits,
  getActiveUser,
  getBody,
  getUsage,
  hasBody,
  isSessionFresh,
  listRows,
  markVerified,
  patchStored,
  planEviction,
  planQuotaEviction,
  readSession,
  readStatus,
  resetOfflineDbForTests,
  saveArticle,
  touchArticle,
  type OfflineScope,
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

let u1: OfflineScope;

async function claim(userId: string): Promise<OfflineScope> {
  const claimed = await claimSession(userId);
  return { userId, gen: claimed!.gen };
}

beforeEach(async () => {
  await clearAllOffline();
  u1 = await claim("u1");
});

describe("offline store", () => {
  it("round-trips a body and keeps the list row light", async () => {
    expect(await saveArticle(u1, detail("a", { isReadLater: true }), { now: 10 })).toBe("saved");
    expect((await getBody("u1", "a"))?.html).toBe("<p>body of a</p>");
    const [row] = await listRows("u1");
    expect(row).toMatchObject({ id: "a", readLater: true, savedAt: 10, openedAt: null });
    expect(row.item).not.toHaveProperty("html");
    expect(row.item.title).toBe("Title a");
  });

  it("reads are per user: nothing of u1 is visible to u2", async () => {
    await saveArticle(u1, detail("a"), { opened: true });
    expect(await getBody("u2", "a")).toBeUndefined();
    expect(await listRows("u2")).toEqual([]);
    expect(await hasBody("u2", "a")).toBe(false);
  });

  it("claiming the store for another account drops the previous account's data and issues a new generation", async () => {
    await saveArticle(u1, detail("a"));
    const u2 = await claim("u2");
    expect(u2.gen).not.toBe(u1.gen);
    expect(await listRows("u1")).toEqual([]);
    expect(await getBody("u1", "a")).toBeUndefined();
    expect(await getActiveUser()).toBe("u2");
  });

  it("claiming again as the same account keeps the generation (several tabs share it) and refreshes verifiedAt", async () => {
    await saveArticle(u1, detail("a"));
    const again = await claimSession("u1", 5_000);
    expect(again).toEqual({ gen: u1.gen, changed: false });
    expect((await readSession())?.verifiedAt).toBe(5_000);
    expect(await listRows("u1")).toHaveLength(1);
  });

  it("a writer of an older generation is refused INSIDE the transaction (stale tab / late fetch)", async () => {
    const u2 = await claim("u2");
    expect(await saveArticle(u1, detail("late"))).toBe("stale");
    await patchStored(u1, "late", { isRead: true });
    await deleteArticles(u1, ["x"]);
    await touchArticle(u1, "late");
    expect(await enforceLimits(u1)).toEqual([]);
    expect(await listRows("u1")).toEqual([]);
    expect(await listRows("u2")).toEqual([]);
    // The right generation still writes.
    expect(await saveArticle(u2, detail("fresh"))).toBe("saved");
    // Same generation, wrong account is no scope either.
    expect(await saveArticle({ userId: "u1", gen: u2.gen }, detail("forged"))).toBe("stale");
    expect((await listRows("u2")).map((r) => r.id)).toEqual(["fresh"]);
  });

  it("a write that was issued before logout cannot land after it", async () => {
    const pending = saveArticle(u1, detail("racing"));
    await clearAllOffline(); // logout
    await pending;
    await saveArticle(u1, detail("after")); // late, same (now dead) generation
    expect(await listRows("u1")).toEqual([]);
    expect(await readSession()).toBeUndefined();
  });

  it("clearAllOffline (logout) removes rows, bodies and the session", async () => {
    await saveArticle(u1, detail("a"));
    await clearAllOffline();
    expect(await listRows("u1")).toEqual([]);
    expect(await getBody("u1", "a")).toBeUndefined();
    expect(await getActiveUser()).toBeUndefined();
  });

  it("clearOfflineArticles (settings) keeps the session so syncing continues", async () => {
    await saveArticle(u1, detail("a"));
    await clearOfflineArticles();
    expect(await listRows("u1")).toEqual([]);
    expect(await getActiveUser()).toBe("u1");
    expect(await saveArticle(u1, detail("b"))).toBe("saved");
  });

  it("markVerified stamps the session; a stale scope cannot", async () => {
    await markVerified(u1, 123);
    expect((await readSession())?.verifiedAt).toBe(123);
    await claim("u2");
    await markVerified(u1, 999);
    expect((await readSession())?.verifiedAt).not.toBe(999);
  });

  it("opening bumps lastAccess/openedAt, saving does not reset them", async () => {
    await saveArticle(u1, detail("a"), { now: 1 });
    await touchArticle(u1, "a", 50);
    await saveArticle(u1, detail("a", { isStarred: true }), { now: 99 }); // background refresh
    const [row] = await listRows("u1");
    expect(row).toMatchObject({ savedAt: 1, lastAccess: 50, openedAt: 50 });
    expect(row.item.isStarred).toBe(true);
  });

  it("patchStored mirrors flags into row and body", async () => {
    await saveArticle(u1, detail("a", { isReadLater: true }));
    await patchStored(u1, "a", { isReadLater: false, isRead: true });
    const [row] = await listRows("u1");
    expect(row.readLater).toBe(false);
    expect(row.item.isRead).toBe(true);
    expect((await getBody("u1", "a"))?.isRead).toBe(true);
  });

  it("deleteArticles removes row and body", async () => {
    await saveArticle(u1, detail("a"));
    await deleteArticles(u1, ["a"]);
    expect(await hasBody("u1", "a")).toBe(false);
    expect(await getBody("u1", "a")).toBeUndefined();
  });

  it("reports usage", async () => {
    await saveArticle(u1, detail("a"));
    await saveArticle(u1, detail("b"));
    const usage = await getUsage("u1");
    expect(usage.count).toBe(2);
    expect(usage.bytes).toBeGreaterThan(100);
  });

  it("enforceLimits keeps the 50 most recently opened articles, never touching read-later ones", async () => {
    for (let i = 0; i < 60; i++) await saveArticle(u1, detail(`r${i}`), { opened: true, now: 1000 + i });
    await saveArticle(u1, detail("later", { isReadLater: true }), { now: 1 });
    const evicted = await enforceLimits(u1);
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
      expect(await saveArticle(u1, detail("a"))).toBe("stale");
      expect(await claimSession("u1")).toBeNull();
      expect(await listRows("u1")).toEqual([]);
      await expect(clearAllOffline()).resolves.toBeUndefined();
    } finally {
      globalThis.indexedDB = real;
      await resetOfflineDbForTests();
    }
  });
});

describe("storage quota", () => {
  /** Makes the first `failures` puts into the bodies store fail the way a full disk does (async tx abort). */
  function failBodyWrites(failures: number) {
    const real = IDBObjectStore.prototype.put;
    let left = failures;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "bodies" && left > 0) {
        left -= 1;
        this.transaction.abort(); // a full disk aborts the whole transaction
        throw new DOMException("quota", "QuotaExceededError");
      }
      return real.apply(this, args);
    } as typeof real;
    return () => {
      IDBObjectStore.prototype.put = real;
    };
  }

  it("evicts the oldest entries (recents before read-later) and retries once", async () => {
    for (let i = 0; i < 4; i++) await saveArticle(u1, detail(`r${i}`), { opened: true, now: 100 + i });
    await saveArticle(u1, detail("later", { isReadLater: true }), { now: 1 });
    const restore = failBodyWrites(1);
    try {
      expect(await saveArticle(u1, detail("new"), { opened: true, now: 500 })).toBe("saved");
    } finally {
      restore();
    }
    const ids = (await listRows("u1")).map((r) => r.id).sort();
    expect(ids).toContain("new");
    expect(ids).toContain("later"); // read-later goes last
    expect(ids).not.toContain("r0");
    expect(ids.length).toBeLessThan(6);
    expect((await readStatus())?.quotaFailed).toBe(false);
  });

  it("still refused after eviction: reports 'quota' and records the failure for the settings line", async () => {
    await saveArticle(u1, detail("a"));
    const restore = failBodyWrites(5);
    try {
      expect(await saveArticle(u1, detail("b"))).toBe("quota");
    } finally {
      restore();
    }
    expect(await readStatus()).toMatchObject({ quotaFailed: true });
    // The next successful save without trouble clears the warning.
    expect(await saveArticle(u1, detail("c"))).toBe("saved");
    expect(await readStatus()).toBeUndefined();
  });

  it("planQuotaEviction: oldest first, recents before read-later, at least `minDrop` rows and 2x the needed bytes", () => {
    const row = (key: string, readLater: boolean, lastAccess: number, bytes = 10) => ({ key, readLater, lastAccess, bytes });
    const rows = [row("l1", true, 1), row("r2", false, 2), row("r1", false, 1), row("r3", false, 3), row("r4", false, 4)];
    expect(planQuotaEviction(rows, 5)).toEqual(["r1", "r2", "r3"]);
    expect(planQuotaEviction(rows, 45)).toEqual(["r1", "r2", "r3", "r4", "l1"]);
    expect(planQuotaEviction([], 10)).toEqual([]);
  });
});

describe("session freshness (offline policy)", () => {
  const now = 1_000_000_000_000;
  it("fresh within the max age, expired after it, missing or in the future is not trusted", () => {
    expect(isSessionFresh(now - 1000, now)).toBe(true);
    expect(isSessionFresh(now - OFFLINE_MAX_AGE_MS, now)).toBe(true);
    expect(isSessionFresh(now - OFFLINE_MAX_AGE_MS - 1, now)).toBe(false);
    expect(isSessionFresh(undefined, now)).toBe(false);
    expect(isSessionFresh(now + 60 * 60 * 1000, now)).toBe(false); // clock turned back
    expect(isSessionFresh(now + 60_000, now)).toBe(true); // small skew
  });
  it("is 30 days (mirrors the NextAuth JWT lifetime)", () => {
    expect(OFFLINE_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1000);
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
