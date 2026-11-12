// "Defekte Feeds" → inactive group + archive, against a real SQLite DB: classification
// (kaputt / inaktiv / ok, gone vs blocked), the archive/restore actions and their atomic guards,
// ownership, "Article.updatedAt is never touched", and every place an archived feed must disappear
// (background sync, shell feed list, unread counts, aggregate list scopes) or stay reachable (own feed
// view, search).
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
  syncedUrls: [] as string[],
}));
vi.mock("@/lib/db", () => ({
  get db() {
    return h.db;
  },
  getDatabaseProvider: () => "sqlite",
}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => (h.session.id ? { user: { id: h.session.id } } : null)) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/feed-fetcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/feed-fetcher")>()),
  fetchFeedArticles: vi.fn(async (feed: { url: string }) => {
    h.syncedUrls.push(feed.url);
    return { title: "x", articles: [] };
  }),
}));

import {
  archiveFeeds,
  archiveInactiveFeeds,
  getArchivedFeeds,
  getBrokenFeeds,
  getInactiveFeeds,
  restoreFeeds,
} from "../../app/actions/broken-feeds";
import { updateGlobalSettings } from "../../app/actions/settings";
import { addFeed } from "../../app/actions/feeds";
import { syncAllFeeds, syncUserFeeds } from "../../lib/rss-sync";
import { getCounts, loadFeeds, loadArchivedFeeds, loadReadingPreferences } from "../../server/bootstrap";
import { buildViewScope } from "../../server/articles/view-scope";

const dir = mkdtempSync(join(tmpdir(), "feedferret-archive-"));
let alice = "";
let bob = "";
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

let seq = 0;
async function makeFeed(userId: string, data: Record<string, unknown> = {}) {
  return h.db.feed.create({
    data: {
      userId,
      name: "Feed",
      url: `https://f${++seq}.example/feed.xml`,
      lastFetchedAt: daysAgo(0),
      lastStatus: "success",
      createdAt: daysAgo(1000),
      ...data,
    } as any,
  });
}
async function makeArticle(userId: string, feedId: string, publishedDaysAgo: number, data: Record<string, unknown> = {}) {
  return h.db.article.create({
    data: {
      userId,
      feedId,
      title: `Article ${++seq}`,
      link: `https://a.example/${seq}`,
      content: "<p>x</p>",
      publishedAt: daysAgo(publishedDaysAgo),
      externalId: `ext-${seq}`,
      ...data,
    } as any,
  });
}
const reload = (id: string) => h.db.feed.findUniqueOrThrow({ where: { id } });
const names = (list: Array<{ name: string }>) => list.map((f) => f.name).sort();

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
  h.syncedUrls.length = 0;
  await h.db.article.deleteMany({});
  await h.db.feed.deleteMany({});
  await h.db.user.update({ where: { id: alice }, data: { inactiveFeedDays: 180 } });
});

describe("classification: kaputt / inaktiv / ok", () => {
  it("keeps the three groups disjoint", async () => {
    const ok = await makeFeed(alice, { name: "ok" });
    await makeArticle(alice, ok.id, 3);
    const quiet = await makeFeed(alice, { name: "quiet" });
    await makeArticle(alice, quiet.id, 400);
    const broken = await makeFeed(alice, { name: "broken", consecutiveFailureCount: 4, lastStatus: "error", lastError: "Error: Fetch failed: 500" });
    await makeArticle(alice, broken.id, 400); // silent AND failing: the error is the diagnosis

    expect(names(await getBrokenFeeds())).toEqual(["broken"]);
    expect(names((await getInactiveFeeds()).feeds)).toEqual(["quiet"]);
  });

  it("separates gone (404/410) from blocked (403/429) and other errors", async () => {
    await makeFeed(alice, { name: "gone-404", consecutiveFailureCount: 2, lastError: "Error: Fetch failed: 404" });
    await makeFeed(alice, { name: "gone-410", consecutiveFailureCount: 2, lastError: "Error: Fetch failed: 410" });
    await makeFeed(alice, { name: "blocked-403", consecutiveFailureCount: 2, lastError: "Error: Fetch failed: 403" });
    await makeFeed(alice, { name: "blocked-429", consecutiveFailureCount: 2, lastError: "Error: Fetch failed: 429" });
    await makeFeed(alice, { name: "server-500", consecutiveFailureCount: 2, lastError: "Error: Fetch failed: 500" });
    await makeFeed(alice, { name: "dns", consecutiveFailureCount: 2, lastError: "Error: getaddrinfo ENOTFOUND nope.invalid" });
    await makeFeed(alice, { name: "parse", consecutiveFailureCount: 2, lastError: "Error: Non-whitespace before first tag." });

    const kinds = Object.fromEntries((await getBrokenFeeds()).map((f) => [f.name, f.kind]));
    expect(kinds).toEqual({
      "gone-404": "gone",
      "gone-410": "gone",
      "blocked-403": "blocked",
      "blocked-429": "blocked",
      "server-500": "error",
      dns: "error",
      parse: "error",
    });
  });
});

describe("getInactiveFeeds", () => {
  it("lists working feeds past the threshold with last item date and silent days, oldest first", async () => {
    const a = await makeFeed(alice, { name: "a-200d" });
    await makeArticle(alice, a.id, 200);
    await makeArticle(alice, a.id, 900); // the NEWEST item counts, not the oldest
    const b = await makeFeed(alice, { name: "b-400d" });
    await makeArticle(alice, b.id, 400);
    const c = await makeFeed(alice, { name: "c-fresh" });
    await makeArticle(alice, c.id, 179);

    const result = await getInactiveFeeds();
    expect(result.thresholdDays).toBe(180);
    expect(result.feeds.map((f) => f.name)).toEqual(["b-400d", "a-200d"]);
    expect(result.feeds[0]).toMatchObject({ articleCount: 1, host: expect.stringMatching(/\.example$/) });
    expect(result.feeds[0].inactiveDays).toBe(400);
    expect(new Date(result.feeds[1].lastItemAt!).getTime()).toBeGreaterThan(daysAgo(201).getTime());
    expect(result.feeds[1].articleCount).toBe(2);
  });

  it("a feed added just now whose only items are old is already inactive", async () => {
    const f = await makeFeed(alice, { name: "added-today", createdAt: new Date() });
    await makeArticle(alice, f.id, 365);
    const { feeds } = await getInactiveFeeds();
    expect(names(feeds)).toEqual(["added-today"]);
    expect(feeds[0].inactiveDays).toBe(365);
    expect(await archiveInactiveFeeds([f.id])).toEqual({ archived: 1, skipped: 0, archivedIds: [f.id] });
  });

  it("treats a feed that never delivered an item as silent since its creation", async () => {
    await makeFeed(alice, { name: "empty-old", createdAt: daysAgo(500) });
    await makeFeed(alice, { name: "empty-new", createdAt: daysAgo(10) });
    const { feeds } = await getInactiveFeeds();
    expect(names(feeds)).toEqual(["empty-old"]);
    expect(feeds[0].lastItemAt).toBeNull();
    expect(feeds[0].inactiveDays).toBe(500);
  });

  it("excludes never-fetched, muted, newsletter, archived and foreign feeds", async () => {
    const mk = async (data: Record<string, unknown>) => {
      const f = await makeFeed(data.userId ? (data.userId as string) : alice, data);
      await makeArticle(f.userId, f.id, 700);
      return f;
    };
    await mk({ name: "never-fetched", lastFetchedAt: null });
    await mk({ name: "muted", autoMuted: true });
    await mk({ name: "newsletter", sourceType: "newsletter", url: "newsletter:from:x@y.z" });
    await mk({ name: "archived", archivedAt: daysAgo(2) });
    await mk({ name: "bobs", userId: bob });
    await mk({ name: "included" });
    expect(names((await getInactiveFeeds()).feeds)).toEqual(["included"]);
  });

  it("follows the per-user threshold setting (clamped, validated)", async () => {
    const f = await makeFeed(alice, { name: "forty" });
    await makeArticle(alice, f.id, 40);
    expect((await getInactiveFeeds()).feeds).toHaveLength(0);

    await updateGlobalSettings({ inactiveFeedDays: 30 });
    const after = await getInactiveFeeds();
    expect(after.thresholdDays).toBe(30);
    expect(names(after.feeds)).toEqual(["forty"]);
    expect((await loadReadingPreferences(alice)).inactiveFeedDays).toBe(30);

    await updateGlobalSettings({ inactiveFeedDays: 1 });
    expect((await getInactiveFeeds()).thresholdDays).toBe(7);
    await updateGlobalSettings({ inactiveFeedDays: 999_999 });
    expect((await getInactiveFeeds()).thresholdDays).toBe(3650);
    await expect(updateGlobalSettings({ inactiveFeedDays: "x" as unknown as number })).rejects.toThrow(/Invalid inactiveFeedDays/);
    // another user's threshold is untouched
    expect((await h.db.user.findUniqueOrThrow({ where: { id: bob } })).inactiveFeedDays).toBe(180);
  });

  it("requires a session", async () => {
    h.session.id = null;
    await expect(getInactiveFeeds()).rejects.toThrow("Unauthorized");
    await expect(archiveFeeds(["x"])).rejects.toThrow("Unauthorized");
    await expect(archiveInactiveFeeds(["x"])).rejects.toThrow("Unauthorized");
    await expect(restoreFeeds(["x"])).rejects.toThrow("Unauthorized");
    await expect(getArchivedFeeds()).rejects.toThrow("Unauthorized");
  });
});

describe("archive / restore", () => {
  it("archives only the caller's feeds, idempotently, and restores them", async () => {
    const mine = await makeFeed(alice, { name: "mine" });
    const theirs = await makeFeed(bob, { name: "theirs" });

    expect(await archiveFeeds([mine.id, theirs.id, "", "x".repeat(200)])).toEqual({ archived: 1, archivedIds: [mine.id] });
    expect((await reload(mine.id)).archivedAt).toBeInstanceOf(Date);
    expect((await reload(theirs.id)).archivedAt).toBeNull();

    const firstDate = (await reload(mine.id)).archivedAt!;
    expect(await archiveFeeds([mine.id])).toEqual({ archived: 0, archivedIds: [] }); // already archived: untouched
    expect((await reload(mine.id)).archivedAt).toEqual(firstDate);

    expect(await restoreFeeds([mine.id, theirs.id])).toEqual({ restored: 1 });
    expect((await reload(mine.id)).archivedAt).toBeNull();
    expect(await restoreFeeds([mine.id])).toEqual({ restored: 0 });
  });

  it("archive actions return exactly the ids they archived (Undo must not restore anything else)", async () => {
    const quiet = await makeFeed(alice, { name: "quiet" });
    await makeArticle(alice, quiet.id, 300);
    const revived = await makeFeed(alice, { name: "revived" });
    await makeArticle(alice, revived.id, 300);
    const already = await makeFeed(alice, { name: "already", archivedAt: daysAgo(9) });
    await makeArticle(alice, already.id, 300);
    await makeArticle(alice, revived.id, 0); // published again after the list was shown

    const result = await archiveInactiveFeeds([quiet.id, revived.id, already.id]);
    expect(result).toEqual({ archived: 1, skipped: 2, archivedIds: [quiet.id] });
    // restoring "what was archived" leaves the feed that was archived before untouched
    await restoreFeeds(result.archivedIds);
    expect((await reload(already.id)).archivedAt).not.toBeNull();
    expect((await reload(quiet.id)).archivedAt).toBeNull();

    const manual = await archiveFeeds([quiet.id, already.id]);
    expect(manual.archivedIds).toEqual([quiet.id]);
    expect(manual.archived).toBe(1);
  });

  it("addFeed on the URL of an archived feed restores it instead of failing on the unique URL (no fetch)", async () => {
    const f = await makeFeed(alice, { name: "back again", url: "https://again.example/feed.xml", archivedAt: daysAgo(4) });
    const result = await addFeed("https://again.example/feed.xml");
    expect(result).toMatchObject({ success: true, restored: true, feed: { id: f.id } });
    expect((await reload(f.id)).archivedAt).toBeNull();
    expect(h.syncedUrls).toEqual([]); // nothing was fetched
    expect(await h.db.feed.count({ where: { userId: alice, url: "https://again.example/feed.xml" } })).toBe(1);
  });

  it("rejects malformed input", async () => {
    await expect(archiveFeeds("nope" as unknown as string[])).rejects.toThrow("Invalid input");
    await expect(archiveInactiveFeeds({} as unknown as string[])).rejects.toThrow("Invalid input");
    await expect(restoreFeeds(null as unknown as string[])).rejects.toThrow("Invalid input");
    expect(await archiveFeeds([])).toEqual({ archived: 0, archivedIds: [] });
  });

  it("never touches an article: updatedAt, read state and content stay as they were", async () => {
    const feed = await makeFeed(alice, { name: "quiet" });
    const article = await makeArticle(alice, feed.id, 400, { isRead: false, isStarred: true });
    const before = await h.db.article.findUniqueOrThrow({ where: { id: article.id } });

    await archiveInactiveFeeds([feed.id]);
    expect((await reload(feed.id)).archivedAt).not.toBeNull();
    await restoreFeeds([feed.id]);
    await archiveFeeds([feed.id]);

    const after = await h.db.article.findUniqueOrThrow({ where: { id: article.id } });
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after).toEqual(before);
  });

  it("archiveInactiveFeeds re-checks eligibility atomically: only still-inactive feeds are archived", async () => {
    const quiet = await makeFeed(alice, { name: "quiet" });
    await makeArticle(alice, quiet.id, 300);
    const revived = await makeFeed(alice, { name: "revived" });
    await makeArticle(alice, revived.id, 300);
    const failing = await makeFeed(alice, { name: "failing" });
    await makeArticle(alice, failing.id, 300);
    const muted = await makeFeed(alice, { name: "muted" });
    await makeArticle(alice, muted.id, 300);
    const theirs = await makeFeed(bob, { name: "theirs" });
    await makeArticle(bob, theirs.id, 300);
    const fresh = await makeFeed(alice, { name: "fresh" });
    await makeArticle(alice, fresh.id, 2);
    const newFeed = await makeFeed(alice, { name: "new-and-empty", createdAt: daysAgo(5) });

    const shown = [quiet, revived, failing, muted, theirs, fresh, newFeed].map((f) => f.id);
    // Between "list shown" and "confirm": revived publishes again, failing starts to fail, muted gets muted.
    await makeArticle(alice, revived.id, 0);
    await h.db.feed.update({ where: { id: failing.id }, data: { consecutiveFailureCount: 3 } });
    await h.db.feed.update({ where: { id: muted.id }, data: { autoMuted: true } });

    expect(await archiveInactiveFeeds(shown)).toMatchObject({ archived: 1, skipped: shown.length - 1, archivedIds: [quiet.id] });
    const archived = (await h.db.feed.findMany({ where: { archivedAt: { not: null } } })).map((f) => f.name);
    expect(archived).toEqual(["quiet"]);
  });

  it("archiving a broken feed removes it from the broken list; restoring brings it back", async () => {
    const f = await makeFeed(alice, { name: "dead", consecutiveFailureCount: 5, autoMuted: true, lastError: "Error: Fetch failed: 404" });
    expect(names(await getBrokenFeeds())).toEqual(["dead"]);
    await archiveFeeds([f.id]);
    expect(await getBrokenFeeds()).toEqual([]);
    await restoreFeeds([f.id]);
    expect(names(await getBrokenFeeds())).toEqual(["dead"]);
    // archiving does not rewrite the failure bookkeeping
    expect(await reload(f.id)).toMatchObject({ consecutiveFailureCount: 5, autoMuted: true });
  });

  it("getArchivedFeeds returns the caller's archived feeds with article counts and no secrets", async () => {
    const f = await makeFeed(alice, { name: "old", archivedAt: daysAgo(3), authType: "basic", authUsername: "u", authPassword: "pw-secret" });
    await makeArticle(alice, f.id, 500);
    await makeArticle(alice, f.id, 501, { isRead: true });
    await makeFeed(alice, { name: "active" });
    await makeFeed(bob, { name: "bobs", archivedAt: daysAgo(1) });

    const list = await getArchivedFeeds();
    expect(list.map((x: any) => x.name)).toEqual(["old"]);
    expect(list[0]).toMatchObject({ articleCount: 2, unreadCount: 1 });
    expect(JSON.stringify(list)).not.toContain("pw-secret");
  });
});

describe("archived feeds leave the reader but keep their articles", () => {
  it("background sync skips archived feeds and resumes after restore", async () => {
    const live = await makeFeed(alice, { name: "live", lastFetchedAt: daysAgo(2) });
    const archived = await makeFeed(alice, { name: "archived", lastFetchedAt: daysAgo(2), archivedAt: daysAgo(1) });

    await syncAllFeeds();
    expect(h.syncedUrls).toEqual([live.url]);

    h.syncedUrls.length = 0;
    await restoreFeeds([archived.id]);
    await syncAllFeeds();
    // `live` was just synced and is not due again; the restored feed is picked up on the next pass.
    expect(h.syncedUrls).toEqual([archived.url]);
  });

  it("the shell feed list and unread counts exclude archived feeds; the archived list has them", async () => {
    const live = await makeFeed(alice, { name: "live" });
    const gone = await makeFeed(alice, { name: "gone", archivedAt: daysAgo(1) });
    await makeArticle(alice, live.id, 1);
    await makeArticle(alice, gone.id, 1);
    await makeArticle(alice, gone.id, 2);

    expect((await loadFeeds(alice)).map((f: any) => f.name)).toEqual(["live"]);
    expect((await loadArchivedFeeds(alice)).map((f: any) => f.name)).toEqual(["gone"]);

    const counts = await getCounts(alice);
    expect(counts.unreadTotal).toBe(1);
    expect(counts.byFeed[live.id]).toBe(1);

    await restoreFeeds([gone.id]);
    expect((await getCounts(alice)).unreadTotal).toBe(3);
  });

  it("aggregate list scopes skip archived feeds, but the feed's own view, search, starred and labels still show them", async () => {
    const cat = await h.db.category.create({ data: { userId: alice, name: "News" } });
    const live = await makeFeed(alice, { name: "live", categoryId: cat.id });
    const gone = await makeFeed(alice, { name: "gone", categoryId: cat.id, archivedAt: daysAgo(1) });
    const liveArticle = await makeArticle(alice, live.id, 1, { title: "findable zebra live" });
    const goneArticle = await makeArticle(alice, gone.id, 1, { title: "findable zebra archived" });
    const starred = await makeArticle(alice, gone.id, 2, { title: "starred archived", isStarred: true, isRead: true });

    const ids = async (scope: Parameters<typeof buildViewScope>[1], search?: string) =>
      (await h.db.article.findMany({ where: (await buildViewScope(alice, scope, search)).where, select: { id: true } })).map((a) => a.id).sort();

    expect(await ids({ kind: "all" })).toEqual([liveArticle.id]);
    expect(await ids({ kind: "unread-only" })).toEqual([liveArticle.id]);
    expect(await ids({ kind: "category", id: cat.id })).toEqual([liveArticle.id]);
    expect(await ids({ kind: "category-name", name: "News" })).toEqual([liveArticle.id]);

    // still reachable
    expect(await ids({ kind: "feed", id: gone.id })).toEqual([goneArticle.id, starred.id].sort());
    expect(await ids({ kind: "starred" })).toEqual([starred.id]);
    expect(await ids({ kind: "query", q: "zebra" })).toEqual([liveArticle.id, goneArticle.id].sort());
    expect(await ids({ kind: "all" }, "zebra")).toEqual([liveArticle.id, goneArticle.id].sort());
  });
});
