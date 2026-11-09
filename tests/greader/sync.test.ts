/** Recorded-style URL/form contracts, modeled on FreshRSS a24ff145 (no network).
 * Real disposable SQLite queries ensure OR/AND, relation filters and cursors execute.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = vi.hoisted(() => ({ url: "", queries: 0 }));
vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
  // The adapter opens lazily after beforeAll creates the schema.
  const dir = mkdtempSync(join(tmpdir(), "greader-contract-"));
  fixture.url = `file:${join(dir, "test.db")}`;
  const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: fixture.url }), log: [{ emit: "event", level: "query" }] });
  db.$on("query", () => { fixture.queries++; });
    const fixtureId = (id: string) => (/^\d+$/.test(id) ? BigInt(id) : Buffer.from(id).reduce((n, c) => (n * BigInt(257) + BigInt(c)) % BigInt("72057594037927931"), BigInt(0))).toString().padStart(19, "0");
  return { db: db.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
    if (["Article", "Feed", "Category", "Label"].includes(model) && ["create", "createMany"].includes(operation)) {
      const data = (args as { data: unknown }).data;
      for (const row of (Array.isArray(data) ? data : [data]) as { id?: string; extId?: string }[]) if (row.id) row.extId = fixtureId(row.id);
    }
    return query(args);
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
import { authenticateGReaderRequest, greaderItemId as encodeItemId } from "@/lib/greader";
const fixtureId = (id: string) => (/^\d+$/.test(id) ? BigInt(id) : Buffer.from(id).reduce((n, c) => (n * BigInt(257) + BigInt(c)) % BigInt("72057594037927931"), BigInt(0))).toString();
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
  return db.article.create({ data: { id, userId: "u", feedId: "f", title: id, link: `https://example.org/${id}`, content: "<p>Full body</p>", excerpt: "Short", publishedAt: date(epoch - 10000), createdAt: date(epoch + offset), updatedAt: date(epoch + offset), ...extra } });
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
  it.each([["o", "stream/items/ids"], ["d", "stream/items/ids"], ["o", "stream/contents"], ["d", "stream/contents"]])("paginates label scopes exactly once (%s, %s), ties and backdated arrivals", async (r, endpoint) => {
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
  it("supports large/unlimited pages and safely defaults invalid n", async () => {
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
  it("accepts raw decimal, padded hex and namespaced refs without precision loss, ordering both ways", async () => {
    await article("9007199254740993", 1); await article("123", 0);
    const ids: [string, string][] = [["i", "9007199254740993"], ["i", "000000000000007b"]];
    const asc = await request("stream/items/contents", { r: "o" }, "POST", ids);
    expect(asc.items.map((item: { id: string }) => item.id)).toEqual(["123", "9007199254740993"].map(greaderItemId));
    const desc = await request("stream/items/contents", {}, "GET", ids);
    expect(desc.items.map((item: { id: string }) => item.id)).toEqual(["9007199254740993", "123"].map(greaderItemId));
    expect((await request("stream/items/contents", {}, "POST")).items).toEqual([]);
  });
  it("counts feed/folder/label unions once and reports newest unread discovery", async () => {
    await article("a"); await article("b", 10, { isRead: true }); await article("c", 5, { feedId: "g" });
    await db.articleLabel.create({ data: { articleId: "c", labelId: "tag", userId: "u" } });
    const result = await request("unread-count");
    expect(result.max).toBe(2);
    expect(result.unreadcounts.find((x: { id: string }) => x.id === label)).toEqual({ id: label, count: 2, newestItemTimestampUsec: String((epoch + 5) * 1000000) });
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
    await request("mark-all-as-read", { s: label, ts: String(epoch * 1000000) }, "POST");
    expect((await db.article.findUniqueOrThrow({ where: { id: "a" } })).isRead).toBe(true);
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
  expect(fixture.queries).toBe(9);
  expect(result.unreadcounts.filter((x: { id: string }) => x.id.startsWith("feed/"))).toHaveLength(300);
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
  expect((await request("stream/contents", { n: "10000" })).items).toHaveLength(1000);
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
  const spy = vi.spyOn(db.article, "updateMany").mockRejectedValueOnce(new Error("DB unavailable"));
  await request("mark-all-as-read", {}, "POST", [], 500);
  spy.mockRestore();
});
it("uses the discovery keyset index on SQLite", async () => {
  const plan = await db.$queryRawUnsafe<Array<{ detail: string }>>('EXPLAIN QUERY PLAN SELECT id FROM Article WHERE userId = ? AND createdAt < ? ORDER BY createdAt DESC, id DESC LIMIT 21', "u", epoch * 1000);
  expect(plan.map(row => row.detail).join(" ")).toContain("Article_userId_createdAt_id_idx");
  expect(plan.map(row => row.detail).join(" ")).not.toContain("TEMP B-TREE");
});
