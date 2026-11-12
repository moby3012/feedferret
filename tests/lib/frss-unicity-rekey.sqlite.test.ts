// PR #280 review P1: feeds that already carried a FreshRSS `sha1:*` unicity
// criterion were keyed like `id` by earlier FeedFerret versions. Switching to the
// FreshRSS-identical hash must re-key those rows in place: zero duplicates, same
// ids, read/star/label state kept, Article.updatedAt untouched. Real syncFeed on a
// real SQLite DB; only the SSRF transport is faked.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient, body: "" }));
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

import { syncFeed } from "../../lib/rss-sync";

const dir = mkdtempSync(join(tmpdir(), "feedferret-frss-rekey-"));
let userId = "";

const sha1 = (value: string) => createHash("sha1").update(value).digest("hex");
const ITEMS = [
  { guid: "guid-1", link: "https://blog.example/a", title: "Alpha", date: "Mon, 10 Nov 2026 12:00:00 GMT" },
  { guid: "guid-2", link: "https://blog.example/b", title: "Beta", date: "Tue, 11 Nov 2026 08:30:00 GMT" },
];
const rss = (items: typeof ITEMS) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>${items
    .map((i) => `<item><title>${i.title}</title><link>${i.link}</link><guid>${i.guid}</guid><description>&lt;p&gt;${i.title} body&lt;/p&gt;</description><pubDate>${i.date}</pubDate></item>`)
    .join("")}</channel></rss>`;
const unix = (date: string) => String(Math.floor(new Date(date).getTime() / 1000));

beforeAll(async () => {
  const url = `file:${join(dir, "test.db")}`;
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.generated.prisma"], {
    env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: url },
    stdio: "pipe",
  });
  state.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  userId = (await state.db.user.create({ data: { email: "rekey@test", name: "Rekey" } })).id;
}, 120_000);

afterAll(async () => {
  await state.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await state.db.feed.deleteMany({ where: { userId } });
});

const rows = (feedId: string) =>
  state.db.article.findMany({
    where: { feedId },
    orderBy: { link: "asc" },
    select: { id: true, dedupeKey: true, isRead: true, isStarred: true, updatedAt: true, labels: { select: { labelId: true } } },
  });

describe.each([
  ["legacy id-keyed rows (previous FeedFerret releases)", (item: (typeof ITEMS)[number]) => item.guid],
  ["sha1:-prefixed rows (pre-release builds of this PR)", (item: (typeof ITEMS)[number]) => `sha1:${sha1(item.link + unix(item.date))}`],
])("sha1:link_published feed with %s", (_name, legacyKey) => {
  it("re-keys in place: no duplicates, state and updatedAt preserved, idempotent", async () => {
    state.body = rss(ITEMS);
    const feed = await state.db.feed.create({ data: { userId, name: "Blog", url: "https://blog.example/feed", unicityCriteria: "sha1:link_published" } });
    const label = await state.db.label.create({ data: { userId, name: `kept-${Math.random()}` } });
    const stamp = new Date("2026-01-01T00:00:00Z");
    // Rows exactly as the old code stored them, with user state on them.
    for (const [index, item] of ITEMS.entries()) {
      await state.db.article.create({
        data: {
          userId, feedId: feed.id, title: item.title, link: item.link, externalId: item.guid, dedupeKey: legacyKey(item),
          content: `<p>${item.title} body</p>`, excerpt: `${item.title} body`, publishedAt: new Date(item.date),
          isRead: index === 0, isStarred: index === 1, updatedAt: stamp,
          ...(index === 0 ? { labels: { create: { labelId: label.id, userId } } } : {}),
        } as never,
      });
    }
    const before = await rows(feed.id);

    await syncFeed(userId, feed.id);
    const after = await rows(feed.id);
    expect(after).toHaveLength(ITEMS.length);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    // Keys computed independently from FreshRSS' documented concatenation: sha1(permalink . get_date('U')).
    expect(after.map((r) => r.dedupeKey)).toEqual(ITEMS.map((i) => sha1(i.link + unix(i.date))));
    expect(after.map((r) => [r.isRead, r.isStarred, r.labels.length])).toEqual([[true, false, 1], [false, true, 0]]);
    expect(after.every((r) => r.updatedAt.getTime() === stamp.getTime())).toBe(true);

    // Second sync: nothing to re-key, nothing new.
    await syncFeed(userId, feed.id);
    expect(await rows(feed.id)).toEqual(after);
  });
});

it("a genuinely new article still gets inserted next to re-keyed ones", async () => {
  state.body = rss(ITEMS);
  const feed = await state.db.feed.create({ data: { userId, name: "Blog", url: "https://blog.example/feed2", unicityCriteria: "sha1:link_published" } });
  await state.db.article.create({
    data: { userId, feedId: feed.id, title: "Alpha", link: ITEMS[0].link, externalId: "guid-1", dedupeKey: "guid-1", content: "<p>Alpha body</p>", excerpt: "Alpha body", publishedAt: new Date(ITEMS[0].date) } as never,
  });
  await syncFeed(userId, feed.id);
  const after = await rows(feed.id);
  expect(after.map((r) => r.dedupeKey)).toEqual(ITEMS.map((i) => sha1(i.link + unix(i.date))));
});

describe("review follow-ups (P2-1, P2-2, P3)", () => {
  it("sha1:title: rows stored under the bare title by earlier versions are re-keyed, not duplicated", async () => {
    state.body = rss(ITEMS);
    const feed = await state.db.feed.create({ data: { userId, name: "Blog", url: "https://blog.example/feed3", unicityCriteria: "sha1:title" } });
    for (const item of ITEMS) {
      await state.db.article.create({
        data: { userId, feedId: feed.id, title: item.title, link: item.link, externalId: item.guid, dedupeKey: item.title, content: "", excerpt: "", publishedAt: new Date(item.date), isRead: true } as never,
      });
    }
    const before = await rows(feed.id);
    await syncFeed(userId, feed.id);
    const after = await rows(feed.id);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.map((r) => r.dedupeKey)).toEqual(ITEMS.map((i) => sha1(i.title)));
    expect(after.every((r) => r.isRead)).toBe(true);
  });

  it("title-less items do not collide: FreshRSS hashes the raw empty title and falls back to each guid", async () => {
    state.body = `<?xml version="1.0"?><rss version="2.0"><channel><title>B</title>${["n-1", "n-2"]
      .map((guid) => `<item><guid>${guid}</guid><description>&lt;p&gt;Text of ${guid} that is long enough to synthesize a display title from&lt;/p&gt;</description></item>`)
      .join("")}</channel></rss>`;
    const feed = await state.db.feed.create({ data: { userId, name: "Notes", url: "https://notes.example/feed", unicityCriteria: "sha1:title" } });
    await syncFeed(userId, feed.id);
    expect((await rows(feed.id)).map((r) => r.dedupeKey).sort()).toEqual(["n-1", "n-2"]);
  });

  it("marks the feed once re-keyed and skips the legacy lookup afterwards", async () => {
    state.body = rss(ITEMS);
    const feed = await state.db.feed.create({ data: { userId, name: "Blog", url: "https://blog.example/feed4", unicityCriteria: "sha1:link_published" } });
    await syncFeed(userId, feed.id);
    expect((await state.db.feed.findUniqueOrThrow({ where: { id: feed.id } })).dedupeRekeyedFor).toBe("sha1:link_published");
    // A legacy-keyed row appearing after the marker is no longer looked up (proves the skip).
    const newKey = sha1(ITEMS[0].link + unix(ITEMS[0].date));
    await state.db.article.updateMany({ where: { feedId: feed.id, dedupeKey: newKey }, data: { dedupeKey: "guid-1" } });
    await syncFeed(userId, feed.id);
    expect((await rows(feed.id)).map((r) => r.dedupeKey).sort()).toEqual(["guid-1", newKey, sha1(ITEMS[1].link + unix(ITEMS[1].date))].sort());
    // Changing the criterion re-arms it.
    await state.db.feed.update({ where: { id: feed.id }, data: { unicityCriteria: "sha1:link_published_title" } });
    await syncFeed(userId, feed.id);
    expect((await state.db.feed.findUniqueOrThrow({ where: { id: feed.id } })).dedupeRekeyedFor).toBe("sha1:link_published_title");
  });

  it("content criteria hash the content as published, before remove-selectors change it", async () => {
    const raw = '<p>Body</p><div class="ad">Ad</div>';
    state.body = `<?xml version="1.0"?><rss version="2.0"><channel><title>C</title><item><title>T</title><link>https://c.example/1</link><description>${raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</description></item></channel></rss>`;
    const feed = await state.db.feed.create({ data: { userId, name: "C", url: "https://c.example/feed", unicityCriteria: "sha1:content", fullTextRemoveSelectors: ".ad" } });
    await syncFeed(userId, feed.id);
    const [row] = await state.db.article.findMany({ where: { feedId: feed.id }, select: { dedupeKey: true, content: true } });
    expect(row.dedupeKey).toBe(sha1(raw));
    expect(row.content).not.toContain("Ad</div>");
  });
});


it("rekeys held legacy items before setting the feed marker, then relaxes gates without duplicates", async () => {
  state.body = rss(ITEMS);
  const feed = await state.db.feed.create({ data: { userId, name: "Gated", url: "https://blog.example/gated", unicityCriteria: "sha1:link_published", contentRules: JSON.stringify({ gates: [{ type: "title_include", pattern: "^Beta$" }] }) } });
  const stamp = new Date("2026-01-01T00:00:00Z");
  const legacy = await state.db.article.create({ data: { userId, feedId: feed.id, title: "Alpha", link: ITEMS[0].link, externalId: ITEMS[0].guid, dedupeKey: ITEMS[0].guid, content: "<p>Alpha body</p>", excerpt: "Alpha body", publishedAt: new Date(ITEMS[0].date), isStarred: true, updatedAt: stamp } });
  await syncFeed(userId, feed.id);
  expect(await state.db.article.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({ dedupeKey: sha1(ITEMS[0].link + unix(ITEMS[0].date)), updatedAt: stamp });
  expect((await state.db.feed.findUniqueOrThrow({ where: { id: feed.id } })).dedupeRekeyedFor).toBe("sha1:link_published");
  await state.db.feed.update({ where: { id: feed.id }, data: { contentRules: "{}" } });
  await syncFeed(userId, feed.id);
  expect(await state.db.article.count({ where: { feedId: feed.id } })).toBe(2);
  expect(await state.db.article.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({ isStarred: true, updatedAt: stamp });
});
