// GET /api/app/articles and /api/app/articles/:id against a real (temporary)
// SQLite database: auth, server-side unread filter, keyset paging, sort,
// cross-user isolation (IDOR), render-ready detail HTML and the metadata
// backfill.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { JSDOM } from "jsdom";
import MarkdownIt from "markdown-it";
import DOMPurify from "isomorphic-dompurify";

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient, session: null as null | { user: { id: string } } }));
vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
  getDatabaseProvider: () => "sqlite",
}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => state.session) }));

import { GET as listGET } from "../../app/api/app/articles/route";
import { GET as detailGET } from "../../app/api/app/articles/[id]/route";
import { renderMarkdownToHtml } from "../../lib/markdown-render";
import { getSanitizer } from "../../lib/sanitize-html";
import { runArticleMetaBackfill } from "../../lib/article-meta-backfill";
import type { ArticleDetail, ArticlePage } from "../../features/articles/types";

const dir = mkdtempSync(join(tmpdir(), "feedferret-app-articles-"));
const ids = { alice: "", bob: "", inactive: "", aliceFeed: "", aliceFeed2: "", hiddenFeed: "", aliceCat: "", aliceLabel: "", aliceSearch: "", bobFeed: "", bobCat: "", bobLabel: "", bobSearch: "", bobArticle: "", mdArticle: "", htmlArticle: "" };

const UNREAD = 230;
const READ = 20;
const T0 = Date.UTC(2026, 0, 1);

// Malicious fixtures (Markdown with raw HTML is escaped by markdown-it; links and
// images go through DOMPurify) — the same set for both storage formats.
const MALICIOUS_MD = [
  "# Title",
  "<script>alert('md-script')</script>",
  '<img src="x" onerror="alert(1)">',
  "[click](javascript:alert(2))",
  "![pic](javascript:alert(3))",
  '<svg onload="alert(4)"><circle r="1"/></svg>',
  '<iframe src="https://evil.example/"></iframe>',
  "[ok](https://example.com/safe)",
].join("\n\n");
const MALICIOUS_HTML =
  '<p>Hello</p><script>alert("html-script")</script><img src="https://x/y.png" onerror="alert(1)">' +
  '<a href="javascript:alert(2)">bad</a><a href="https://example.com/ok" target="_blank">ok</a>' +
  '<svg onload="alert(3)"><script>alert(4)</script></svg><iframe src="https://evil.example/"></iframe>' +
  '<math><mi xlink:href="javascript:alert(5)">x</mi></math>';

/** Parses the HTML (escaped text is fine) and asserts no executable construct survived. */
function expectSafe(html: string) {
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  expect(doc.querySelectorAll("script, iframe, object, embed, frame, frameset").length).toBe(0);
  for (const el of Array.from(doc.body.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      expect(attr.name.startsWith("on"), `${el.tagName} ${attr.name}`).toBe(false);
      if (["href", "src", "xlink:href", "action", "formaction"].includes(attr.name)) {
        expect(attr.value.replace(/\s+/g, "").toLowerCase().startsWith("javascript:"), `${el.tagName} ${attr.name}=${attr.value}`).toBe(false);
      }
    }
  }
}

beforeAll(async () => {
  const url = `file:${join(dir, "test.db")}`;
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.generated.prisma"], {
    env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: url },
    stdio: "pipe",
  });
  state.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  const db = state.db;

  const alice = await db.user.create({ data: { email: "alice@test", name: "Alice" } });
  const bob = await db.user.create({ data: { email: "bob@test", name: "Bob" } });
  const inactive = await db.user.create({ data: { email: "gone@test", name: "Gone", isActive: false } });
  ids.alice = alice.id;
  ids.bob = bob.id;
  ids.inactive = inactive.id;

  ids.aliceCat = (await db.category.create({ data: { name: "Tech", userId: alice.id } })).id;
  ids.bobCat = (await db.category.create({ data: { name: "Tech", userId: bob.id } })).id;
  ids.aliceFeed = (await db.feed.create({ data: { name: "A1", url: "https://a.example/feed", userId: alice.id, categoryId: ids.aliceCat } })).id;
  ids.aliceFeed2 = (await db.feed.create({ data: { name: "A2", url: "https://www.youtube.com/feeds/videos.xml?channel_id=1", userId: alice.id } })).id;
  ids.hiddenFeed = (await db.feed.create({ data: { name: "Hidden", url: "https://h.example/feed", userId: alice.id, hideFromAllFeeds: true } })).id;
  ids.bobFeed = (await db.feed.create({ data: { name: "B1", url: "https://b.example/feed", userId: bob.id, categoryId: ids.bobCat } })).id;
  ids.aliceLabel = (await db.label.create({ data: { name: "Important", userId: alice.id } })).id;
  ids.bobLabel = (await db.label.create({ data: { name: "Important", userId: bob.id } })).id;
  ids.aliceSearch = (await db.savedSearch.create({ data: { name: "needle", query: "needle", userId: alice.id } })).id;
  ids.bobSearch = (await db.savedSearch.create({ data: { name: "needle", query: "needle", userId: bob.id } })).id;

  // Alice: UNREAD + READ articles; groups of 5 share one publishedAt (keyset tie-break).
  const rows = Array.from({ length: UNREAD + READ }, (_, i) => ({
    id: `a-${String(i).padStart(3, "0")}`,
    userId: alice.id,
    feedId: i % 2 ? ids.aliceFeed2 : ids.aliceFeed,
    title: i % 7 === 0 ? `needle ${i}` : `Article ${i}`,
    link: `https://a.example/${i}`,
    content: `<p>${"word ".repeat(400 + i)}</p>`,
    excerpt: "word ".repeat(40),
    publishedAt: new Date(T0 - Math.floor(i / 5) * 60_000),
    isRead: i >= UNREAD,
    readAt: i >= UNREAD ? new Date(T0 + i * 1000) : null,
  }));
  await db.article.createMany({ data: rows });
  await db.articleLabel.create({ data: { articleId: "a-000", labelId: ids.aliceLabel, userId: alice.id } });
  await db.article.create({ data: { id: "a-hidden", userId: alice.id, feedId: ids.hiddenFeed, title: "hidden", link: "https://h.example/1", content: "<p>x</p>", publishedAt: new Date(T0 + 60_000) } });
  ids.mdArticle = (await db.article.create({ data: { id: "a-md", userId: alice.id, feedId: ids.aliceFeed, title: "md", link: "https://a.example/md", content: MALICIOUS_MD, contentFormat: "markdown", publishedAt: new Date(T0 - 10 * 86_400_000), isRead: true, readAt: new Date(T0) } })).id;
  // HTML is stored the way sync stores it: through the shared sanitizer.
  const sanitizer = await getSanitizer();
  ids.htmlArticle = (await db.article.create({ data: { id: "a-html", userId: alice.id, feedId: ids.aliceFeed, title: "html", link: "https://a.example/html", content: sanitizer.sanitize(MALICIOUS_HTML), publishedAt: new Date(T0 - 11 * 86_400_000), isRead: true, readAt: new Date(T0) } })).id;

  ids.bobArticle = (await db.article.create({ data: { id: "b-1", userId: bob.id, feedId: ids.bobFeed, title: "needle bob secret", link: "https://b.example/1", content: "<p>bob's body</p>", publishedAt: new Date(T0 + 120_000) } })).id;
  await db.articleLabel.create({ data: { articleId: "b-1", labelId: ids.bobLabel, userId: bob.id } });
}, 60_000);

afterAll(async () => {
  await state.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  state.session = { user: { id: ids.alice } };
});

async function list(qs: string): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await listGET(new Request(`https://ff.test/api/app/articles${qs ? `?${qs}` : ""}`));
  return { status: res.status, body: await res.json(), headers: res.headers };
}
async function detail(id: string) {
  const res = await detailGET(new Request(`https://ff.test/api/app/articles/${id}`), { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
}
async function all(qs: string): Promise<ArticlePage["items"]> {
  const out: ArticlePage["items"] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const { status, body } = await list(`${qs}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    expect(status).toBe(200);
    out.push(...(body as ArticlePage).items);
    cursor = (body as ArticlePage).nextCursor;
    if (!cursor) break;
  }
  return out;
}

describe("auth", () => {
  it("401 without a session, for list and detail", async () => {
    state.session = null;
    expect((await list("")).status).toBe(401);
    expect((await detail("a-000")).status).toBe(401);
  });

  it("401 for an inactive user's session", async () => {
    state.session = { user: { id: ids.inactive } };
    expect((await list("")).status).toBe(401);
  });

  it("gzips the JSON for clients that accept it (Next does not compress route handlers)", async () => {
    const res = await listGET(new Request("https://ff.test/api/app/articles", { headers: { "accept-encoding": "gzip, deflate, br" } }));
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const raw = Buffer.from(await res.arrayBuffer());
    const page = JSON.parse(gunzipSync(raw).toString("utf8")) as ArticlePage;
    expect(page.items).toHaveLength(50);
    expect(raw.length).toBeLessThan(JSON.stringify(page).length / 3);
  });

  it("honours Accept-Encoding q-values: gzip;q=0 and identity get plain JSON", async () => {
    for (const header of ["gzip;q=0", "gzip;q=0, deflate", "*;q=1, gzip;q=0", "identity", "br"]) {
      const res = await listGET(new Request("https://ff.test/api/app/articles", { headers: { "accept-encoding": header } }));
      expect(res.headers.get("content-encoding"), header).toBeNull();
      expect(((await res.json()) as ArticlePage).items).toHaveLength(50);
    }
    for (const header of ["gzip;q=0.5", "*", "deflate, *;q=0.1", "GZIP"]) {
      const res = await listGET(new Request("https://ff.test/api/app/articles", { headers: { "accept-encoding": header } }));
      expect(res.headers.get("content-encoding"), header).toBe("gzip");
    }
  });

  it("responses are private and never cached", async () => {
    const { headers } = await list("");
    expect(headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("list", () => {
  it("first page: 50 rows, no `content` key, slim fields", async () => {
    const { status, body } = await list("show=unread");
    expect(status).toBe(200);
    expect(body.items).toHaveLength(50);
    expect(typeof body.nextCursor).toBe("string");
    for (const item of body.items) {
      expect(item).not.toHaveProperty("content");
      expect(item).not.toHaveProperty("html");
      expect(Object.keys(item).sort()).toEqual(
        ["author", "canonicalFeedName", "createdAt", "duplicateCount", "excerpt", "feedId", "id", "imageUrl", "isDuplicate", "isRead", "isReadLater", "isSpoiler", "isStarred", "kind", "labelIds", "link", "media", "publishedAt", "readMinutes", "title", /* K3, additive */ "displayTitle", "isClickbait", "isSponsored"].sort(),
      );
    }
    expect(JSON.stringify(body)).not.toContain('"content"');
  });

  it("unread is filtered on the server and every unread row is reachable (> 200)", async () => {
    const items = await all("show=unread");
    expect(items).toHaveLength(UNREAD);
    expect(new Set(items.map((i) => i.id)).size).toBe(UNREAD);
    expect(items.every((i) => !i.isRead)).toBe(true);
    expect(items.some((i) => i.id === "a-hidden")).toBe(false); // hidden from "all"
    expect(items.some((i) => i.id === ids.bobArticle)).toBe(false);
  });

  it("orders by (publishedAt, createdAt, id) desc; sort=old reverses", async () => {
    const desc = await all("show=all");
    const key = (i: { publishedAt: string; createdAt: string; id: string }) => [Date.parse(i.publishedAt), Date.parse(i.createdAt), i.id] as const;
    for (let i = 1; i < desc.length; i++) {
      const [a, b] = [key(desc[i - 1]), key(desc[i])];
      expect(a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))).toBe(true);
    }
    const asc = await all("show=all&sort=old");
    expect(asc.map((i) => i.id)).toEqual(desc.map((i) => i.id).reverse());
  });

  it("marking rows read between pages does not shift the next page (keyset)", async () => {
    const first = (await list("show=unread&limit=20")).body as ArticlePage;
    const expectedNext = (await all("show=unread")).slice(20, 40).map((i) => i.id);
    await state.db.article.updateMany({ where: { id: { in: first.items.map((i) => i.id) } }, data: { isRead: true, readAt: new Date() } });
    try {
      const next = (await list(`show=unread&limit=20&cursor=${encodeURIComponent(first.nextCursor!)}`)).body as ArticlePage;
      expect(next.items.map((i) => i.id)).toEqual(expectedNext);
    } finally {
      await state.db.article.updateMany({ where: { id: { in: first.items.map((i) => i.id) } }, data: { isRead: false, readAt: null } });
    }
  });

  it("scopes: feed, category (by id), label, saved search, smart views, search", async () => {
    expect((await all(`feed=${ids.aliceFeed2}&show=all`)).every((i) => i.feedId === ids.aliceFeed2)).toBe(true);
    expect((await all(`cat=${ids.aliceCat}&show=all`)).every((i) => i.feedId === ids.aliceFeed)).toBe(true);
    expect((await all(`label=${ids.aliceLabel}`)).map((i) => i.id)).toEqual(["a-000"]);
    const ss = await all(`ss=${ids.aliceSearch}&show=all`);
    expect(ss.length).toBeGreaterThan(0);
    expect(ss.every((i) => i.title.includes("needle"))).toBe(true);
    const recent = await all("v=recent");
    expect(recent.every((i) => i.isRead)).toBe(true);
    // readAt desc keyset: newest read first.
    expect(recent[0].id).toBe(`a-${UNREAD + READ - 1}`);
    const q = await all("q=needle");
    expect(q.length).toBeGreaterThan(0);
    expect(q.some((i) => i.id === ids.bobArticle)).toBe(false);
    // `show` is ignored for search: read matches are included.
    expect(q.some((i) => i.isRead)).toBe(true);
  });

  it("derives kind for rows without stored metadata (YouTube channel feed → video)", async () => {
    const items = await all(`feed=${ids.aliceFeed2}&show=all`);
    expect(items[0].kind).toBe("video");
    expect(items[0].readMinutes).toBeNull();
  });

  it("rejects malformed parameters", async () => {
    expect((await list(`feed=${ids.aliceFeed}&label=${ids.aliceLabel}`)).status).toBe(400);
    expect((await list("v=everything")).status).toBe(400);
    expect((await list("show=maybe")).status).toBe(400);
    expect((await list("sort=sideways")).status).toBe(400);
    expect((await list("cursor=not-a-cursor")).status).toBe(400);
    expect((await list(`cursor=${Buffer.from(JSON.stringify([1, 2])).toString("base64url")}`)).status).toBe(400);
  });
});

describe("cross-user isolation (IDOR)", () => {
  it("another user's feed / category / label / saved search ids return nothing of theirs", async () => {
    for (const qs of [`feed=${ids.bobFeed}`, `cat=${ids.bobCat}`, `label=${ids.bobLabel}`, `ss=${ids.bobSearch}`]) {
      const { status, body } = await list(`${qs}&show=all`);
      expect(status).toBe(200);
      expect(body.items).toEqual([]);
    }
  });

  it("another user's article detail is a 404 and leaks nothing", async () => {
    const { status, body } = await detail(ids.bobArticle);
    expect(status).toBe(404);
    expect(JSON.stringify(body)).not.toContain("bob's body");
  });

  it("bob sees only his own rows", async () => {
    state.session = { user: { id: ids.bob } };
    const items = await all("show=all");
    expect(items.map((i) => i.id)).toEqual([ids.bobArticle]);
    expect((await detail("a-000")).status).toBe(404);
  });
});

describe("detail: render-ready HTML through the shared server sanitizer", () => {
  it("returns list fields + html, unknown id → 404", async () => {
    const { status, body } = await detail("a-000");
    expect(status).toBe(200);
    const d = body as ArticleDetail;
    expect(d.id).toBe("a-000");
    expect(d.labelIds).toEqual([ids.aliceLabel]);
    expect(d.html).toContain("<p>word");
    expect(d.contentFormat).toBe("html");
    expect((await detail("nope")).status).toBe(404);
  });

  it("markdown: html === renderMarkdownToHtml(content) (same sanitizer as REST/GReader/Fever) and is safe", async () => {
    const { body } = await detail(ids.mdArticle);
    expect(body.contentFormat).toBe("markdown");
    expect(body.html).toBe(await renderMarkdownToHtml(MALICIOUS_MD));
    expectSafe(body.html);
    expect(body.html).toContain('href="https://example.com/safe"');
  });

  it("markdown: no weaker than the client pipeline it replaces (markdown-it + plain DOMPurify)", async () => {
    // What components/article-reader.tsx did in the browser before this change.
    const legacyClient = DOMPurify.sanitize(new MarkdownIt({ html: false, linkify: true, typographer: true }).render(MALICIOUS_MD), { ADD_ATTR: ["target", "rel"] });
    expectSafe(legacyClient);
    const { body } = await detail(ids.mdArticle);
    expectSafe(body.html);
    // Same visible links survive in both.
    const links = (html: string) => Array.from(new JSDOM(html).window.document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href"));
    expect(links(body.html)).toEqual(links(legacyClient));
  });

  it("html: stored (sync-sanitized) HTML is served unchanged and is safe", async () => {
    const stored = (await state.db.article.findUnique({ where: { id: ids.htmlArticle } }))!.content;
    const { body } = await detail(ids.htmlArticle);
    expect(body.html).toBe(stored);
    expectSafe(body.html);
    expect(body.html).toContain('href="https://example.com/ok"');
  });
});

describe("metadata backfill", () => {
  it("fills null rows in batches, keeps updatedAt, is idempotent", async () => {
    const before = await state.db.article.findUnique({ where: { id: "a-001" } });
    expect(before?.kind).toBeNull();
    const nullRows = await state.db.article.count({ where: { kind: null } });
    const findMany = vi.spyOn(state.db.article, "findMany");
    const n = await runArticleMetaBackfill({ batchSize: 64, pauseMs: 0 });
    // Linear: one read per batch, each after the previous batch's last id.
    const reads = findMany.mock.calls.map(([args]) => (args as { where: { id?: { gt: string } } }).where);
    findMany.mockRestore();
    expect(reads).toHaveLength(Math.floor(nullRows / 64) + 1);
    expect(reads[0].id).toBeUndefined();
    for (const where of reads.slice(1)) expect(typeof where.id?.gt).toBe("string");
    expect(n).toBe(await state.db.article.count());
    expect(await state.db.article.count({ where: { kind: null } })).toBe(0);
    const after = await state.db.article.findUnique({ where: { id: "a-001" } });
    expect(after?.kind).toBe("video");
    expect(after?.readMinutes).toBe(2);
    expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
    expect(await runArticleMetaBackfill({ batchSize: 64, pauseMs: 0 })).toBe(0);
    const { body } = await list(`feed=${ids.aliceFeed}&show=all&limit=1`);
    expect(body.items[0].readMinutes).toBeGreaterThan(0);
  });
});
