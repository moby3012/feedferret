// Real syncFeed against SQLite: volatile Telegram media tokens and Bluesky
// enrichment outages must never rewrite a stored row (Article.updatedAt).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const state = vi.hoisted(() => ({
  db: null as unknown as PrismaClient,
  rss: "",
  safeFetch: (async (_url: string): Promise<Response> => new Response("")) as (url: string) => Promise<Response>,
}));
vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
  getDatabaseProvider: () => "sqlite",
}));
vi.mock("@/lib/ssrf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ssrf")>();
  return {
    ...actual,
    safeFetch: (url: string) => state.safeFetch(url),
    fetchWithSsrfProtection: vi.fn(async () => ({ notModified: false, text: state.rss, etag: null, lastModified: null, headers: new Headers() })),
  };
});

import { syncFeed } from "../../lib/rss-sync";

const dir = mkdtempSync(join(tmpdir(), "feedferret-platform-sync-"));
let userId = "";
const fixture = (name: string) => readFileSync(new URL(`../fixtures/public-platforms/${name}`, import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

beforeAll(async () => {
  const url = `file:${join(dir, "test.db")}`;
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.generated.prisma"], {
    env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: url },
    stdio: "pipe",
  });
  state.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  userId = (await state.db.user.create({ data: { email: "platforms@test", name: "Platforms" } })).id;
}, 120_000);

afterAll(async () => {
  await state.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await state.db.feed.deleteMany({ where: { userId } });
});

const rows = (feedId: string) =>
  state.db.article.findMany({ where: { feedId }, orderBy: { link: "asc" }, select: { id: true, link: true, content: true, enclosures: true, imageUrl: true, updatedAt: true, fullTextStatus: true } });

describe("Telegram", () => {
  it("a rotating signed video/photo token is no upstream change: row and updatedAt stay", async () => {
    const feed = await state.db.feed.create({ data: { userId, name: "TG", url: "https://t.me/s/example_channel" } });
    state.safeFetch = async () => new Response(fixture("telegram.html"));
    await syncFeed(userId, feed.id);
    const first = await rows(feed.id);
    expect(first).toHaveLength(2);
    await tick();
    state.safeFetch = async () => new Response(fixture("telegram.html").replaceAll("VIDEO_TOKEN", "ROTATED").replaceAll("PHOTO_TOKEN", "ROTATED2").replace("expires=1", "expires=2"));
    await syncFeed(userId, feed.id);
    expect(await rows(feed.id)).toEqual(first);
  });
});

describe("Bluesky enrichment", () => {
  const RSS = '<rss version="2.0"><channel><title>Sky</title><item><title>Post</title><guid>keep-guid</guid><link>https://bsky.app/profile/example.bsky.social/post/post123</link><description>Original</description></item></channel></rss>';
  const url = "https://bsky.app/profile/example.bsky.social/rss";

  it("outages and out-of-window posts never flip an enriched row back to plain text", async () => {
    state.rss = RSS;
    const feed = await state.db.feed.create({ data: { userId, name: "Sky", url } });
    state.safeFetch = async () => new Response(fixture("bluesky.json"));
    await syncFeed(userId, feed.id);
    const enriched = await rows(feed.id);
    expect(enriched).toHaveLength(1);
    expect(JSON.parse(enriched[0].enclosures ?? "[]")).toHaveLength(2);
    expect(enriched[0].content).toContain("sky1.jpg");

    const unchanged = async (label: string) => {
      await tick();
      await syncFeed(userId, feed.id);
      expect(await rows(feed.id), label).toEqual(enriched);
    };
    state.safeFetch = async () => new Response("slow down", { status: 429 });
    await unchanged("429");
    state.safeFetch = async () => { throw new Error("timeout"); };
    await unchanged("timeout");
    state.safeFetch = async () => new Response("{not json");
    await unchanged("malformed");
    state.safeFetch = async () => new Response(JSON.stringify({ feed: [] }));
    await unchanged("post outside the API window");
    state.safeFetch = async () => new Response(fixture("bluesky.json"));
    await unchanged("enrichment back");
  });

  it("a post first seen while enrichment is down is upgraded once, then stable", async () => {
    state.rss = RSS;
    const feed = await state.db.feed.create({ data: { userId, name: "Sky", url } });
    state.safeFetch = async () => new Response("", { status: 503 });
    await syncFeed(userId, feed.id);
    const plain = await rows(feed.id);
    expect(plain[0].content).toBe("Original");
    state.safeFetch = async () => new Response(fixture("bluesky.json"));
    await tick();
    await syncFeed(userId, feed.id);
    const upgraded = await rows(feed.id);
    expect(upgraded[0].content).toContain("sky1.jpg");
    state.safeFetch = async () => new Response("", { status: 503 });
    await tick();
    await syncFeed(userId, feed.id);
    expect(await rows(feed.id)).toEqual(upgraded);
  });
});

describe("Bluesky keepStored is narrow", () => {
  it("freezes only the content fields: a title change still lands while enrichment is down", async () => {
    const rss = (title: string) => `<rss version="2.0"><channel><title>Sky</title><item><title>${title}</title><guid>keep-guid</guid><link>https://bsky.app/profile/example.bsky.social/post/post123</link><description>Original</description></item></channel></rss>`;
    state.rss = rss("Post");
    const feed = await state.db.feed.create({ data: { userId, name: "Sky", url: "https://bsky.app/profile/example.bsky.social/rss" } });
    state.safeFetch = async () => new Response(fixture("bluesky.json"));
    await syncFeed(userId, feed.id);
    const enriched = await rows(feed.id);
    state.rss = rss("Post (edited)");
    state.safeFetch = async () => new Response("", { status: 429 });
    await tick();
    await syncFeed(userId, feed.id);
    const after = await state.db.article.findMany({ where: { feedId: feed.id }, select: { title: true, content: true, enclosures: true, imageUrl: true, kind: true, readMinutes: true } });
    expect(after[0].title).toBe("Post (edited)");
    expect(after[0].content).toBe(enriched[0].content);
    expect(after[0].enclosures).toBe(enriched[0].enclosures);
    expect(after[0].imageUrl).toBe(enriched[0].imageUrl);
  });
});

describe("news and podcast feeds with media:content", () => {
  it("re-sync with unchanged upstream content leaves rows and updatedAt alone", async () => {
    state.rss = '<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>N</title><item><title>Headline</title><guid>n1</guid><link>https://news.example/1</link><description>&lt;p&gt;Lead&lt;/p&gt;</description><media:content url="https://news.example/h.jpg" type="image/jpeg" width="640" height="360"/></item><item><title>Ep</title><guid>e1</guid><link>https://pod.example/1</link><description>Notes</description><enclosure url="https://pod.example/1.mp3" type="audio/mpeg" length="1"/><media:content url="https://pod.example/1.mp3" type="audio/mpeg"/></item></channel></rss>';
    const feed = await state.db.feed.create({ data: { userId, name: "N", url: "https://news.example/feed" } });
    await syncFeed(userId, feed.id);
    const first = await rows(feed.id);
    expect(first.find((r) => r.link.includes("news.example"))?.content).toBe("<p>Lead</p>");
    expect(first.find((r) => r.link.includes("news.example"))?.enclosures).toBeNull();
    expect(JSON.parse(first.find((r) => r.link.includes("pod.example"))?.enclosures ?? "[]")).toHaveLength(1);
    await tick();
    await syncFeed(userId, feed.id);
    expect(await rows(feed.id)).toEqual(first);
  });
});
