/** Recorded-style URL/form contracts, modeled on FreshRSS a24ff145 (no network).
 * Real disposable SQLite queries ensure OR/AND, relation filters and cursors execute.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = vi.hoisted(() => ({ url: "", ids: new Map<string, string>(), queries: 0, sql: [] as { query: string; params: string }[] }));
vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
  // The adapter opens lazily after beforeAll creates the schema.
  const dir = mkdtempSync(join(tmpdir(), "greader-contract-"));
  fixture.url = `file:${join(dir, "test.db")}`;
  const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: fixture.url }), log: [{ emit: "event", level: "query" }] });
  db.$on("query", (event) => { fixture.queries++; if (event.query.includes("ORDER BY") && event.query.includes("LIMIT")) fixture.sql.push({ query: event.query, params: event.params }); });
  const { withExternalIds } = await import("@/lib/external-id-store");
  const extended = withExternalIds(db);
  return { db: extended.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
    const result = await query(args);
    if (["Article", "Feed", "Category", "Label"].includes(model) && ["create", "createMany"].includes(operation)) {
      const data = (args as { data: unknown }).data;
      for (const row of (Array.isArray(data) ? data : [data]) as { id?: string; extId?: string }[]) {
        if (row.id && row.extId) fixture.ids.set(row.id, BigInt(row.extId).toString());
      }
    }
    return result;
  } } } }) };

});
vi.mock("@/lib/greader", async (original) => ({
  ...await original<typeof import("@/lib/greader")>(),
  authenticateGReaderRequest: vi.fn(async () => ({ id: "u", email: "u@example.org" })),
}));
vi.mock("@/lib/rss-sync", () => ({ syncFeed: vi.fn() }));
vi.mock("@/lib/feed-fetcher", () => ({ fetchFeedArticles: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => ({ success: true }), getClientIdentifier: () => "u", RATE_LIMITS: { greader: {} } }));
import { db } from "@/lib/db";
import { GET, POST } from "@/app/api/greader/[...path]/route";
import { authenticateGReaderRequest, parseGReaderItemId, greaderLimit, greaderItemId as encodeItemId } from "@/lib/greader";
const fixtureId = (id: string) => fixture.ids.get(id) || id;
const greaderItemId = (id: string) => encodeItemId(fixtureId(id));
const state = (s: string) => `user/-/state/com.google/${s}`;
const label = "user/-/label/Tech";
const epoch = 1700000000;
const date = (sec: number) => new Date(sec * 1000);
async function request(path: string, values: Record<string, string> = {}, method = "GET", repeated: [string, string][] = [], status = 200) {
  const params = new URLSearchParams([...Object.entries(values), ...repeated]);
  const url = `http://localhost/api/greader/reader/api/0/${path}`;
  const response = method === "GET"
    ? await GET(new Request(`${url}?${params}`), { params: Promise.resolve({ path: ["reader", "api", "0", ...path.split("/")] }) })
    : await POST(new Request(url, { method, body: params }), { params: Promise.resolve({ path: ["reader", "api", "0", ...path.split("/")] }) });
  expect(response.status).toBe(status);
  return response.headers.get("content-type")?.includes("json") ? response.json() : response.text();
}
async function article(id: string, offset = 0, extra = {}) {
  return db.article.create({ data: { id, ...(/^\d+$/.test(id) ? { extId: id.padStart(19, "0") } : {}), userId: "u", feedId: "f", title: id, link: `https://example.org/${id}`, content: "<p>Full body</p>", excerpt: "Short", publishedAt: date(epoch - 10000), createdAt: date(epoch + offset), updatedAt: date(epoch + offset), ...extra } });
}
const refs = (result: { itemRefs: { id: string }[] }) => result.itemRefs.map((r) => encodeItemId(r.id));
beforeAll(() => {
  execFileSync("node_modules/.bin/prisma", ["db", "push", "--schema", "prisma/schema.generated.prisma"], { env: { ...process.env, DATABASE_URL: fixture.url }, stdio: "pipe" });
}, 30000);
beforeEach(async () => {
  await db.user.deleteMany();
  await db.user.create({ data: { id: "u", email: "u@example.org" } });
  await db.user.create({ data: { id: "other", email: "other@example.org" } });
  await db.category.create({ data: { id: "cat", userId: "u", name: "Tech" } });
  await db.label.create({ data: { id: "tag", userId: "u", name: "Tech" } });
  await db.feed.create({ data: { id: "f", userId: "u", name: "Example", url: "https://example.org/rss", htmlUrl: "https://example.org", categoryId: "cat" } });
  await db.feed.create({ data: { id: "g", userId: "u", name: "Elsewhere", url: "https://other.org/rss", priority: "category" } });
});
afterAll(async () => { await db.$disconnect(); rmSync(join(fixture.url.slice(5), ".."), { recursive: true, force: true }); });
describe("FreshRSS stream contracts", () => {
  it("ANDs unread/starred/feed/label targets and repeated include/exclude filters", async () => {
    await article("a", 0, { isStarred: true }); await article("b", 1, { isRead: true, isStarred: true });
    await article("c", 2, { feedId: "g" });
    const get = (s: string, extra = {}) => request("stream/items/ids", { s, ...extra });
    expect(refs(await get(state("unread")))).toEqual([greaderItemId("c"), greaderItemId("a")]);
    expect(refs(await get(label, { xt: state("read") }))).toEqual([greaderItemId("a")]);
    expect(refs(await get(state("starred"), { it: state("unread") }))).toEqual([greaderItemId("a")]);
    expect(refs(await get("feed/https://example.org/rss", { it: label, xt: state("starred") }))).toEqual([]);
    expect(refs(await get(state("read"), { xt: state("read") }))).toEqual([]);
    expect(refs(await get(state("reading-list"), { it: label }))).toEqual([greaderItemId("b"), greaderItemId("a")]);
    expect(refs(await get(state("reading-list"), { xt: label }))).toEqual([greaderItemId("c")]);
  });
  it("handles main/important/hidden priority and unknown targets", async () => {
    await article("a"); await article("b", 1, { feedId: "g" });
    await db.feed.update({ where: { id: "g" }, data: { priority: "hidden" } });
    expect(refs(await request("stream/items/ids"))).toEqual([greaderItemId("a")]);
    expect(refs(await request("stream/items/ids", { s: "user/-/state/org.freshrss/main" }))).toEqual([greaderItemId("a")]);
    expect(refs(await request("stream/items/ids", { s: "user/-/state/org.freshrss/important" }))).toEqual([]);
    await db.feed.update({ where: { id: "f" }, data: { priority: "important" } });
    expect(refs(await request("stream/items/ids", { s: "user/-/state/org.freshrss/important" }))).toEqual([greaderItemId("a")]);
    expect(refs(await request("stream/items/ids", { s: "unknown" }))).toEqual([greaderItemId("a")]);
  });
  it("uses inclusive discovery bounds plus modification time, ignoring publication", async () => {
    await article("a", -1, { updatedAt: date(epoch + 1) });
    await article("b", 0); await article("c", 1); await article("d", 2);
    expect(refs(await request("stream/items/ids", { ot: String(epoch), nt: String(epoch + 1) }))).toEqual(["c", "b", "a"].map(greaderItemId));
  });
  it.each([["o", "stream/items/ids"], ["d", "stream/items/ids"], ["o", "stream/contents"], ["d", "stream/contents"]])("paginates label scopes exactly once (%s, %s), discovery ties and arrivals with old publication dates", async (r, endpoint) => {
    for (const id of ["a", "b", "c", "d"]) await article(id);
    await article("outside", 0, { feedId: "g" });
    const seen: string[] = []; let c = "";
    do {
      const page = await request(endpoint, { s: label, n: "1", r, c });
      seen.push(...(page.itemRefs || page.items).map((item: { id: string }) => page.itemRefs ? encodeItemId(item.id) : item.id)); c = page.continuation || "";
      if (seen.length === 1) await article("arrival", 100, { publishedAt: date(epoch - 999999) });
    } while (c && seen.length < 10);
    expect(seen).toEqual((r === "o" ? ["a", "b", "c", "d"] : ["d", "c", "b", "a"]).map(greaderItemId));
  });
  it("supports bounded large pages and safely defaults invalid n", async () => {
    await db.article.createMany({ data: Array.from({ length: 205 }, (_, i) => ({ id: `item${i}`, userId: "u", feedId: "f", title: "Item", content: "body", link: "https://example.org", publishedAt: date(epoch), createdAt: date(epoch), updatedAt: date(epoch) })) });
    for (const n of ["10000", "0", "-1"]) expect(refs(await request("stream/items/ids", { n }))).toHaveLength(205);
    expect(refs(await request("stream/items/ids", { n: "invalid" }))).toHaveLength(20);
  });
  it("returns full HTML/Markdown bodies, origin, discovery clocks, states and enclosures", async () => {
    await article("123", 0, { isRead: true, isStarred: true, contentFormat: "markdown", content: "**Complete** body", enclosures: JSON.stringify([{ href: "https://example.org/a.mp3", type: "audio/mpeg", length: 42 }]) });
    const result = await request("stream/items/contents", { r: "o" }, "POST", [["i", "tag:google.com,2005:reader/item/000000000000007b"], ["i", "123"], ["i", "foreign"]]);
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.id).toBe(greaderItemId("123"));
    expect(item.summary.content).toContain("<strong>Complete</strong> body");
    expect(item.content).toEqual(item.summary);
    expect(item.origin).toEqual({ streamId: `feed/${fixtureId("f")}`, title: "Example", htmlUrl: "https://example.org" });
    expect(item.canonical).toEqual([{ href: "https://example.org/123" }]);
    expect(item.alternate).toEqual(item.canonical);
    expect(item.enclosure).toEqual([{ href: "https://example.org/a.mp3", type: "audio/mpeg", length: 42 }]);
    expect(item.timestampUsec).toBe(String(epoch * 1000000)); expect(item.crawlTimeMsec).toBe(String(epoch * 1000));
    expect(item.categories).toEqual(expect.arrayContaining([label, state("read"), state("starred")]));
    const stream = await request("stream/contents", { s: label }); expect(stream.items[0]).toEqual(item);
  });
  it("accepts raw decimal and namespaced hex refs without precision loss, ordering both ways", async () => {
    await article("9007199254740993", 1); await article("123", 0);
    const ids: [string, string][] = [["i", "9007199254740993"], ["i", "tag:google.com,2005:reader/item/000000000000007b"]];
    const asc = await request("stream/items/contents", { r: "o" }, "POST", ids);
    expect(asc.items.map((item: { id: string }) => item.id)).toEqual(["123", "9007199254740993"].map(greaderItemId));
    const desc = await request("stream/items/contents", {}, "GET", ids);
    expect(desc.items.map((item: { id: string }) => item.id)).toEqual(["9007199254740993", "123"].map(greaderItemId));
    expect((await request("stream/items/contents", {}, "POST")).items).toEqual([]);
  });
  it("counts feed/folder/label unions once and reports newest discovery including read articles", async () => {
    await article("a"); await article("b", 10, { isRead: true }); await article("c", 5, { feedId: "g" });
    await db.articleLabel.create({ data: { articleId: "c", labelId: "tag", userId: "u" } });
    const result = await request("unread-count");
    expect(result.max).toBe(2);
    expect(result.unreadcounts.find((x: { id: string }) => x.id === label)).toEqual({ id: label, count: 2, newestItemTimestampUsec: String((epoch + 10) * 1000000) });
    expect(result.unreadcounts.find((x: { id: string }) => x.id === `feed/${fixtureId("f")}`).count).toBe(1);
  });
  it("scopes edits to owned IDs and bulk read to discovery ts and stream", async () => {
    await article("a"); await article("b", 10); await article("foreign", 0, { userId: "other" });
    await request("edit-tag", { a: state("starred") }, "POST", [["i", greaderItemId("a")], ["i", "foreign"]]);
    expect((await db.article.findUniqueOrThrow({ where: { id: "a" } })).isStarred).toBe(true);
    expect((await db.article.findUniqueOrThrow({ where: { id: "foreign" } })).isStarred).toBe(false);
    await request("edit-tag", { a: label }, "POST", [["i", "a"], ["i", "foreign"]]);
    expect(await db.articleLabel.count()).toBe(1);
    await request("edit-tag", { r: label }, "POST", [["i", "a"]]);
    expect(await db.articleLabel.count()).toBe(0);
    const stamp = (await db.article.findUniqueOrThrow({ where: { id: "a" } })).updatedAt;
    await request("mark-all-as-read", { s: label, ts: String(epoch * 1000000) }, "POST");
    const marked = await db.article.findUniqueOrThrow({ where: { id: "a" } });
    expect(marked.isRead).toBe(true);
    // Read state is user state: the bulk mark leaves the GReader `updated` / ot clock alone.
    expect(marked.updatedAt).toEqual(stamp);
    expect((await db.article.findUniqueOrThrow({ where: { id: "b" } })).isRead).toBe(false);
    await request("mark-all-as-read", { s: "unknown" }, "POST", [], 400);
    expect((await db.article.findUniqueOrThrow({ where: { id: "b" } })).isRead).toBe(false);
  });
});

it("bounds unread-count SQL queries with 300 feeds", async () => {
  await db.feed.createMany({ data: Array.from({ length: 298 }, (_, i) => ({ id: `scale${i}`, userId: "u", name: `Feed ${i}`, url: `https://scale${i}.org/rss` })) });
  await article("scale-article");
  fixture.queries = 0;
  const result = await request("unread-count");
  // Constant (independent of the 300 feeds): spoiler/non-spoiler unread groupBys, no-extId groupBy, newest-per-feed groupBy, ...
  expect(fixture.queries).toBe(11);
  expect(result.unreadcounts.filter((x: { id: string }) => x.id.startsWith("feed/"))).toHaveLength(300);
});

it("unread-count: totals, per-feed counts and newest timestamps equal a brute-force oracle (spoilers, hidden feeds, legacy rows without extId)", async () => {
  await db.feed.create({ data: { id: "h", userId: "u", name: "Hidden", url: "https://hidden.org/rss", priority: "hidden" } });
  await db.feed.create({ data: { id: "m", userId: "u", name: "Main", url: "https://main.org/rss", priority: "main", categoryId: "cat" } });
  await article("a1", 0); await article("a2", 3, { isRead: true }); await article("a3", 4, { isSpoiler: true });
  await article("g1", 5, { feedId: "g" }); await article("m1", 6, { feedId: "m", isSpoiler: true }); await article("m2", 7, { feedId: "m", isRead: true });
  await article("h1", 8, { feedId: "h" }); await article("o1", 9, { userId: "other", feedId: "f" });
  await article("legacy", 12, { feedId: "g" });
  // Pre-backfill row: GReader never lists it, so it must not count towards the reading list.
  await db.$executeRawUnsafe(`UPDATE "Article" SET "extId" = NULL WHERE "id" = 'legacy'`);
  await db.articleLabel.create({ data: { articleId: "g1", labelId: "tag", userId: "u" } });

  const feeds = await db.feed.findMany({ where: { userId: "u" } });
  const articles = await db.article.findMany({ where: { userId: "u" } });
  const inReadingList = (f: { priority: string; extId: string | null }) => !!f.extId && ["category", "main", "important"].includes(f.priority);
  const expectedMax = articles.filter((a) => !a.isRead && a.extId && inReadingList(feeds.find((f) => f.id === a.feedId)!)).length;

  const counts = await request("unread-count");
  expect(counts.max).toBe(expectedMax);
  expect(counts.unreadcounts[0]).toMatchObject({ id: state("reading-list"), count: expectedMax });
  for (const feed of feeds.filter((f) => f.extId && f.priority !== "hidden")) {
    const own = articles.filter((a) => a.feedId === feed.id);
    const entry = counts.unreadcounts.find((x: { id: string }) => x.id === `feed/${fixtureId(feed.id)}`);
    expect(entry, feed.id).toEqual({
      id: `feed/${fixtureId(feed.id)}`,
      count: own.filter((a) => !a.isRead).length,
      newestItemTimestampUsec: String(Math.max(0, ...own.map((a) => a.createdAt.getTime())) * 1000),
    });
  }
  expect(counts.unreadcounts.some((x: { id: string }) => x.id === `feed/${fixtureId("h")}`)).toBe(false);
  expect(counts.unreadcounts.map((x: { id: string }) => x.id).slice(0, 2)).toEqual([state("reading-list"), state("starred")]);
  // Newest reading-list timestamp ignores the legacy row (exact fallback) ...
  const newestListed = (rows: typeof articles) => String(Math.max(...rows.filter((a) => a.extId && inReadingList(feeds.find((f) => f.id === a.feedId)!)).map((a) => a.createdAt.getTime())) * 1000);
  expect(counts.unreadcounts[0].newestItemTimestampUsec).toBe(newestListed(articles));
  expect(Number(counts.unreadcounts[0].newestItemTimestampUsec)).toBeLessThan(date(epoch + 12).getTime() * 1000);
  // ... and once the legacy row is gone the derived fast path returns the same shape and numbers.
  await db.article.delete({ where: { id: "legacy" } });
  const after = await request("unread-count");
  const remaining = articles.filter((a) => a.id !== "legacy");
  expect(after.unreadcounts[0]).toEqual({ id: state("reading-list"), count: expectedMax, newestItemTimestampUsec: newestListed(remaining) });
  expect(after.max).toBe(expectedMax);
});

it("ignores unknown read filters and falls back for unknown content streams", async () => {
  await article("a");
  for (const endpoint of ["stream/items/ids", "stream/contents"]) {
    const result = await request(endpoint, { s: "unknown", it: "unknown", xt: "also-unknown" });
    expect((result.itemRefs || result.items).map((x: { id: string }) => result.itemRefs ? encodeItemId(x.id) : x.id)).toEqual([greaderItemId("a")]);
  }
});
it("excludes out-of-bound discoveries and modifications for ot/nt", async () => {
  await article("old", -10); await article("modified", -10, { updatedAt: date(epoch + 10) });
  await article("future", 10); await article("inside", 0);
  expect(refs(await request("stream/items/ids", { ot: String(epoch), nt: String(epoch + 1) }))).toEqual([greaderItemId("inside")]);
});
it("isolates stream IDs, contents and unread counts from another user", async () => {
  await db.feed.create({ data: { id: "foreign-feed", userId: "other", name: "Other", url: "https://private.org", categoryId: null } });
  await article("foreign", 100, { userId: "other", feedId: "foreign-feed", isStarred: true });
  await article("own");
  expect(refs(await request("stream/items/ids"))).toEqual([greaderItemId("own")]);
  expect(refs(await request("stream/items/ids", { s: "feed/https://private.org" }))).toEqual([]);
  for (const method of ["GET", "POST"]) expect((await request("stream/items/contents", {}, method, [["i", "foreign"]])).items).toEqual([]);
  const counts = await request("unread-count");
  expect(counts.max).toBe(1);
  expect(counts.unreadcounts.some((x: { id: string }) => x.id === "feed/https://private.org")).toBe(false);
  expect(counts.unreadcounts.find((x: { id: string }) => x.id === state("starred")).count).toBe(0);
});
it("counts folder/label overlap once, includes labels outside folders, and handles empty tags", async () => {
  await article("both"); await article("label-only", 2, { feedId: "g" });
  await db.articleLabel.createMany({ data: ["both", "label-only"].map(articleId => ({ articleId, labelId: "tag", userId: "u" })) });
  await db.label.create({ data: { name: "Empty", userId: "u" } });
  const counts = (await request("unread-count")).unreadcounts;
  expect(counts.find((x: { id: string }) => x.id === label)).toEqual({ id: label, count: 2, newestItemTimestampUsec: String((epoch + 2) * 1000000) });
  expect(counts.find((x: { id: string }) => x.id === "user/-/label/Empty").count).toBe(0);
});
it("bounds content pages but preserves large ID pages", async () => {
  await db.article.createMany({ data: Array.from({ length: 1002 }, (_, i) => ({ id: `limit${i}`, userId: "u", feedId: "f", title: "Item", content: "body", link: "https://example.org", publishedAt: date(epoch), createdAt: date(epoch) })) });
  expect((await request("stream/contents", { n: "10000" })).items).toHaveLength(250);
  for (const n of ["0", "-1"]) expect((await request("stream/contents", { n })).items).toHaveLength(20);
  expect(refs(await request("stream/items/ids", { n: "10000" }))).toHaveLength(1002);
});
it("deduplicates, caps and chunks explicit IDs on GET/POST contents and edit-tag", async () => {
  const ids: [string, string][] = Array.from({ length: 1001 }, (_, i) => ["i", `batch${i}`]);
  for (const method of ["GET", "POST"]) await request("stream/items/contents", {}, method, ids, 400);
  await request("edit-tag", { a: state("read") }, "POST", ids, 400);
  await db.article.createMany({ data: ids.slice(0, 401).map(([, id]) => ({ id, userId: "u", feedId: "f", title: id, content: "body", link: "https://example.org", publishedAt: date(epoch), createdAt: date(epoch) })) });
  const batches = ids.slice(0, 401);
  const spy = vi.spyOn(db.article, "findMany");
  const result = await request("stream/items/contents", {}, "POST", [...batches, ...batches, ...batches]);
  expect(result.items).toHaveLength(401);
  expect(spy).toHaveBeenCalledTimes(3);
  expect(spy.mock.calls.every(([args]) => (args?.where?.OR?.[1]?.id as { in: string[] }).in.length <= 200)).toBe(true);
  spy.mockRestore();
  await request("edit-tag", { a: state("read") }, "POST", batches);
  expect(await db.article.count({ where: { isRead: true } })).toBe(401);
});
it("marks all without a cutoff for ts=0 and rejects invalid timestamps", async () => {
  await article("a");
  await request("mark-all-as-read", { ts: "invalid" }, "POST", [], 400);
  await request("mark-all-as-read", { ts: "0" }, "POST");
  expect((await db.article.findUniqueOrThrow({ where: { id: "a" } })).isRead).toBe(true);
});
it("survives corrupt enclosure JSON and omits empty authors", async () => {
  await article("a", 0, { enclosures: "{broken", author: "  " });
  const item = (await request("stream/contents")).items[0];
  expect(item).not.toHaveProperty("enclosure"); expect(item).not.toHaveProperty("author");
});
it("returns 401 only for failed authentication and 500 for server failures", async () => {
  vi.mocked(authenticateGReaderRequest).mockResolvedValueOnce(null);
  await request("stream/items/ids", {}, "GET", [], 401);
  vi.mocked(authenticateGReaderRequest).mockRejectedValueOnce(new Error("DB unavailable"));
  await request("stream/items/ids", {}, "GET", [], 500);
  const spy = vi.spyOn(db.article, "findMany").mockRejectedValueOnce(new Error("DB unavailable"));
  await request("mark-all-as-read", {}, "POST", [], 500);
  spy.mockRestore();
});
it.each(["o", "d"])("uses the discovery index for the actual paginated endpoint SQL (%s)", async (r) => {
  await article("a"); await article("b"); await article("c", 1);
  const first = await request("stream/items/ids", { n: "1", r });
  fixture.sql = [];
  await request("stream/items/ids", { n: "1", r, c: first.continuation });
  const query = fixture.sql.find(row => row.query.includes('ORDER BY') && row.query.includes('LIMIT'));
  expect(query).toBeDefined();
  // Includes the real stream relation, cursor OR, ceiling OR, order and limit.
  expect(query!.query).toContain('priority');
  const plan = await db.$queryRawUnsafe<Array<{ detail: string }>>(`EXPLAIN QUERY PLAN ${query!.query}`, ...JSON.parse(query!.params));
  const details = plan.map(row => row.detail).join(" ");
  expect(details).toContain("Article_userId_createdAt_id_idx");
  expect(details).not.toContain("TEMP B-TREE");
});

it.each(["category", "main", "important", "feed", "hidden"])("filters folder/label unions consistently for priority %s", async (priority) => {
  await db.feed.update({ where: { id: "f" }, data: { priority } });
  await db.feed.update({ where: { id: "g" }, data: { priority } });
  await article("folder"); await article("tagged", 1, { feedId: "g" });
  await db.articleLabel.createMany({ data: ["folder", "tagged"].map(articleId => ({ articleId, labelId: "tag", userId: "u" })) });
  const visible = ["category", "main", "important"].includes(priority);
  expect(refs(await request("stream/items/ids", { s: label }))).toEqual(visible ? ["tagged", "folder"].map(greaderItemId) : []);
  const counts = (await request("unread-count")).unreadcounts;
  expect(counts.find((x: { id: string }) => x.id === label)).toEqual({ id: label, count: visible ? 2 : 0, newestItemTimestampUsec: visible ? String((epoch + 1) * 1000000) : "0" });
});
it("keeps starred feed-only articles and excludes hidden articles as FreshRSS does", async () => {
  await db.feed.update({ where: { id: "f" }, data: { priority: "feed" } });
  await db.feed.update({ where: { id: "g" }, data: { priority: "hidden" } });
  await article("visible", 0, { isStarred: true });
  await article("hidden", 1, { feedId: "g", isStarred: true });
  expect(refs(await request("stream/items/ids", { s: state("starred") }))).toEqual([greaderItemId("visible")]);
  expect(refs(await request("stream/items/ids"))).toEqual([]);
  const counts = (await request("unread-count")).unreadcounts;
  expect(counts.find((x: { id: string }) => x.id === state("starred"))).toEqual({ id: state("starred"), count: 1, newestItemTimestampUsec: String(epoch * 1000000) });
});
it("retains newest read discovery for feeds, folders, labels and starred even with no unread articles", async () => {
  await article("folder", 10, { isRead: true, isStarred: true });
  await article("tagged", 20, { feedId: "g", isRead: true, isStarred: true });
  await db.articleLabel.create({ data: { articleId: "tagged", labelId: "tag", userId: "u" } });
  await db.label.create({ data: { id: "solo", userId: "u", name: "Solo" } });
  await db.articleLabel.create({ data: { articleId: "tagged", labelId: "solo", userId: "u" } });
  const counts = (await request("unread-count")).unreadcounts;
  for (const [id, offset] of [[state("reading-list"), 20], [state("starred"), 20], [label, 20], ["user/-/label/Solo", 20], [`feed/${fixtureId("f")}`, 10], [`feed/${fixtureId("g")}`, 20]] as const) {
    expect(counts.find((x: { id: string }) => x.id === id)).toEqual({ id, count: 0, newestItemTimestampUsec: String((epoch + offset) * 1000000) });
  }
});
it.each(["stream/items/ids", "stream/contents"])("applies one inclusive-second nt boundary to both clocks on %s", async (endpoint) => {
  await article("discovered", 0.999); await article("modified", -1, { updatedAt: date(epoch + 0.999) });
  await article("next-discovery", 1); await article("next-modification", -1, { updatedAt: date(epoch + 1) });
  const result = await request(endpoint, { nt: String(epoch) });
  expect((result.itemRefs || result.items).map((x: { id: string }) => result.itemRefs ? encodeItemId(x.id) : x.id)).toEqual(["discovered", "modified"].map(greaderItemId));
});
it.each(["stream/items/ids", "stream/contents"])("rejects invalid ot/nt before querying on %s", async (endpoint) => {
  for (const param of ["ot", "nt"]) {
    for (const value of ["1e100", "-1e100", "Infinity", "NaN", "invalid", "8640000000001"]) {
      fixture.queries = 0;
      await request(endpoint, { [param]: value }, "GET", [], 400);
      expect(fixture.queries).toBe(0);
    }
  }
});
it("preserves bare references and only decodes explicitly namespaced hex", async () => {
  for (const id of ["000000000000007b", "abcdef0123456789", "0123456789012345", "9007199254740993"]) expect(parseGReaderItemId(id)).toBe(id);
  expect(parseGReaderItemId("tag:google.com,2005:reader/item/000000000000007b")).toBe("123");
  await article("abcdef0123456789");
  expect((await request("stream/items/contents", {}, "POST", [["i", "abcdef0123456789"]])).items).toHaveLength(1);
  await request("edit-tag", { a: state("starred") }, "POST", [["i", "abcdef0123456789"]]);
  expect((await db.article.findUniqueOrThrow({ where: { id: "abcdef0123456789" } })).isStarred).toBe(true);
});
it("caps ID pages at 10000 with continuations for nonpositive and huge n", async () => {
  await db.article.createMany({ data: Array.from({ length: 10001 }, (_, i) => ({ id: `cap${i}`, userId: "u", feedId: "f", title: "Item", content: "body", link: "https://example.org", publishedAt: date(epoch), createdAt: date(epoch), updatedAt: date(epoch) })) });
  for (const n of ["0", "-1", "1000000000", "1e100"]) {
    const page = await request("stream/items/ids", { n });
    expect(page.itemRefs).toHaveLength(10000); expect(page.continuation).toBeTruthy();
    expect(refs(await request("stream/items/ids", { n, c: page.continuation }))).toHaveLength(1);
  }
  for (const n of [null, "", "invalid"]) {
    expect(greaderLimit(n)).toBe(20); expect(greaderLimit(n, false)).toBe(20);
  }
  for (const n of ["0", "-1"]) {
    expect(greaderLimit(n)).toBe(10000); expect(greaderLimit(n, false)).toBe(20);
  }
  expect(greaderLimit("100000", false)).toBe(250);
}, 30000);

it("skips null article/feed identities until a repeatable backfill catches up", async () => {
  await article("ready"); await article("pending");
  await db.article.update({ where: { id: "pending" }, data: { extId: null } });
  expect(refs(await request("stream/items/ids"))).toEqual([greaderItemId("ready")]);
  expect((await request("stream/contents")).items).toHaveLength(1);
  const { backfillExternalIds } = await import("@/lib/external-id-store");
  await backfillExternalIds(db as unknown as import("@prisma/client").PrismaClient);
  const assigned = (await db.article.findUniqueOrThrow({ where: { id: "pending" } })).extId;
  await backfillExternalIds(db as unknown as import("@prisma/client").PrismaClient);
  expect((await db.article.findUniqueOrThrow({ where: { id: "pending" } })).extId).toBe(assigned);
  expect((await request("stream/contents")).items).toHaveLength(2);
  await db.feed.update({ where: { id: "f" }, data: { extId: null } });
  expect((await request("stream/contents")).items).toHaveLength(0);
  expect((await request("subscription/list")).subscriptions).toHaveLength(1);
  await backfillExternalIds(db as unknown as import("@prisma/client").PrismaClient);
  expect((await request("stream/contents")).items).toHaveLength(2);
});
it("allocates unique IDs under concurrent creates and preserves IDs on upsert updates", async () => {
  const rows = await Promise.all(Array.from({ length: 30 }, (_, i) => article(`concurrent${i}`)));
  expect(new Set(rows.map(row => row.extId)).size).toBe(30);
  const before = await db.externalIdSequence.findUniqueOrThrow({ where: { name: "global" } });
  await db.article.upsert({ where: { id: rows[0].id }, create: { ...rows[0] }, update: { title: "Updated" } });
  expect((await db.externalIdSequence.findUniqueOrThrow({ where: { name: "global" } })).value).toBe(before.value);
});
