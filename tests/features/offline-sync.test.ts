import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { ArticleDetail, ArticleListItem, ArticlePage } from "@/features/articles/types";
import { itemsForScope } from "@/features/offline/offline";
import {
  SESSION_KEY,
  OFFLINE_MAX_AGE_MS,
  claimSession,
  type OfflineScope,
  BODY_STORE,
  INDEX_STORE,
  META_STORE,
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  MAX_RECENT,
  clearAllOffline,
  getBody,
  listRows,
  saveArticle,
  type IndexRow,
} from "@/features/offline/store";
import { reconcileReadLater, type ReconcileDeps } from "@/features/offline/sync";

const item = (id: string, o: Partial<ArticleListItem> = {}): ArticleListItem =>
  ({
    id,
    feedId: "f1",
    title: id,
    link: "",
    excerpt: "",
    author: null,
    publishedAt: `2026-01-0${id.length % 9 || 1}T00:00:00.000Z`,
    createdAt: "2026-01-01T00:00:00.000Z",
    imageUrl: null,
    kind: "article",
    media: null,
    readMinutes: 1,
    isRead: false,
    isStarred: false,
    isReadLater: false,
    isSpoiler: false,
    isDuplicate: false,
    duplicateCount: 0,
    canonicalFeedName: null,
    labelIds: [],
    ...o,
  }) as ArticleListItem;
const detail = (id: string, o: Partial<ArticleListItem> = {}): ArticleDetail =>
  ({ ...item(id, o), html: `<p>${id}</p>`, contentFormat: "html", aiSummary: null, aiSummarizedAt: null, readAt: null }) as ArticleDetail;

const row = (i: ArticleListItem, o: Partial<IndexRow> = {}): IndexRow => ({
  key: `u:${i.id}`,
  userId: "u",
  id: i.id,
  item: i,
  readLater: false,
  savedAt: 0,
  lastAccess: 0,
  openedAt: null,
  bytes: 1,
  ...o,
});

describe("itemsForScope (offline list fallback)", () => {
  const rows = [
    row(item("later1", { isReadLater: true, publishedAt: "2026-02-01T00:00:00Z" }), { readLater: true }),
    row(item("later2", { isReadLater: true, publishedAt: "2026-03-01T00:00:00Z", isRead: true }), { readLater: true }),
    row(item("seen1", { feedId: "f2", isStarred: true, labelIds: ["L"] }), { openedAt: 5 }),
    row(item("seen2"), { openedAt: 9 }),
  ];
  const key = (scopeKey: string, show: "all" | "unread" = "all", sort: "new" | "old" = "new") => ({ scopeKey, show, sort });

  it("Read later: newest first, `old` reverses, unread filter applies", () => {
    expect(itemsForScope(rows, key("v:later"))!.map((i) => i.id)).toEqual(["later2", "later1"]);
    expect(itemsForScope(rows, key("v:later", "all", "old"))!.map((i) => i.id)).toEqual(["later1", "later2"]);
    expect(itemsForScope(rows, key("v:later", "unread"))!.map((i) => i.id)).toEqual(["later1"]);
  });

  it("Recently read offline: opened rows, last opened first", () => {
    expect(itemsForScope(rows, key("v:recent"))!.map((i) => i.id)).toEqual(["seen2", "seen1"]);
  });

  it("starred / feed / label / all", () => {
    expect(itemsForScope(rows, key("v:starred"))!.map((i) => i.id)).toEqual(["seen1"]);
    expect(itemsForScope(rows, key("feed:f2"))!.map((i) => i.id)).toEqual(["seen1"]);
    expect(itemsForScope(rows, key("label:L"))!.map((i) => i.id)).toEqual(["seen1"]);
    expect(itemsForScope(rows, key("all"))!.length).toBe(4);
  });

  it("scopes the store cannot answer fall through to the network error", () => {
    for (const k of ["cat:c1", "ss:s1", "q:rust", "v:spoiler"]) expect(itemsForScope(rows, key(k))).toBeNull();
  });
});

let scope: OfflineScope;

describe("reconcileReadLater", () => {
  beforeEach(async () => {
    await clearAllOffline();
    scope = { userId: "u", gen: (await claimSession("u"))!.gen };
  });

  function deps(laterIds: string[], o: Partial<ReconcileDeps> = {}, fetched: string[] = []): ReconcileDeps {
    return {
      fetchPage: async (): Promise<ArticlePage> => ({ items: laterIds.map((id) => item(id, { isReadLater: true })), nextCursor: null }),
      fetchDetail: async (id) => {
        fetched.push(id);
        return detail(id, { isReadLater: true });
      },
      pause: async () => {},
      saveData: () => false,
      stopped: () => false,
      ...o,
    };
  }

  it("stores bodies of Read-later articles it does not have yet, once", async () => {
    const fetched: string[] = [];
    const first = await reconcileReadLater(scope, deps(["a", "b"], {}, fetched));
    expect(first).toMatchObject({ saved: 2, missing: 0, failed: false });
    expect((await getBody("u", "a"))?.html).toBe("<p>a</p>");
    await reconcileReadLater(scope, deps(["a", "b"], {}, fetched));
    expect(fetched).toEqual(["a", "b"]); // no refetch of what is stored
    expect((await listRows("u")).every((r) => r.readLater)).toBe(true);
  });

  it("demotes articles that left Read later but keeps their body as recent", async () => {
    await reconcileReadLater(scope, deps(["a", "b"]));
    const result = await reconcileReadLater(scope, deps(["b"]));
    expect(result.demoted).toBe(1);
    const rows = await listRows("u");
    expect(rows.find((r) => r.id === "a")?.readLater).toBe(false);
    expect(rows.find((r) => r.id === "b")?.readLater).toBe(true);
    expect(await getBody("u", "a")).toBeDefined();
  });

  it("a failed server read changes nothing (never wipes the store offline)", async () => {
    await reconcileReadLater(scope, deps(["a"]));
    const result = await reconcileReadLater(scope, deps([], { fetchPage: async () => { throw new TypeError("Failed to fetch"); } }));
    expect(result.failed).toBe(true);
    expect((await listRows("u"))[0].readLater).toBe(true);
  });

  it("respects Save-Data: lists are mirrored, bodies are not fetched", async () => {
    const fetched: string[] = [];
    const result = await reconcileReadLater(scope, deps(["a"], { saveData: () => true }, fetched));
    expect(fetched).toEqual([]);
    expect(result).toMatchObject({ saved: 0, missing: 1 });
  });

  it("throttles to a bounded number of bodies per run", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `x${i}`);
    const result = await reconcileReadLater(scope, deps(ids), 4);
    expect(result).toMatchObject({ saved: 4, missing: 6 });
  });

  it("logout while a body is in flight: the late response is dropped and nothing is written", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let signedOut = false;
    const controller = new AbortController();
    const pass = reconcileReadLater(
      scope,
      deps(["a", "b"], {
        signal: controller.signal,
        stopped: () => signedOut,
        fetchDetail: async (id) => {
          await gate; // the response is "delayed" past the logout
          return detail(id, { isReadLater: true });
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20)); // the pass is parked on the first fetch
    signedOut = true;
    controller.abort();
    await clearAllOffline(); // logout: rows and session gone
    release();
    const result = await pass;
    expect(result.saved).toBe(0);
    expect(await listRows("u")).toEqual([]);
    expect(await getBody("u", "a")).toBeUndefined();
  });

  it("even if the pass does not notice (no stopped() hook), the generation check in the transaction refuses the write", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const pass = reconcileReadLater(scope, deps(["a"], { fetchDetail: async (id) => (await gate, detail(id, { isReadLater: true })) }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await clearAllOffline();
    await claimSession("other"); // next account on the same device
    release();
    const result = await pass;
    expect(result.saved).toBe(0);
    expect(await listRows("u")).toEqual([]);
    expect(await listRows("other")).toEqual([]);
  });

  it("passes the abort signal to the requests", async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    await reconcileReadLater(
      scope,
      deps(["a"], {
        signal: controller.signal,
        fetchPage: async (_cursor, signal) => (seen.push(signal), { items: [item("a", { isReadLater: true })], nextCursor: null }),
        fetchDetail: async (id, signal) => (seen.push(signal), detail(id, { isReadLater: true })),
      }),
    );
    expect(seen).toEqual([controller.signal, controller.signal]);
  });

  it("storage full: stops the pass and says so (no hammering)", async () => {
    const real = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "bodies") {
        this.transaction.abort();
        throw new DOMException("quota", "QuotaExceededError");
      }
      return real.apply(this, args);
    } as typeof real;
    const fetched: string[] = [];
    try {
      const result = await reconcileReadLater(scope, deps(["a", "b", "c"], {}, fetched));
      expect(result).toMatchObject({ saved: 0, quota: true });
      expect(fetched).toEqual(["a"]);
    } finally {
      IDBObjectStore.prototype.put = real;
    }
  });

  it("an opened non-later article does not count against Read later", async () => {
    await saveArticle(scope, detail("seen"), { opened: true, readLater: false });
    await reconcileReadLater(scope, deps(["a"]));
    expect((await listRows("u")).find((r) => r.id === "seen")?.readLater).toBe(false);
    expect(MAX_RECENT).toBe(50);
  });
});

describe("public/offline-reader.js contract", () => {
  const js = readFileSync("public/offline-reader.js", "utf8");
  const read = (name: string) => new RegExp(`var ${name} = (.+?);`).exec(js)?.[1];

  it("reads the same DB layout the app writes", () => {
    expect(read("DB_NAME")).toBe(JSON.stringify(OFFLINE_DB_NAME));
    expect(read("DB_VERSION")).toBe(String(OFFLINE_DB_VERSION));
    expect(read("INDEX_STORE")).toBe(JSON.stringify(INDEX_STORE));
    expect(read("BODY_STORE")).toBe(JSON.stringify(BODY_STORE));
    expect(read("META_STORE")).toBe(JSON.stringify(META_STORE));
    expect(read("SESSION_KEY")).toBe(JSON.stringify(SESSION_KEY));
    expect(new Function(`return ${read("MAX_AGE_MS")}`)()).toBe(OFFLINE_MAX_AGE_MS);
    expect(read("MAX_RECENT")).toBe(String(MAX_RECENT));
  });

  it("never creates the DB (an empty v1 would block the app's schema upgrade)", () => {
    expect(js).toContain("open.transaction.abort()");
  });

  it("is precached by the service worker", () => {
    const sw = readFileSync("public/sw.js", "utf8");
    expect(sw).toContain('"/offline-reader.js"');
    expect(sw).toContain('"/offline.html"');
  });
});

describe("service worker rules", () => {
  const sw = readFileSync("public/sw.js", "utf8");
  it("never caches authenticated API responses or navigations", () => {
    expect(sw).toMatch(/pathname\.startsWith\("\/api\/"\)\) return/);
    expect(sw).not.toMatch(/cache\.put\(request/); // runtime puts only go through the cacheable() guard helpers
    expect(sw).toContain("NAVIGATION_TIMEOUT_MS = 8000");
    expect(sw).toMatch(/_next\/static\/.*\n\s*event\.respondWith\(cacheFirst/);
  });
});
