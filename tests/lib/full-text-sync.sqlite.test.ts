// Full-text churn regression (diagnosis R5 / F-P0-1): runs the real syncFeed
// against a real SQLite DB with "auto" full-text mode. Only the feed fetch, the
// page fetch (SSRF layer) and the render sidecar are faked — the extraction
// ensemble and quality gate are real.
//
//  - re-syncing an unchanged feed causes ZERO page fetches
//  - the feed teaser never overwrites stored full text
//  - a failed fetch never replaces stored full text
//  - full-text writes never advance Article.updatedAt
//  - only genuine upstream changes trigger exactly one re-extraction
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const state = vi.hoisted(() => ({
  db: null as unknown as PrismaClient,
  fetchFeed: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
  page: null as unknown as (url: string) => Promise<string>,
  pageFetches: [] as string[],
  aiCalls: 0,
}));
vi.mock("@/lib/ai-extraction", () => ({
  extractArticleWithAi: async () => {
    state.aiCalls++;
    return null;
  },
}));
vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
  getDatabaseProvider: () => "sqlite",
}));
vi.mock("@/lib/feed-fetcher", async (importOriginal) => {
  state.fetchFeed = vi.fn();
  return { ...(await importOriginal<typeof import("../../lib/feed-fetcher")>()), fetchFeedArticles: state.fetchFeed };
});
vi.mock("@/lib/ssrf", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/ssrf")>();
  return {
    ...real,
    isTrustedFeedFetchingAllowed: async () => false,
    fetchTextWithSsrfProtection: async (url: string) => {
      state.pageFetches.push(url);
      return state.page(url);
    },
  };
});
vi.mock("@/lib/render-sidecar", () => ({ renderViaSidecar: async () => null }));

import { syncFeed, upsertArticleBatch } from "../../lib/rss-sync";
import { refetchArticleFullText } from "../../lib/full-text-fetch";
import { FULL_TEXT_STATE_SELECT, recordFullTextMiss } from "../../lib/full-text-store";
import { HttpStatusError } from "../../lib/ssrf";
import { resetHostBackoff } from "../../lib/host-backoff";
import { resetTransportMemory } from "../../lib/readability-extract";

const dir = mkdtempSync(join(tmpdir(), "feedferret-fulltext-sync-"));
let userId = "";

const P = (id: string, n: number) =>
  `<p>Full body paragraph ${n} of story ${id}: the council's district heating plan, its financing, the construction timeline and the tenants' objections, explained in detail.</p>`;
const fullPage = (id: string) =>
  `<!doctype html><html><head><title>Story ${id}</title></head><body><article><h1>Story ${id}</h1>${Array.from({ length: 8 }, (_, n) => P(id, n)).join("")}</article></body></html>`;
const teaser = (id: string, version = 1) => `<p>Teaser ${id} v${version}</p>`;

function items(versions: Record<string, number> = {}, links: Record<string, string> = {}) {
  return ["1", "2", "3"].map((id, n) => ({
    title: `Story ${id}`,
    link: links[id] ?? `https://news${id}.example/story-${id}`,
    content: teaser(id, versions[id] ?? 1),
    externalId: `guid-${id}`,
    publishedAt: new Date(Date.UTC(2026, 10, 10, 12 - n)),
  }));
}

async function rows(feedId: string) {
  return state.db.article.findMany({
    where: { feedId },
    orderBy: { externalId: "asc" },
    select: {
      id: true,
      externalId: true,
      content: true,
      feedContent: true,
      fullTextStatus: true,
      fullTextReason: true,
      fullTextAttempts: true,
      updatedAt: true,
    },
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

beforeAll(async () => {
  const url = `file:${join(dir, "test.db")}`;
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.generated.prisma"], {
    env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: url },
    stdio: "pipe",
  });
  state.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  userId = (await state.db.user.create({ data: { email: "ft@test", name: "FT" } })).id;
}, 120_000);

afterAll(async () => {
  await state.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  resetHostBackoff();
  resetTransportMemory();
  state.pageFetches = [];
  state.aiCalls = 0;
  state.page = async (url) => fullPage(url.slice(-1));
  state.fetchFeed.mockReset();
  state.fetchFeed.mockImplementation(async () => ({ title: "News", articles: items() }));
  await state.db.feed.deleteMany({ where: { userId } });
});

async function autoFeed() {
  return state.db.feed.create({ data: { userId, name: "News", url: "https://news.example/feed.xml", fullTextMode: "auto" } });
}

describe("auto full text: no churn", () => {
  it("extracts new articles once; an unchanged re-sync makes zero page fetches and keeps full text + updatedAt", async () => {
    const feed = await autoFeed();
    await syncFeed(userId, feed.id);
    expect(state.pageFetches).toHaveLength(3);
    const first = await rows(feed.id);
    for (const row of first) {
      expect(row.fullTextStatus).toBe("ok");
      expect(row.content).toContain("Full body paragraph 7");
      expect(row.feedContent).toMatch(/^<p>Teaser \d v1<\/p>$/);
    }

    await tick();
    state.pageFetches = [];
    // Even if every page would now fail, an unchanged feed must not touch them.
    state.page = async () => {
      throw new HttpStatusError(429, "Fetch failed: 429");
    };
    await syncFeed(userId, feed.id);
    await syncFeed(userId, feed.id);
    expect(state.pageFetches).toEqual([]);
    expect(await rows(feed.id)).toEqual(first);
  });

  it("a genuine upstream change re-extracts only that article; a failed fetch keeps the stored full text", async () => {
    const feed = await autoFeed();
    await syncFeed(userId, feed.id);
    const before = await rows(feed.id);

    await tick();
    state.pageFetches = [];
    state.page = async () => {
      throw new HttpStatusError(503, "Fetch failed: 503");
    };
    state.fetchFeed.mockImplementation(async () => ({ title: "News", articles: items({ "2": 2 }) }));
    await syncFeed(userId, feed.id);

    // impit + plain transport for the one changed article, nothing else.
    expect(new Set(state.pageFetches)).toEqual(new Set(["https://news2.example/story-2"]));
    const after = await rows(feed.id);
    const changed = after.find((r) => r.externalId === "guid-2")!;
    expect(changed.content).toBe(before.find((r) => r.externalId === "guid-2")!.content); // full text kept
    expect(changed.feedContent).toBe(teaser("2", 2)); // upstream change recorded
    expect(changed.fullTextStatus).toBe("failed");
    expect(changed.fullTextReason).toBe("http_503");
    expect(changed.fullTextAttempts).toBe(1);
    // Unchanged rows are untouched (incl. updatedAt).
    expect(after.filter((r) => r.externalId !== "guid-2")).toEqual(before.filter((r) => r.externalId !== "guid-2"));
  });

  it("a failed first attempt is retried by later syncs (bounded), host backoff defers instead of fetching", async () => {
    const feed = await autoFeed();
    state.page = async () => {
      throw new HttpStatusError(429, "Fetch failed: 429");
    };
    await syncFeed(userId, feed.id);
    let current = await rows(feed.id);
    // The first 429 backs the whole host off; each article sits on its own host here.
    expect(current.map((r) => r.fullTextStatus)).toEqual(["failed", "failed", "failed"]);
    expect(current.every((r) => r.content.startsWith("<p>Teaser"))).toBe(true);

    // Hosts are still backing off: next sync defers, no fetches.
    state.pageFetches = [];
    await syncFeed(userId, feed.id);
    expect(state.pageFetches).toEqual([]);
    current = await rows(feed.id);
    expect(current.map((r) => r.fullTextStatus)).toEqual(["deferred", "deferred", "deferred"]);

    // Backoff over: retried and succeeds.
    resetHostBackoff();
    state.page = async (url) => fullPage(url.slice(-1));
    await syncFeed(userId, feed.id);
    current = await rows(feed.id);
    expect(current.map((r) => r.fullTextStatus)).toEqual(["ok", "ok", "ok"]);
  });

  it("stops retrying after MAX attempts until the item changes upstream", async () => {
    const feed = await autoFeed();
    state.page = async () => {
      throw new HttpStatusError(404, "Fetch failed: 404"); // permanent: no host backoff
    };
    for (let i = 0; i < 5; i++) await syncFeed(userId, feed.id);
    const current = await rows(feed.id);
    expect(current.map((r) => r.fullTextAttempts)).toEqual([3, 3, 3]);
    // 3 attempts per article, permanent failures are not retried on the other transport.
    expect(state.pageFetches).toHaveLength(9);
  });

  it("rejects a consent wall / teaser page, keeps the feed content and never re-fetches it", async () => {
    const feed = await autoFeed();
    state.page = async () =>
      `<!doctype html><html><body><main><div><h2>Before you continue</h2><p>We and our 170 vendors use cookies and process personal data such as IP addresses and device identifiers for personalised ads and content, ad and content measurement, audience research and services development.</p><p>Click Accept all to give your consent, or manage your privacy settings at any time. You can withdraw your consent later in the footer of every page.</p></div></main></body></html>`;
    await syncFeed(userId, feed.id);
    const current = await rows(feed.id);
    expect(current.map((r) => r.fullTextStatus)).toEqual(["rejected", "rejected", "rejected"]);
    expect(current.map((r) => r.fullTextReason)).toEqual(["consent_wall", "consent_wall", "consent_wall"]);
    expect(current.every((r) => r.content.startsWith("<p>Teaser") && r.feedContent === null)).toBe(true);

    state.pageFetches = [];
    await syncFeed(userId, feed.id);
    expect(state.pageFetches).toEqual([]);
  });

  it("adopts legacy full text (rows from before feedContent) without fetching and without touching updatedAt", async () => {
    const feed = await autoFeed();
    await syncFeed(userId, feed.id);
    // Simulate pre-migration rows: full text in content, no feedContent / status.
    await state.db.article.updateMany({
      where: { feedId: feed.id },
      data: { feedContent: null, fullTextStatus: null, fullTextReason: null },
    });
    const legacy = await rows(feed.id);

    await tick();
    state.pageFetches = [];
    await syncFeed(userId, feed.id);
    expect(state.pageFetches).toEqual([]);
    const after = await rows(feed.id);
    for (const [i, row] of after.entries()) {
      expect(row.content).toBe(legacy[i].content);
      expect(row.feedContent).toMatch(/^<p>Teaser/);
      expect(row.fullTextStatus).toBe("ok");
      expect(row.updatedAt.getTime()).toBe(legacy[i].updatedAt.getTime());
    }
  });

  it("feeds without full-text mode never fetch pages", async () => {
    const feed = await state.db.feed.create({ data: { userId, name: "Plain", url: "https://plain.example/feed.xml" } });
    await syncFeed(userId, feed.id);
    await syncFeed(userId, feed.id);
    expect(state.pageFetches).toEqual([]);
  });

  it("a genuine source-link change (same teaser) invalidates stored full text and re-extracts once", async () => {
    const feed = await autoFeed();
    await syncFeed(userId, feed.id);
    state.pageFetches = [];
    state.page = async () =>
      `<!doctype html><html><body><article><h1>Moved</h1>${Array.from({ length: 8 }, (_, n) => P("moved", n)).join("")}</article></body></html>`;
    state.fetchFeed.mockImplementation(async () => ({ title: "News", articles: items({}, { "3": "https://elsewhere.example/story-3-new" }) }));
    await syncFeed(userId, feed.id);
    expect(state.pageFetches).toEqual(["https://elsewhere.example/story-3-new"]);
    const moved = (await rows(feed.id)).find((r) => r.externalId === "guid-3")!;
    expect(moved.fullTextStatus).toBe("ok");
    expect(moved.content).toContain("story moved");
    // and only once
    state.pageFetches = [];
    await syncFeed(userId, feed.id);
    expect(state.pageFetches).toEqual([]);
  });

  it("a cosmetic link rewrite does not invalidate stored full text", async () => {
    const feed = await autoFeed();
    await syncFeed(userId, feed.id);
    const row = await state.db.article.findFirstOrThrow({ where: { feedId: feed.id, externalId: "guid-1" } });
    const result = await upsertArticleBatch([
      {
        feedId: feed.id,
        userId,
        title: row.title,
        link: "https://news1.example/story-1?resolved",
        linkCosmetic: true,
        externalId: row.externalId,
        dedupeKey: row.dedupeKey!,
        contentHash: row.contentHash,
        content: row.feedContent!,
        excerpt: row.excerpt ?? "",
        author: row.author,
        publishedAt: row.publishedAt,
        imageUrl: row.imageUrl,
        enclosures: row.enclosures,
      },
    ], { fullTextActive: true });
    expect(result.fullTextCandidateIds).toEqual([]);
    const after = await state.db.article.findFirstOrThrow({ where: { id: row.id } });
    expect(after.link).toBe("https://news1.example/story-1?resolved");
    expect(after.fullTextStatus).toBe("ok");
    expect(after.updatedAt.getTime()).toBe(row.updatedAt.getTime());
  });
});

describe("full text: concurrency (stale results are discarded)", () => {
  it("manual fetch in flight while a sync records an upstream change: the stale full text is discarded", async () => {
    const feed = await state.db.feed.create({ data: { userId, name: "Manual", url: "https://manual.example/feed.xml" } });
    await syncFeed(userId, feed.id); // mode off: teasers only
    const target = await state.db.article.findFirstOrThrow({ where: { feedId: feed.id, externalId: "guid-1" } });
    let afterSync: Date | null = null;
    state.page = async (url) => {
      // Interleave deterministically: the sync lands between snapshot and store.
      state.fetchFeed.mockImplementation(async () => ({ title: "News", articles: items({ "1": 2 }) }));
      await tick();
      await syncFeed(userId, feed.id);
      afterSync = (await state.db.article.findFirstOrThrow({ where: { id: target.id } })).updatedAt;
      return fullPage(url.slice(-1));
    };
    await expect(refetchArticleFullText(userId, target.id)).rejects.toThrow(/updated while/);
    const row = await state.db.article.findFirstOrThrow({ where: { id: target.id } });
    expect(row.content).toBe(teaser("1", 2)); // the new upstream version, not v1's full text
    expect(row.feedContent).toBeNull();
    expect(row.fullTextStatus).toBeNull();
    expect(afterSync).not.toBeNull();
    expect(row.updatedAt.getTime()).toBe(afterSync!.getTime()); // never rolled back
    expect(row.updatedAt.getTime()).toBeGreaterThan(target.updatedAt.getTime());
  });

  it("sync extraction in flight while a manual fetch stores full text: the sync result is discarded", async () => {
    const feed = await autoFeed();
    state.fetchFeed.mockImplementation(async () => ({ title: "News", articles: items().slice(0, 1) }));
    let nested = false;
    let manualDone = false;
    state.page = async (url) => {
      if (nested) return fullPage("manual");
      nested = true;
      const row = await state.db.article.findFirstOrThrow({ where: { link: url, feedId: feed.id } });
      await refetchArticleFullText(userId, row.id);
      manualDone = true;
      return fullPage("sync");
    };
    await syncFeed(userId, feed.id);
    expect(manualDone).toBe(true);
    const [row] = await rows(feed.id);
    expect(row.content).toContain("story manual");
    expect(row.content).not.toContain("story sync");
    expect(row.feedContent).toBe(teaser("1"));
  });

  it("concurrent failed attempts never lose an increment", async () => {
    const feed = await state.db.feed.create({ data: { userId, name: "Plain", url: "https://plain2.example/feed.xml" } });
    await syncFeed(userId, feed.id);
    const snap = await state.db.article.findFirstOrThrow({ where: { feedId: feed.id, externalId: "guid-1" }, select: FULL_TEXT_STATE_SELECT });
    const results = await Promise.all([
      recordFullTextMiss(snap, "failed", "http_503"),
      recordFullTextMiss(snap, "failed", "http_503"),
      recordFullTextMiss(snap, "failed", "http_503"),
    ]);
    expect(results).toEqual([true, true, true]);
    const row = await state.db.article.findFirstOrThrow({ where: { id: snap.id } });
    expect(row.fullTextAttempts).toBe(3);
    expect(row.updatedAt.getTime()).toBe(snap.updatedAt.getTime());
  });
});

describe("full text: AI escalation is bounded per sync", () => {
  it("ai mode spends at most MAX AI extractions per sync, and only with an AI provider configured", async () => {
    const many = Array.from({ length: 8 }, (_, n) => ({
      title: `Walled ${n}`,
      link: `https://walled${n}.example/story`,
      content: `<p>Teaser walled ${n}</p>`,
      externalId: `walled-${n}`,
      publishedAt: new Date(Date.UTC(2026, 10, 10, 12 - n)),
    }));
    state.fetchFeed.mockImplementation(async () => ({ title: "News", articles: many }));
    state.page = async () =>
      `<!doctype html><html><body><main><div><p>We and our 170 vendors use cookies and process personal data such as IP addresses and device identifiers for personalised ads and content, ad and content measurement.</p><p>Click Accept all to give your consent, or manage your privacy settings at any time.</p></div></main></body></html>`;

    // No AI provider: AI never runs even in "ai" mode.
    const noAi = await state.db.feed.create({ data: { userId, name: "AI", url: "https://ai.example/feed.xml", fullTextMode: "ai" } });
    await syncFeed(userId, noAi.id);
    expect(state.aiCalls).toBe(0);

    await state.db.feed.deleteMany({ where: { userId } });
    resetHostBackoff();
    await state.db.user.update({ where: { id: userId }, data: { aiProvider: "openai" } });
    try {
      const feed = await state.db.feed.create({ data: { userId, name: "AI", url: "https://ai2.example/feed.xml", fullTextMode: "ai" } });
      await syncFeed(userId, feed.id);
      expect(state.aiCalls).toBe(5);
    } finally {
      await state.db.user.update({ where: { id: userId }, data: { aiProvider: null } });
    }
  });
});
