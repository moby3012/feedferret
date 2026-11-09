/** Recorded-style URL/form contracts, modeled on FreshRSS a24ff145 (no network).
 * Real disposable SQLite queries ensure OR/AND, relation filters and cursors execute.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
  // The adapter opens lazily after beforeAll creates the schema.
  const dir = mkdtempSync(join(tmpdir(), "greader-contract-"));
  fixture.url = `file:${join(dir, "test.db")}`;
  return { db: new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: fixture.url }) }) };
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
import { greaderItemId } from "@/lib/greader";
const state = (s: string) => `user/-/state/com.google/${s}`;
const label = "user/-/label/Tech";
const epoch = 1700000000;
const date = (sec: number) => new Date(sec * 1000);
async function request(path: string, values: Record<string, string> = {}, method = "GET", repeated: [string, string][] = []) {
  const params = new URLSearchParams([...Object.entries(values), ...repeated]);
  const url = `http://localhost/api/greader/reader/api/0/${path}`;
  const response = method === "GET"
    ? await GET(new Request(`${url}?${params}`), { params: Promise.resolve({ path: ["reader", "api", "0", ...path.split("/")] }) })
    : await POST(new Request(url, { method, body: params }), { params: Promise.resolve({ path: ["reader", "api", "0", ...path.split("/")] }) });
  expect(response.status).toBe(200);
  return response.headers.get("content-type")?.includes("json") ? response.json() : response.text();
}
async function article(id: string, offset = 0, extra = {}) {
  return db.article.create({ data: { id, userId: "u", feedId: "f", title: id, link: `https://example.org/${id}`, content: "<p>Full body</p>", excerpt: "Short", publishedAt: date(epoch - 10000), createdAt: date(epoch + offset), updatedAt: date(epoch + offset), ...extra } });
}
const refs = (result: { itemRefs: { id: string }[] }) => result.itemRefs.map((r) => r.id);
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
    expect(refs(await request("stream/items/ids", { s: "unknown" }))).toEqual([]);
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
      seen.push(...(page.itemRefs || page.items).map((item: { id: string }) => item.id)); c = page.continuation || "";
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
    expect(item.origin).toEqual({ streamId: "feed/https://example.org/rss", title: "Example", htmlUrl: "https://example.org" });
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
  it("counts feed/folder/label unions once and reports newest discovery even when read", async () => {
    await article("a"); await article("b", 10, { isRead: true }); await article("c", 5, { feedId: "g" });
    await db.articleLabel.create({ data: { articleId: "c", labelId: "tag", userId: "u" } });
    const result = await request("unread-count");
    expect(result.max).toBe(2);
    expect(result.unreadcounts.find((x: { id: string }) => x.id === label)).toEqual({ id: label, count: 2, newestItemTimestampUsec: String((epoch + 10) * 1000000) });
    expect(result.unreadcounts.find((x: { id: string }) => x.id === "feed/https://example.org/rss").count).toBe(1);
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
    await request("mark-all-as-read", { s: "unknown" }, "POST");
    expect((await db.article.findUniqueOrThrow({ where: { id: "b" } })).isRead).toBe(false);
  });
});
