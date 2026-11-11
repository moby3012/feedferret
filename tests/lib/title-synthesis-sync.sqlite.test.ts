// PR #254 review fix: synthesized item titles carry provenance end to end.
// Runs the REAL fetchers (RSS/Atom, JSON Feed, HTML+XPath, HTML+XPath+JSON)
// and the REAL syncFeed against a real SQLite DB; only the SSRF transport is
// faked (no network). Legacy rows are produced by the same real pipeline with
// the fetcher output mapped back to what the pre-synthesis fetchers returned
// (`raw || "Untitled"`, no provenance), i.e. exactly the rows old code stored.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const state = vi.hoisted(() => ({
  db: null as unknown as PrismaClient,
  body: "",
  legacy: false,
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
    fetchWithSsrfProtection: vi.fn(async () => ({ notModified: false, text: state.body, etag: null, lastModified: null, headers: new Headers() })),
  };
});
vi.mock("@/lib/feed-fetcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/feed-fetcher")>();
  return {
    ...actual,
    fetchFeedArticles: async (feed: Parameters<typeof actual.fetchFeedArticles>[0]) => {
      const result = await actual.fetchFeedArticles(feed);
      if (!state.legacy) return result;
      // Pre-synthesis fetcher output: title = raw || "Untitled", no provenance.
      return {
        ...result,
        articles: result.articles.map(({ titleSynthetic: _s, identityTitle, ...rest }) => ({ ...rest, title: identityTitle ?? rest.title })),
      };
    },
  };
});

import { syncFeed } from "../../lib/rss-sync";

const dir = mkdtempSync(join(tmpdir(), "feedferret-title-sync-"));
let userId = "";

const POSTS = [
  { id: "post-1", link: "https://social.example/@a/1", html: "<p>First toot about &amp;lt;tags&amp;gt; &#x1F600; and a long enough sentence to need truncation at eighty graphemes.</p>" },
  { id: "post-2", link: "https://social.example/@a/2", html: "<p>Second toot, short.</p>" },
];
const EXPECTED_TITLES = [
  "First toot about &lt;tags&gt; 😀 and a long enough sentence to need truncation at…",
  "Second toot, short.",
];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const SOURCES: Array<{ name: string; sourceType: string; scraperConfig?: string; body: string }> = [
  {
    name: "RSS",
    sourceType: "rss",
    body: `<?xml version="1.0"?><rss version="2.0"><channel><title>Toots</title>${POSTS.map((p) =>
      `<item><title></title><link>${p.link}</link><guid>${p.id}</guid><description>${esc(p.html)}</description><pubDate>Mon, 10 Nov 2026 12:00:00 GMT</pubDate></item>`).join("")}</channel></rss>`,
  },
  {
    name: "Atom",
    sourceType: "rss",
    body: `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Toots</title>${POSTS.map((p) =>
      `<entry><id>${p.id}</id><link href="${p.link}"/><updated>2026-11-10T12:00:00Z</updated><content type="html">${esc(p.html)}</content></entry>`).join("")}</feed>`,
  },
  {
    name: "JSONFeed",
    sourceType: "JSONFeed",
    body: JSON.stringify({ version: "https://jsonfeed.org/version/1.1", title: "Toots", items: POSTS.map((p) => ({ id: p.id, url: p.link, content_html: p.html, date_published: "2026-11-10T12:00:00Z" })) }),
  },
  {
    name: "HTML+XPath",
    sourceType: "HTML+XPath",
    scraperConfig: JSON.stringify({ xpath: { xPathItem: "//article", xPathItemUri: ".//a/@href", xPathItemContent: ".//div[@class='body']", xPathItemTitle: ".//h2", xPathItemUid: "@id" } }),
    body: `<html><body>${POSTS.map((p) => `<article id="${p.id}"><a href="${p.link}">open</a><div class="body">${p.html}</div></article>`).join("")}</body></html>`,
  },
  {
    name: "HTML+XPath+JSON",
    sourceType: "HTML+XPath+JSON+DotNotation",
    scraperConfig: JSON.stringify({ xPathToJson: "//script[@id='data']", json: { item: "items", itemUri: "url", itemContent: "html", itemUid: "id" } }),
    body: `<html><body><script id="data" type="application/json">${JSON.stringify({ items: POSTS.map((p) => ({ id: p.id, url: p.link, html: p.html })) }).replace(/</g, "\\u003c")}</script></body></html>`,
  },
];

beforeAll(async () => {
  const url = `file:${join(dir, "test.db")}`;
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.generated.prisma"], {
    env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: url },
    stdio: "pipe",
  });
  state.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  userId = (await state.db.user.create({ data: { email: "titles@test", name: "Titles" } })).id;
}, 120_000);

afterAll(async () => {
  await state.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  state.legacy = false;
  await state.db.feed.deleteMany({ where: { userId } });
});

async function rows(feedId: string) {
  return state.db.article.findMany({
    where: { feedId },
    orderBy: { link: "asc" },
    select: { id: true, dedupeKey: true, title: true, isRead: true, updatedAt: true },
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

describe.each(SOURCES)("$name feed without item titles", (source) => {
  it("synthesizes display titles on insert and re-syncs never touch Article.updatedAt", async () => {
    state.body = source.body;
    const feed = await state.db.feed.create({ data: { userId, name: "Toots", url: "https://social.example/@a.feed", sourceType: source.sourceType, scraperConfig: source.scraperConfig ?? null } });
    await syncFeed(userId, feed.id);
    const first = await rows(feed.id);
    expect(first.map((r) => r.title)).toEqual(EXPECTED_TITLES);
    await tick();
    await syncFeed(userId, feed.id);
    expect(await rows(feed.id)).toEqual(first);
  });

  describe.each(["id", "link", "title", "link:title"])("unicityCriteria=%s", (criteria) => {
    it("upgrades legacy \"Untitled\" rows in place: same identity, no duplicates, updatedAt unchanged", async () => {
      state.body = source.body;
      const feed = await state.db.feed.create({ data: { userId, name: "Toots", url: "https://social.example/@a.feed", sourceType: source.sourceType, scraperConfig: source.scraperConfig ?? null, unicityCriteria: criteria } });

      // Rows as the pre-synthesis code stored them.
      state.legacy = true;
      await syncFeed(userId, feed.id);
      const legacy = await rows(feed.id);
      // Title-only identity on a title-less feed: the old code keyed every
      // item "Untitled" (one row). That identity must survive the upgrade.
      const titleOnly = criteria === "title";
      expect(legacy).toHaveLength(titleOnly ? 1 : 2);
      expect(legacy.every((r) => r.title === "Untitled")).toBe(true);
      await state.db.article.updateMany({ where: { feedId: feed.id }, data: { isRead: true } });
      const before = await rows(feed.id);

      // Upgrade: the new code syncs the same feed.
      state.legacy = false;
      await tick();
      await syncFeed(userId, feed.id);
      const after = await rows(feed.id);
      expect(after).toHaveLength(legacy.length);
      expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
      expect(after.map((r) => r.dedupeKey)).toEqual(before.map((r) => r.dedupeKey));
      expect(after.map((r) => r.updatedAt.getTime())).toEqual(before.map((r) => r.updatedAt.getTime()));
      expect(after.every((r) => r.isRead)).toBe(true);
      // Cosmetic upgrade of the placeholder (updatedAt kept, asserted above).
      if (titleOnly) expect(EXPECTED_TITLES).toContain(after[0].title);
      else expect(after.map((r) => r.title)).toEqual(EXPECTED_TITLES);

      // Idempotent afterwards.
      await tick();
      await syncFeed(userId, feed.id);
      expect(await rows(feed.id)).toEqual(after);
    });
  });
});

it("a real feed title is never replaced by a synthesized one", async () => {
  state.body = SOURCES[0].body.replace("<title></title>", "<title>Real headline</title>");
  const feed = await state.db.feed.create({ data: { userId, name: "Toots", url: "https://social.example/@a.feed" } });
  await syncFeed(userId, feed.id);
  const first = await rows(feed.id);
  expect(first.map((r) => r.title)).toEqual(["Real headline", EXPECTED_TITLES[1]]);
  // The feed later drops that title: the stored real title stays, updatedAt too.
  state.body = SOURCES[0].body;
  await tick();
  await syncFeed(userId, feed.id);
  expect(await rows(feed.id)).toEqual(first);
});
