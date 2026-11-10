// G1 review fix: a Google News article's identity must not depend on link
// resolution or title cleanup, whatever the feed's unicityCriteria. Runs the
// real syncFeed against a real SQLite DB; only the feed fetch and the Google
// link-decoding endpoints are faked (no network).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const state = vi.hoisted(() => ({
  db: null as unknown as PrismaClient,
  fetchFeed: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
}));
vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
  getDatabaseProvider: () => "sqlite",
}));
vi.mock("@/lib/feed-fetcher", async (importOriginal) => {
  state.fetchFeed = vi.fn();
  return { ...(await importOriginal<typeof import("../../lib/feed-fetcher")>()), fetchFeedArticles: state.fetchFeed };
});

import { syncFeed } from "../../lib/rss-sync";
import { resetGoogleNewsResolverState } from "../../lib/google-news";
import { buildDedupeKey } from "../../lib/dedupe-key";

const dir = mkdtempSync(join(tmpdir(), "feedferret-g1-sync-"));
let userId = "";
const FEED_URL = "https://news.google.com/rss/search?q=Elektroauto&hl=de&gl=DE&ceid=DE%3Ade";
const IDS = ["CBMiQUFVX3lxTGFhYWFhYWFhYWFh", "CBMiQUFVX3lxTGJiYmJiYmJiYmJi"];
const googleLink = (id: string) => `https://news.google.com/rss/articles/${id}?oc=5`;
const publisher = (id: string) => `https://publisher.example/story-${id.slice(-4)}`;

function remoteItems() {
  return IDS.map((id, n) => ({
    title: `Story ${n + 1} - Tagesspiegel`,
    link: googleLink(id),
    content: `<a href="${googleLink(id)}">Story ${n + 1}</a>`,
    externalId: id,
    publishedAt: new Date(Date.UTC(2026, 10, 10, 12 - n)),
    sourceName: "Tagesspiegel",
  }));
}

type Fetch = (url: string, init: RequestInit) => Promise<{ notModified: false; text: string; etag: null; lastModified: null }>;
const failingGoogle: Fetch = async () => {
  throw new Error("Fetch failed: 500");
};
const workingGoogle: Fetch = async (url, init) => {
  const ok = (text: string) => ({ notModified: false as const, text, etag: null, lastModified: null });
  if (url.includes("/batchexecute")) {
    const outer = JSON.parse(decodeURIComponent(String(init.body).slice("f.req=".length)));
    const rows = outer[0].map((env: string[]) => {
      const id = JSON.parse(env[1])[2] as string;
      return ["wrb.fr", "Fbv4je", JSON.stringify(["garturlres", publisher(id), 1]), null, null, null, env[3]];
    });
    return ok(`)]}'\n\n${JSON.stringify(rows)}`);
  }
  return ok(`<div data-n-a-ts="1794350423" data-n-a-sg="AdwtSYsignature1"></div>`);
};

beforeAll(async () => {
  const url = `file:${join(dir, "test.db")}`;
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.generated.prisma"], {
    env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: url },
    stdio: "pipe",
  });
  state.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  userId = (await state.db.user.create({ data: { email: "g1@test", name: "G1" } })).id;
}, 120_000);

afterAll(async () => {
  await state.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  resetGoogleNewsResolverState();
  state.fetchFeed.mockReset();
  state.fetchFeed.mockImplementation(async () => ({ title: '"Elektroauto" - Google News', articles: remoteItems() }));
  await state.db.feed.deleteMany({ where: { userId } });
});

async function rows(feedId: string) {
  return state.db.article.findMany({
    where: { feedId },
    orderBy: { publishedAt: "desc" },
    select: { id: true, dedupeKey: true, link: true, title: true, isRead: true, updatedAt: true, contentHash: true },
  });
}

describe.each(["id", "link", "title", "link:title"])("unicityCriteria=%s", (criteria) => {
  it("resolving the link on a later sync keeps the same row, its read state and Article.updatedAt", async () => {
    const feed = await state.db.feed.create({ data: { userId, name: "Google News: Elektroauto", url: FEED_URL, unicityCriteria: criteria } });

    // Sync 1: Google refuses link decoding → rows keep Google links.
    await syncFeed(userId, feed.id, { googleNews: { fetchImpl: failingGoogle } });
    const first = await rows(feed.id);
    expect(first).toHaveLength(2);
    expect(first.map((r) => r.dedupeKey)).toEqual(IDS);
    expect(first[0].link).toBe(googleLink(IDS[0]));
    expect(first[0].title).toBe("Story 1"); // suffix stripped at insert
    await state.db.article.updateMany({ where: { feedId: feed.id }, data: { isRead: true } });
    const before = await rows(feed.id);

    // Sync 2: decoding works → same rows, link rewritten cosmetically.
    resetGoogleNewsResolverState();
    await new Promise((resolve) => setTimeout(resolve, 15));
    await syncFeed(userId, feed.id, { googleNews: { fetchImpl: workingGoogle } });
    const after = await rows(feed.id);
    expect(after).toHaveLength(2);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.map((r) => r.link)).toEqual(IDS.map(publisher));
    expect(after.every((r) => r.isRead)).toBe(true);
    expect(after.map((r) => r.updatedAt.getTime())).toEqual(before.map((r) => r.updatedAt.getTime()));
    expect(after[0].contentHash).not.toBe(before[0].contentHash);

    // Sync 3: nothing changes any more.
    await syncFeed(userId, feed.id, { googleNews: { fetchImpl: workingGoogle } });
    const third = await rows(feed.id);
    expect(third).toEqual(after);
  });

  it("first-sync resolution creates rows keyed by the guid, and re-syncs never duplicate them", async () => {
    const feed = await state.db.feed.create({ data: { userId, name: "Google News: Elektroauto", url: FEED_URL, unicityCriteria: criteria } });
    await syncFeed(userId, feed.id, { googleNews: { fetchImpl: workingGoogle } });
    const first = await rows(feed.id);
    expect(first.map((r) => [r.dedupeKey, r.link])).toEqual(IDS.map((id) => [id, publisher(id)]));
    const stamps = first.map((r) => r.updatedAt.getTime());
    await new Promise((resolve) => setTimeout(resolve, 15));
    // Even with Google down on the re-sync, the stored (resolved) rows are matched.
    resetGoogleNewsResolverState();
    await syncFeed(userId, feed.id, { googleNews: { fetchImpl: failingGoogle } });
    const again = await rows(feed.id);
    expect(again.map((r) => r.id)).toEqual(first.map((r) => r.id));
    expect(again.map((r) => r.updatedAt.getTime())).toEqual(stamps);
  });
});

it("rows stored under a legacy criteria-based key keep that key (no duplicate after upgrade)", async () => {
  const feed = await state.db.feed.create({ data: { userId, name: "Google News: Elektroauto", url: FEED_URL, unicityCriteria: "link" } });
  const [item] = remoteItems();
  const legacyKey = buildDedupeKey({ unicityCriteria: "link" }, item, item.externalId);
  expect(legacyKey).toBe(googleLink(IDS[0]));
  // A row as the pre-fix sync stored it: Google link, key derived from the link.
  await syncFeed(userId, feed.id, { googleNews: { fetchImpl: failingGoogle } });
  await state.db.$executeRawUnsafe(`UPDATE "Article" SET "dedupeKey" = ?, "isRead" = 1 WHERE "feedId" = ? AND "dedupeKey" = ?`, legacyKey, feed.id, IDS[0]);
  const legacy = (await rows(feed.id)).find((r) => r.dedupeKey === legacyKey)!;
  expect(legacy.link).toBe(googleLink(IDS[0]));
  resetGoogleNewsResolverState();
  await new Promise((resolve) => setTimeout(resolve, 15));
  await syncFeed(userId, feed.id, { googleNews: { fetchImpl: workingGoogle } });
  const all = await rows(feed.id);
  expect(all).toHaveLength(2);
  const kept = all.find((r) => r.id === legacy.id)!;
  expect(kept).toMatchObject({ dedupeKey: legacyKey, link: publisher(IDS[0]), isRead: true });
  expect(kept.updatedAt.getTime()).toBe(legacy.updatedAt.getTime());
});
