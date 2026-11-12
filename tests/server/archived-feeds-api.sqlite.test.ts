// Archived feeds across the client APIs, real SQLite DB: archived feeds are not subscriptions for
// GReader / Fever clients (no subscription list entry, no items, no unread ids, no counts, "mark all"
// skips them), REST v1 hides them from GET /feeds unless asked (?archived=only|include) and archives /
// restores through PATCH, MCP does the same through list_feeds / update_feed. Restoring brings everything back.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const h = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
vi.mock("@/lib/db", () => ({
  get db() {
    return h.db;
  },
  getDatabaseProvider: () => "sqlite",
}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "alice" } })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/greader", async (original) => ({
  ...(await original<typeof import("@/lib/greader")>()),
  authenticateGReaderRequest: vi.fn(async () => ({ id: "alice", email: "alice@example.org", apiTokenVersion: 0 })),
}));
vi.mock("@/lib/api-auth", async (original) => {
  const actual = await original<typeof import("@/lib/api-auth")>();
  const user = () => ({ id: "alice", email: "alice@example.org", name: "Alice", role: "USER" });
  return { ...actual, resolveApiUser: vi.fn(async () => user()), requireApiUser: vi.fn(async () => user()) };
});
vi.mock("@/lib/rate-limit", async (original) => ({
  ...(await original<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: () => ({ success: true }),
  peekRateLimit: () => ({ success: true }),
}));

import { GET as greaderGet } from "../../app/api/greader/[...path]/route";
import { POST as feverPost } from "../../app/api/fever/route";
import { GET as v1Get, PATCH as v1Patch, POST as v1Post } from "../../app/api/v1/[...path]/route";
import { POST as greaderPost } from "../../app/api/greader/[...path]/route";
import { POST as mcpPost } from "../../app/api/mcp/route";
import { hashApiToken } from "../../lib/token";

const FEVER_KEY = "archived-test-fever-key";
const dir = mkdtempSync(join(tmpdir(), "feedferret-archived-api-"));
const LIVE_FEED = "0000000000000000001";
const OLD_FEED = "0000000000000000002";

beforeAll(async () => {
  const url = `file:${join(dir, "test.db")}`;
  execFileSync("node_modules/.bin/prisma", ["db", "push", "--schema", "prisma/schema.generated.prisma"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  h.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: url.slice("file:".length) }) });
  await h.db.user.create({ data: { id: "alice", email: "alice@example.org", apiFeverKey: hashApiToken(FEVER_KEY), apiPasswordHash: "x" } });
}, 60_000);

afterAll(async () => {
  await h.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

let nextArticle = 0;
async function article(feedId: string, extra: Record<string, unknown> = {}) {
  const n = ++nextArticle;
  return h.db.article.create({
    data: { id: `a${n}`, extId: String(n).padStart(19, "0"), userId: "alice", feedId, title: (extra.id as string) ?? `A${n}`, link: `https://example.org/a${n}`, content: "<p>x</p>", publishedAt: new Date(1_700_000_000_000), ...extra } as any,
  });
}

beforeEach(async () => {
  await h.db.article.deleteMany({});
  await h.db.feed.deleteMany({});
  await h.db.feed.create({ data: { id: "live", extId: LIVE_FEED, userId: "alice", name: "Live", url: "https://example.org/live.xml" } });
  await h.db.feed.create({ data: { id: "old", extId: OLD_FEED, userId: "alice", name: "Old", url: "https://example.org/old.xml" } });
  await article("live", { id: "live-1", extId: "0000000000000000011" });
  await article("old", { id: "old-1", extId: "0000000000000000012", isStarred: true });
  await article("old", { id: "old-2", extId: "0000000000000000013" });
});

const archiveOld = () => h.db.feed.update({ where: { id: "old" }, data: { archivedAt: new Date() } });
const restoreOld = () => h.db.feed.update({ where: { id: "old" }, data: { archivedAt: null } });

describe("GReader", () => {
  const get = async (path: string, query = "") => {
    const res = await greaderGet(new Request(`http://localhost/api/greader/reader/api/0/${path}?output=json${query}`), {
      params: Promise.resolve({ path: ["reader", "api", "0", ...path.split("/")] }),
    });
    expect(res.status).toBe(200);
    return res.json();
  };

  it("drops archived feeds from subscription list, unread counts and every item stream; restore brings them back", async () => {
    const titles = async () => (await get("subscription/list")).subscriptions.map((s: { title: string }) => s.title).sort();
    const itemIds = async (stream: string) =>
      (await get(`stream/items/ids`, `&s=${encodeURIComponent(stream)}&n=50`)).itemRefs.map((r: { id: string }) => r.id);
    const readingList = "user/-/state/com.google/reading-list";
    const starred = "user/-/state/com.google/starred";

    expect(await titles()).toEqual(["Live", "Old"]);
    expect(await itemIds(readingList)).toHaveLength(3);

    await archiveOld();
    expect(await titles()).toEqual(["Live"]);
    expect(await itemIds(readingList)).toHaveLength(1);
    expect(await itemIds(starred)).toHaveLength(0);
    expect(await itemIds(`feed/${Number(OLD_FEED)}`)).toHaveLength(0);

    const counts = (await get("unread-count")).unreadcounts as Array<{ id: string; count: number }>;
    expect(counts.find((c) => c.id === readingList)?.count).toBe(1);
    expect(counts.some((c) => c.id === `feed/${Number(OLD_FEED)}`)).toBe(false);

    await restoreOld();
    expect(await titles()).toEqual(["Live", "Old"]);
    expect(await itemIds(readingList)).toHaveLength(3);
  });
});

describe("Fever", () => {
  const call = async (values: Record<string, string>) => {
    const body = new URLSearchParams({ api_key: FEVER_KEY, ...values });
    const res = await feverPost(new Request("http://localhost/api/fever?api", { method: "POST", body }));
    expect(res.status).toBe(200);
    return res.json();
  };

  it("omits archived feeds, items and ids; group 0 'mark all' leaves them alone", async () => {
    await archiveOld();
    const feeds = await call({ feeds: "", favicons: "" });
    expect(feeds.feeds.map((f: { title: string }) => f.title)).toEqual(["Live"]);
    expect(feeds.favicons).toHaveLength(1);
    expect(feeds.feeds_groups.flatMap((g: { feed_ids: string }) => g.feed_ids.split(","))).not.toContain(String(Number(OLD_FEED)));

    const items = await call({ items: "", since_id: "0" });
    expect(items.items.map((i: { title: string }) => i.title)).toEqual(["live-1"]);
    expect(items.total_items).toBeDefined();

    const ids = await call({ unread_item_ids: "", saved_item_ids: "" });
    expect(ids.unread_item_ids.split(",").filter(Boolean)).toHaveLength(1);
    expect(ids.saved_item_ids).toBe("");

    await call({ mark: "group", as: "read", id: "0", before: String(Math.floor(Date.now() / 1000) + 60) });
    expect(await h.db.article.count({ where: { feedId: "live", isRead: true } })).toBe(1);
    expect(await h.db.article.count({ where: { feedId: "old", isRead: true } })).toBe(0);

    await restoreOld();
    const back = await call({ feeds: "", unread_item_ids: "" });
    expect(back.feeds).toHaveLength(2);
    expect(back.unread_item_ids.split(",").filter(Boolean)).toHaveLength(2);
  });
});

describe("REST v1", () => {
  const list = async (query = "") => {
    const res = await v1Get(new Request(`http://localhost/api/v1/feeds${query}`), { params: Promise.resolve({ path: ["feeds"] }) });
    expect(res.status).toBe(200);
    return (await res.json()).items as Array<{ id: string; archived: boolean; archivedAt: string | null }>;
  };
  const patch = async (body: unknown) => {
    const res = await v1Patch(
      new Request("http://localhost/api/v1/feeds/old", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ path: ["feeds", "old"] }) },
    );
    return { status: res.status, body: await res.json() };
  };

  it("lists active feeds by default, archived with ?archived=only|include, and exposes the flag", async () => {
    expect((await list()).map((f) => f.id).sort()).toEqual(["live", "old"]);
    expect((await list()).every((f) => f.archived === false && f.archivedAt === null)).toBe(true);

    await archiveOld();
    expect((await list()).map((f) => f.id)).toEqual(["live"]);
    expect((await list("?archived=only")).map((f) => f.id)).toEqual(["old"]);
    expect((await list("?archived=include")).map((f) => f.id).sort()).toEqual(["live", "old"]);
    const [old] = await list("?archived=only");
    expect(old).toMatchObject({ archived: true, archivedAt: expect.any(String) });
  });

  it("PATCH {archived} archives (keeping the original date) and restores, without touching articles", async () => {
    const before = await h.db.article.findMany({ orderBy: { id: "asc" } });

    const archived = await patch({ archived: true });
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ id: "old", archived: true });
    const firstDate = (await h.db.feed.findUniqueOrThrow({ where: { id: "old" } })).archivedAt;
    expect(firstDate).toBeInstanceOf(Date);

    await patch({ archived: true });
    expect((await h.db.feed.findUniqueOrThrow({ where: { id: "old" } })).archivedAt).toEqual(firstDate);

    const restored = await patch({ archived: false });
    expect(restored.body).toMatchObject({ id: "old", archived: false, archivedAt: null });

    expect(await h.db.article.findMany({ orderBy: { id: "asc" } })).toEqual(before);
  });
});

describe("MCP", () => {
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await mcpPost(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `feedferret.${name}`, arguments: args } }),
      }),
    );
    const result = (await res.json()).result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0].text);
  };

  it("list_feeds hides archived feeds unless asked; update_feed archives and restores", async () => {
    expect((await tool("list_feeds")).map((f: { id: string }) => f.id).sort()).toEqual(["live", "old"]);

    const updated = await tool("update_feed", { feedId: "old", archived: true });
    expect(updated.archivedAt).toBeTruthy();
    expect((await tool("list_feeds")).map((f: { id: string }) => f.id)).toEqual(["live"]);
    expect((await tool("list_feeds", { archived: "only" })).map((f: { id: string }) => f.id)).toEqual(["old"]);
    expect((await tool("list_feeds", { archived: "include" })).map((f: { id: string }) => f.id).sort()).toEqual(["live", "old"]);

    const restored = await tool("update_feed", { feedId: "old", archived: false });
    expect(restored.archivedAt).toBeNull();
    expect(await tool("list_feeds")).toHaveLength(2);
  });
});

describe("bulk read and stats skip archived feeds in aggregate scopes only", () => {
  const unread = (feedId: string) => h.db.article.count({ where: { feedId, isRead: false } });
  const v1MarkAll = async (body: Record<string, unknown>) => {
    const res = await v1Post(
      new Request("http://localhost/api/v1/articles/mark-all-read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ path: ["articles", "mark-all-read"] }) },
    );
    expect(res.status).toBe(200);
  };
  const mcp = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await mcpPost(
      new Request("http://localhost/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `feedferret.${name}`, arguments: args } }) }),
    );
    const result = (await res.json()).result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0].text);
  };

  it("REST v1 mark-all-read: unscoped and category scopes leave archived articles unread; feed / query scopes keep addressing them", async () => {
    await archiveOld();
    await v1MarkAll({});
    expect(await unread("live")).toBe(0);
    expect(await unread("old")).toBe(2);

    await v1MarkAll({ feedId: "old" });
    expect(await unread("old")).toBe(0);
  });

  it("REST v1 mark-all-read with a search query still reaches archived feeds", async () => {
    await archiveOld();
    await v1MarkAll({ query: "old-" });
    expect(await unread("old")).toBe(0);
  });

  it("REST v1 mark-all-read by category skips archived feeds", async () => {
    const cat = await h.db.category.create({ data: { id: "cat1", userId: "alice", name: "Cat" } });
    await h.db.feed.updateMany({ data: { categoryId: cat.id } });
    await archiveOld();
    await v1MarkAll({ categoryId: cat.id });
    expect(await unread("live")).toBe(0);
    expect(await unread("old")).toBe(2);
    await h.db.feed.updateMany({ data: { categoryId: null } });
    await h.db.category.delete({ where: { id: cat.id } });
  });

  it("MCP mark_all_read: unscoped skips archived, feedId addresses them", async () => {
    await archiveOld();
    await mcp("mark_all_read");
    expect(await unread("live")).toBe(0);
    expect(await unread("old")).toBe(2);
    await mcp("mark_all_read", { feedId: "old" });
    expect(await unread("old")).toBe(0);
  });

  it("v1 /stats and MCP get_stats: archived feeds are not feeds and their unread articles are not unread; totalArticles still counts them", async () => {
    const stats = async () => {
      const res = await v1Get(new Request("http://localhost/api/v1/stats"), { params: Promise.resolve({ path: ["stats"] }) });
      expect(res.status).toBe(200);
      return res.json();
    };
    expect(await stats()).toMatchObject({ totalFeeds: 2, unreadArticles: 3, totalArticles: 3 });
    await archiveOld();
    expect(await stats()).toMatchObject({ totalFeeds: 1, unreadArticles: 1, totalArticles: 3 });
    expect(await mcp("get_stats")).toMatchObject({ totalFeeds: 1, unreadArticles: 1, totalArticles: 3 });
  });
});

describe("subscribing to the URL of an archived feed restores it", () => {
  it("GReader quickadd restores the archived feed and says so", async () => {
    await archiveOld();
    const res = await greaderPost(new Request("http://localhost/api/greader/reader/api/0/subscription/quickadd", { method: "POST", body: new URLSearchParams({ quickadd: "https://example.org/old.xml" }) }), {
      params: Promise.resolve({ path: ["reader", "api", "0", "subscription", "quickadd"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ numResults: 1, streamId: `feed/${Number(OLD_FEED)}`, restored: true });
    expect((await h.db.feed.findUniqueOrThrow({ where: { id: "old" } })).archivedAt).toBeNull();
  });

  it("REST v1 POST /feeds restores instead of failing on the unique URL", async () => {
    await archiveOld();
    const res = await v1Post(
      new Request("http://localhost/api/v1/feeds", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.org/old.xml" }) }),
      { params: Promise.resolve({ path: ["feeds"] }) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "old", archived: false, restored: true });
    expect(await h.db.feed.count({ where: { url: "https://example.org/old.xml" } })).toBe(1);
  });

  it("MCP add_feed restores", async () => {
    await archiveOld();
    const mcp = async () => {
      const res = await mcpPost(
        new Request("http://localhost/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "feedferret.add_feed", arguments: { url: "https://example.org/old.xml" } } }) }),
      );
      return (await res.json()).result as { isError?: boolean; content: Array<{ text: string }> };
    };
    const result = await mcp();
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ id: "old", restored: true });
    expect((await h.db.feed.findUniqueOrThrow({ where: { id: "old" } })).archivedAt).toBeNull();
  });
});
