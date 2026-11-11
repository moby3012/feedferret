// "Defekte Feeds" server actions against a real SQLite DB: listing, ownership on
// every feed id, re-test (real syncFeed; only the network fetch is faked) unmuting
// a recovered feed, repair, bulk removal re-validation and the rate limit.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const h = vi.hoisted(() => ({
  db: null as unknown as PrismaClient,
  session: { id: "" as string | null },
  fetchFeed: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
  discover: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
}));
vi.mock("@/lib/db", () => ({
  get db() {
    return h.db;
  },
  getDatabaseProvider: () => "sqlite",
}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => (h.session.id ? { user: { id: h.session.id } } : null)) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/feed-fetcher", async (importOriginal) => {
  h.fetchFeed = vi.fn();
  return { ...(await importOriginal<typeof import("../../lib/feed-fetcher")>()), fetchFeedArticles: h.fetchFeed };
});
vi.mock("@/lib/feed-discovery", async (importOriginal) => {
  h.discover = vi.fn();
  return { ...(await importOriginal<typeof import("../../lib/feed-discovery")>()), discoverFeeds: h.discover };
});

import {
  applyFeedRepair,
  getBrokenFeeds,
  proposeFeedRepair,
  removeStaleBrokenFeeds,
  retestBrokenFeed,
  unmuteBrokenFeed,
} from "../../app/actions/broken-feeds";
import { checkRateLimit, RATE_LIMITS } from "../../lib/rate-limit";

const dir = mkdtempSync(join(tmpdir(), "feedferret-broken-"));
let alice = "";
let bob = "";
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

const okFeed = (n = 1) => ({
  title: "Recovered",
  articles: Array.from({ length: n }, (_, i) => ({
    title: `Item ${i}`,
    link: `https://ok.example/item-${i}`,
    content: "<p>hello</p>",
    externalId: `item-${i}`,
    publishedAt: new Date(Date.UTC(2026, 10, 10, 12 - i)),
  })),
});

async function makeFeed(userId: string, data: Record<string, unknown> = {}) {
  return h.db.feed.create({
    data: { userId, name: "Feed", url: `https://f${Math.random().toString(36).slice(2)}.example/feed.xml`, ...data } as any,
  });
}
const reload = (id: string) => h.db.feed.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  const url = `file:${join(dir, "test.db")}`;
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.generated.prisma"], {
    env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: url },
    stdio: "pipe",
  });
  h.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  alice = (await h.db.user.create({ data: { email: "alice@test", name: "Alice" } })).id;
  bob = (await h.db.user.create({ data: { email: "bob@test", name: "Bob" } })).id;
}, 120_000);

afterAll(async () => {
  await h.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  h.session.id = alice;
  h.fetchFeed.mockReset();
  h.discover.mockReset();
  await h.db.feed.deleteMany({});
});

describe("getBrokenFeeds", () => {
  it("lists muted and failing feeds of the user: muted first, then by failure count; healthy / newsletter / foreign feeds excluded", async () => {
    await makeFeed(alice, { name: "healthy" });
    await makeFeed(alice, { name: "failing-3", consecutiveFailureCount: 3, lastStatus: "error", lastError: "Error: Fetch failed: 500" });
    await makeFeed(alice, { name: "failing-7", consecutiveFailureCount: 7, lastStatus: "error", lastError: "TypeError: fetch failed" });
    await makeFeed(alice, { name: "muted", autoMuted: true, consecutiveFailureCount: 10, lastStatus: "error", lastError: "Error: Fetch failed: 403" });
    await makeFeed(alice, { name: "newsletter", sourceType: "newsletter", url: "newsletter:from:a@b.c", autoMuted: true, consecutiveFailureCount: 10 });
    await makeFeed(bob, { name: "bobs-broken", autoMuted: true, consecutiveFailureCount: 10 });

    const list = await getBrokenFeeds();
    expect(list.map((f) => f.name)).toEqual(["muted", "failing-7", "failing-3"]);
    expect(list.map((f) => f.category)).toEqual(["access", "unreachable", "server"]);
    expect(list[0]).toMatchObject({ autoMuted: true, consecutiveFailureCount: 10 });
  });

  it("returns host only, redacts secrets in the technical detail, and never leaks the URL", async () => {
    await makeFeed(alice, {
      name: "secret",
      url: "https://user:pw@secret-host.example/feed.xml?token=hunter2",
      consecutiveFailureCount: 2,
      lastError: "Error: Fetch failed: 500 https://secret-host.example/feed.xml?token=hunter2",
    });
    const [feed] = await getBrokenFeeds();
    expect(feed.host).toBe("secret-host.example");
    expect(JSON.stringify(feed)).not.toContain("hunter2");
    expect(JSON.stringify(feed)).not.toContain("user:pw");
  });

  it("derives 'failing since' (column, then last attempt) and 'last success' (column, then newest article)", async () => {
    const [d1, d3, d5, d6] = [daysAgo(1), daysAgo(3), daysAgo(5), daysAgo(6)];
    const withColumns = await makeFeed(alice, { name: "cols", consecutiveFailureCount: 2, failingSince: d5, lastSuccessAt: d6 });
    const legacy = await makeFeed(alice, { name: "legacy", consecutiveFailureCount: 2, lastFetchedAt: d1 });
    await h.db.article.create({
      data: { feedId: legacy.id, userId: alice, title: "t", link: "https://x/1", content: "", excerpt: "", publishedAt: d3, createdAt: d3, dedupeKey: "k1" } as any,
    });
    const list = await getBrokenFeeds();
    const a = list.find((f) => f.id === withColumns.id)!;
    const b = list.find((f) => f.id === legacy.id)!;
    expect(new Date(a.failingSince!).getTime()).toBe(d5.getTime());
    expect(new Date(a.lastSuccessAt!).getTime()).toBe(d6.getTime());
    expect(new Date(b.failingSince!).getTime()).toBe(d1.getTime());
    expect(new Date(b.lastSuccessAt!).getTime()).toBe(d3.getTime());
  });

  it("requires a session", async () => {
    h.session.id = null;
    await expect(getBrokenFeeds()).rejects.toThrow("Unauthorized");
  });
});

describe("ownership on every feed id", () => {
  it("rejects another user's feed in every per-feed action without touching it", async () => {
    const foreign = await makeFeed(bob, { name: "bobs", autoMuted: true, consecutiveFailureCount: 10 });
    const before = await reload(foreign.id);
    await expect(retestBrokenFeed(foreign.id)).rejects.toThrow("Feed not found");
    await expect(unmuteBrokenFeed(foreign.id)).rejects.toThrow("Feed not found");
    await expect(proposeFeedRepair(foreign.id)).rejects.toThrow("Feed not found");
    await expect(applyFeedRepair(foreign.id, "https://new.example/feed.xml")).rejects.toThrow("Feed not found");
    expect(h.fetchFeed).not.toHaveBeenCalled();
    expect(h.discover).not.toHaveBeenCalled();
    expect(await reload(foreign.id)).toEqual(before);
  });

  it("rejects missing sessions and junk ids", async () => {
    const own = await makeFeed(alice, { consecutiveFailureCount: 1 });
    await expect(retestBrokenFeed("")).rejects.toThrow("Feed not found");
    await expect(retestBrokenFeed(undefined as any)).rejects.toThrow("Feed not found");
    h.session.id = null;
    await expect(retestBrokenFeed(own.id)).rejects.toThrow("Unauthorized");
    await expect(unmuteBrokenFeed(own.id)).rejects.toThrow("Unauthorized");
    await expect(removeStaleBrokenFeeds([own.id])).rejects.toThrow("Unauthorized");
  });

  it("refuses newsletter feeds", async () => {
    const nl = await makeFeed(alice, { sourceType: "newsletter", url: "newsletter:from:x@y.z" });
    await expect(retestBrokenFeed(nl.id)).rejects.toThrow("Feed not found");
  });
});

describe("retestBrokenFeed", () => {
  it("on success unmutes, resets the counters and records the success — and leaves Article.updatedAt alone", async () => {
    const feed = await makeFeed(alice, { name: "was-down", consecutiveFailureCount: 1, lastStatus: "error", lastError: "boom" });
    h.fetchFeed.mockResolvedValue(okFeed(1));
    // First sync writes the article exactly like production would...
    expect((await retestBrokenFeed(feed.id)).status).toBe("recovered");
    const [article] = await h.db.article.findMany({ where: { feedId: feed.id } });
    // ...then the feed breaks, gets auto-muted, and a re-test finds it healthy again.
    await h.db.feed.update({
      where: { id: feed.id },
      data: { autoMuted: true, consecutiveFailureCount: 10, failingSince: daysAgo(40), lastStatus: "error", lastError: "Error: Fetch failed: 403" },
    });

    const result = await retestBrokenFeed(feed.id);
    expect(result).toEqual({ status: "recovered", feed: null });
    expect(h.fetchFeed).toHaveBeenCalledTimes(2);

    const after = await reload(feed.id);
    expect(after).toMatchObject({ autoMuted: false, consecutiveFailureCount: 0, failingSince: null, lastStatus: "ok", lastError: null });
    expect(after.lastSuccessAt).toBeInstanceOf(Date);
    expect(Date.now() - after.lastSuccessAt!.getTime()).toBeLessThan(10_000);
    expect((await getBrokenFeeds()).map((f) => f.id)).not.toContain(feed.id);
    const again = await h.db.article.findUniqueOrThrow({ where: { id: article.id } });
    expect(again.updatedAt).toEqual(article.updatedAt);
    expect(await h.db.article.count({ where: { feedId: feed.id } })).toBe(1);
  });

  it("on failure stays muted, bumps the counter, keeps the streak start and returns the plain category", async () => {
    const since = daysAgo(12);
    const feed = await makeFeed(alice, { autoMuted: true, consecutiveFailureCount: 10, failingSince: since, lastError: "old" });
    h.fetchFeed.mockRejectedValue(new Error("Fetch failed: 404"));

    const result = await retestBrokenFeed(feed.id);
    expect(result.status).toBe("still-broken");
    if (result.status !== "still-broken") throw new Error("unreachable");
    expect(result.feed).toMatchObject({ category: "not-found", autoMuted: true, consecutiveFailureCount: 11 });
    expect(new Date(result.feed!.failingSince!).getTime()).toBe(since.getTime());
    const after = await reload(feed.id);
    expect(after).toMatchObject({ autoMuted: true, consecutiveFailureCount: 11, lastStatus: "error" });
  });

  it("the first failure of a healthy feed starts the streak (failingSince)", async () => {
    const feed = await makeFeed(alice, { consecutiveFailureCount: 0 });
    h.fetchFeed.mockRejectedValue(new Error("Fetch failed: 500"));
    await retestBrokenFeed(feed.id);
    const after = await reload(feed.id);
    expect(after.consecutiveFailureCount).toBe(1);
    expect(after.failingSince).toBeInstanceOf(Date);
  });

  it("is rate limited per user and does not fetch once the budget is spent", async () => {
    // The limiter is in-memory and shared by the file: spend a dedicated user's budget.
    const carol = (await h.db.user.create({ data: { email: "carol@test", name: "Carol" } })).id;
    h.session.id = carol;
    const feed = await makeFeed(carol, { consecutiveFailureCount: 1 });
    h.fetchFeed.mockRejectedValue(new Error("Fetch failed: 500"));
    for (let i = 0; i < RATE_LIMITS.feedRetest.limit; i++) checkRateLimit(`user:${carol}`, RATE_LIMITS.feedRetest);
    h.fetchFeed.mockClear();
    const result = await retestBrokenFeed(feed.id);
    expect(result.status).toBe("rate-limited");
    expect(h.fetchFeed).not.toHaveBeenCalled();
    // another user is unaffected
    h.session.id = alice;
    const own = await makeFeed(alice, { consecutiveFailureCount: 1 });
    expect((await retestBrokenFeed(own.id)).status).toBe("still-broken");
  });
});

describe("unmuteBrokenFeed", () => {
  it("gives the feed a clean slate", async () => {
    const feed = await makeFeed(alice, { autoMuted: true, consecutiveFailureCount: 10, failingSince: daysAgo(3) });
    await unmuteBrokenFeed(feed.id);
    expect(await reload(feed.id)).toMatchObject({ autoMuted: false, consecutiveFailureCount: 0, failingSince: null });
  });
});

describe("repair", () => {
  it("proposes discovered feeds except the current one and ones the user already has", async () => {
    const feed = await makeFeed(alice, { url: "https://site.example/old/feed.xml", htmlUrl: "https://site.example/" });
    await makeFeed(alice, { url: "https://site.example/taken.xml" });
    h.discover.mockResolvedValue({
      mode: "url",
      feeds: [
        { url: "https://site.example/old/feed.xml", title: "same", type: "rss" },
        { url: "https://site.example/taken.xml", title: "taken", type: "rss" },
        { url: "https://site.example/new.xml", title: "New feed", type: "atom" },
        { url: "javascript:alert(1)", title: "bad", type: "rss" },
      ],
    });
    const proposal = await proposeFeedRepair(feed.id);
    expect(h.discover).toHaveBeenCalledWith("https://site.example/");
    expect(proposal).toMatchObject({ status: "ok", candidates: [{ url: "https://site.example/new.xml", title: "New feed" }] });
  });

  it("applies a verified URL: swaps it, resets conditional-GET + failure state and syncs", async () => {
    const feed = await makeFeed(alice, { url: "https://site.example/old.xml", autoMuted: true, consecutiveFailureCount: 10, etag: "e", failingSince: daysAgo(50) });
    h.fetchFeed.mockResolvedValue(okFeed(2));
    const result = await applyFeedRepair(feed.id, "https://site.example/new.xml");
    expect(result).toEqual({ success: true, recovered: true, feed: null });
    const after = await reload(feed.id);
    expect(after).toMatchObject({ url: "https://site.example/new.xml", autoMuted: false, consecutiveFailureCount: 0, failingSince: null, lastStatus: "ok" });
    expect(await h.db.article.count({ where: { feedId: feed.id } })).toBe(2);
  });

  it("refuses a URL that is not a readable feed and keeps the old one", async () => {
    const feed = await makeFeed(alice, { url: "https://site.example/old.xml", autoMuted: true, consecutiveFailureCount: 10 });
    h.fetchFeed.mockRejectedValue(new Error("Not a feed"));
    expect(await applyFeedRepair(feed.id, "https://site.example/html-page")).toEqual({ success: false, error: "not-a-feed" });
    expect(await reload(feed.id)).toMatchObject({ url: "https://site.example/old.xml", autoMuted: true, consecutiveFailureCount: 10 });
  });

  it("refuses duplicates, invalid and non-http URLs, and unsupported feed types", async () => {
    const feed = await makeFeed(alice, { url: "https://site.example/old.xml", consecutiveFailureCount: 1 });
    await makeFeed(alice, { url: "https://site.example/other.xml" });
    expect(await applyFeedRepair(feed.id, "https://site.example/other.xml")).toEqual({ success: false, error: "duplicate" });
    expect(await applyFeedRepair(feed.id, "javascript:alert(1)")).toEqual({ success: false, error: "invalid-url" });
    expect(await applyFeedRepair(feed.id, "x".repeat(3000))).toEqual({ success: false, error: "invalid-url" });
    const scraped = await makeFeed(alice, { sourceType: "HTML+XPath", consecutiveFailureCount: 1 });
    expect(await applyFeedRepair(scraped.id, "https://site.example/n.xml")).toEqual({ success: false, error: "unsupported" });
    expect(await proposeFeedRepair(scraped.id)).toEqual({ status: "unsupported" });
    expect(h.fetchFeed).not.toHaveBeenCalled();
  });
});

describe("removeStaleBrokenFeeds", () => {
  it("removes only own feeds whose streak is older than 30 days; re-validates every id", async () => {
    const old = await makeFeed(alice, { name: "old", autoMuted: true, consecutiveFailureCount: 10, failingSince: daysAgo(45) });
    const recent = await makeFeed(alice, { name: "recent", autoMuted: true, consecutiveFailureCount: 10, failingSince: daysAgo(10) });
    const recovered = await makeFeed(alice, { name: "recovered", consecutiveFailureCount: 0, failingSince: null, lastFetchedAt: daysAgo(90) });
    const handMuted = await makeFeed(alice, { name: "hand-muted", autoMuted: true, consecutiveFailureCount: 0, lastFetchedAt: daysAgo(90) });
    const newsletter = await makeFeed(alice, { sourceType: "newsletter", url: "newsletter:from:q@w.e", autoMuted: true, consecutiveFailureCount: 10, failingSince: daysAgo(90) });
    const foreign = await makeFeed(bob, { name: "bobs", autoMuted: true, consecutiveFailureCount: 10, failingSince: daysAgo(90) });

    const ids = [old, recent, recovered, handMuted, newsletter, foreign].map((f) => f.id);
    const result = await removeStaleBrokenFeeds([...ids, old.id, "", 5 as any]);
    expect(result).toEqual({ removed: 1, skipped: 5 });
    const left = (await h.db.feed.findMany({ select: { id: true } })).map((f) => f.id);
    expect(left).not.toContain(old.id);
    for (const keep of [recent, recovered, handMuted, newsletter, foreign]) expect(left).toContain(keep.id);
  });

  it("eligibility is part of the atomic delete: a feed that recovers after the list was shown survives", async () => {
    const stale = await makeFeed(alice, { name: "stale", autoMuted: true, consecutiveFailureCount: 10, failingSince: daysAgo(45) });
    const recovers = await makeFeed(alice, { name: "recovers", autoMuted: true, consecutiveFailureCount: 10, failingSince: daysAgo(45) });
    const ids = [stale.id, recovers.id];
    // The user saw both in the confirmation. Right before the delete runs, a sync recovers one of them.
    const findMany = vi.spyOn(h.db.feed, "findMany");
    const realDelete = h.db.feed.deleteMany.bind(h.db.feed);
    const deleteMany = vi.spyOn(h.db.feed, "deleteMany").mockImplementationOnce(((args: any) => {
      return h.db.feed
        .update({ where: { id: recovers.id }, data: { autoMuted: false, consecutiveFailureCount: 0, failingSince: null } })
        .then(() => realDelete(args));
    }) as any);
    try {
      expect(await removeStaleBrokenFeeds(ids)).toEqual({ removed: 1, skipped: 1 });
      expect(findMany).not.toHaveBeenCalled(); // no read-then-delete-by-ids
    } finally {
      findMany.mockRestore();
      deleteMany.mockRestore();
    }
    expect((await h.db.feed.findUnique({ where: { id: stale.id } }))).toBeNull();
    expect(await reload(recovers.id)).toMatchObject({ autoMuted: false, consecutiveFailureCount: 0 });
  });

  it("reports the real deleted count, not the number of ids sent", async () => {
    const a = await makeFeed(alice, { autoMuted: true, consecutiveFailureCount: 10, failingSince: daysAgo(40) });
    const b = await makeFeed(alice, { autoMuted: true, consecutiveFailureCount: 10, failingSince: daysAgo(40) });
    await h.db.feed.update({ where: { id: b.id }, data: { consecutiveFailureCount: 0, autoMuted: false, failingSince: null } });
    expect(await removeStaleBrokenFeeds([a.id, b.id])).toEqual({ removed: 1, skipped: 1 });
  });

  it("deletes the feed's articles with it and tolerates an empty list", async () => {
    const old = await makeFeed(alice, { autoMuted: true, consecutiveFailureCount: 10, failingSince: daysAgo(45) });
    await h.db.article.create({
      data: { feedId: old.id, userId: alice, title: "t", link: "https://x/2", content: "", excerpt: "", publishedAt: new Date(), dedupeKey: "k2" } as any,
    });
    expect(await removeStaleBrokenFeeds([])).toEqual({ removed: 0, skipped: 0 });
    expect(await removeStaleBrokenFeeds([old.id])).toEqual({ removed: 1, skipped: 0 });
    expect(await h.db.article.count({ where: { feedId: old.id } })).toBe(0);
  });
});
