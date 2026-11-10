// GET /api/app/articles/head ("↑ N neu" probe, PR 9) against a real
// (temporary) SQLite database: only rows created after the snapshot count,
// with the list's own scope + unread filter, user-scoped, capped; the probe
// is read-only (never touches Article.updatedAt).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient, session: null as null | { user: { id: string } }, limit: false }));
// The per-user limit is exercised by its own test; elsewhere it would count every call of the file.
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/rate-limit")>();
  return {
    ...actual,
    checkRateLimit: (id: string, config: Parameters<typeof actual.checkRateLimit>[1]) =>
      state.limit ? actual.checkRateLimit(id, config) : { success: true, remaining: config.limit, resetAt: Date.now() + 60_000 },
  };
});
vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
  getDatabaseProvider: () => "sqlite",
}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => state.session) }));

import { GET as headGET } from "../../app/api/app/articles/head/route";
import { GET as listGET } from "../../app/api/app/articles/route";
import { HEAD_COUNT_CAP } from "../../server/articles/head";

const dir = mkdtempSync(join(tmpdir(), "feedferret-head-probe-"));
const ids = { alice: "", bob: "", feed: "", feed2: "", hidden: "", cat: "", bobFeed: "", storyFeed: "" };

const T0 = Date.UTC(2026, 10, 10, 8);
const SNAPSHOT = T0 + 60 * 60_000;
const after = (min: number) => new Date(SNAPSHOT + min * 60_000);
const before = (min: number) => new Date(SNAPSHOT - min * 60_000);

beforeAll(async () => {
  const url = `file:${join(dir, "test.db")}`;
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.generated.prisma"], {
    env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: url },
    stdio: "pipe",
  });
  state.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  const db = state.db;
  ids.alice = (await db.user.create({ data: { email: "alice@test", name: "Alice" } })).id;
  ids.bob = (await db.user.create({ data: { email: "bob@test", name: "Bob" } })).id;
  ids.cat = (await db.category.create({ data: { name: "Tech", userId: ids.alice } })).id;
  ids.feed = (await db.feed.create({ data: { name: "A1", url: "https://a.example/feed", userId: ids.alice, categoryId: ids.cat } })).id;
  ids.feed2 = (await db.feed.create({ data: { name: "A2", url: "https://a2.example/feed", userId: ids.alice } })).id;
  ids.hidden = (await db.feed.create({ data: { name: "Hidden", url: "https://h.example/feed", userId: ids.alice, hideFromAllFeeds: true } })).id;
  ids.bobFeed = (await db.feed.create({ data: { name: "B1", url: "https://b.example/feed", userId: ids.bob } })).id;
  // Hidden from "All articles" so the story rows below do not change the All counts of the other tests.
  ids.storyFeed = (await db.feed.create({ data: { name: "Stories", url: "https://s.example/feed", userId: ids.alice, hideFromAllFeeds: true } })).id;
  const cluster = { userId: ids.alice, leadArticleId: "story-a", firstSeenAt: before(5), lastSeenAt: after(3), sig: "{}" };
  await db.storyCluster.create({ data: { id: "cl-1", ...cluster, size: 3 } });
  await db.storyCluster.create({ data: { id: "cl-solo", ...cluster, leadArticleId: "story-solo", size: 1, feedCount: 1 } });

  const row = (id: string, userId: string, feedId: string, createdAt: Date, extra: Record<string, unknown> = {}) => ({
    id,
    userId,
    feedId,
    title: id,
    link: `https://x.example/${id}`,
    content: "<p>x</p>",
    publishedAt: createdAt,
    createdAt,
    ...extra,
  });
  await db.article.createMany({
    data: [
      // In the snapshot already.
      row("old-1", ids.alice, ids.feed, before(30)),
      row("old-2", ids.alice, ids.feed2, before(10)),
      // Arrived after it.
      row("new-1", ids.alice, ids.feed, after(1)),
      row("new-2", ids.alice, ids.feed, after(2)),
      row("new-3", ids.alice, ids.feed2, after(3)),
      row("new-read", ids.alice, ids.feed2, after(4), { isRead: true, readAt: after(5) }),
      row("new-hidden", ids.alice, ids.hidden, after(5)),
      row("new-spoiler", ids.alice, ids.feed, after(6), { isSpoiler: true }),
      // Old publishedAt, synced late: still new (it was not in the snapshot).
      row("new-backdated", ids.alice, ids.feed, after(7), { publishedAt: before(600) }),
      // One story from two sources (+ a member already in the snapshot) in the clustered feed.
      row("story-old", ids.alice, ids.storyFeed, before(5), { clusterId: "cl-1" }),
      row("story-a", ids.alice, ids.storyFeed, after(2), { clusterId: "cl-1" }),
      row("story-b", ids.alice, ids.storyFeed, after(3), { clusterId: "cl-1" }),
      // clusterId but size 1: a plain row in the list (groupStories folds size ≥ 2 only).
      row("story-solo", ids.alice, ids.storyFeed, after(4), { clusterId: "cl-solo" }),
      row("story-plain", ids.alice, ids.storyFeed, after(5)),
      row("bob-new", ids.bob, ids.bobFeed, after(8)),
    ],
  });
}, 60_000);

afterAll(async () => {
  await state.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  state.session = { user: { id: ids.alice } };
  state.limit = false;
});

async function head(qs: string) {
  const res = await headGET(new Request(`https://ff.test/api/app/articles/head?${qs}`));
  return { status: res.status, body: await res.json(), headers: res.headers };
}

describe("GET /api/app/articles/head", () => {
  it("requires a session", async () => {
    state.session = null;
    expect((await head(`since=${SNAPSHOT}`)).status).toBe(401);
  });

  it("rejects a missing or malformed since", async () => {
    expect((await head("")).status).toBe(400);
    expect((await head("since=abc")).status).toBe(400);
    expect((await head("since=-5")).status).toBe(400);
    expect((await head("since=1e9")).status).toBe(400);
    expect((await head(`since=${SNAPSHOT}&feed=a&cat=b`)).status).toBe(400);
  });

  it("counts unread rows created after the snapshot, in the list's own scope", async () => {
    // All (unread): new-1, new-2, new-3, new-backdated — not read, hidden-feed, spoiler or bob's.
    const all = await head(`since=${SNAPSHOT}`);
    expect(all.status).toBe(200);
    expect(all.headers.get("cache-control")).toContain("no-store");
    expect(all.body).toEqual({ count: 4, newestCursor: String(after(7).getTime()) });

    expect((await head(`since=${SNAPSHOT}&show=all`)).body.count).toBe(5); // + new-read
    expect((await head(`since=${SNAPSHOT}&feed=${ids.feed}`)).body.count).toBe(3);
    expect((await head(`since=${SNAPSHOT}&feed=${ids.hidden}`)).body.count).toBe(1);
    expect((await head(`since=${SNAPSHOT}&cat=${ids.cat}`)).body.count).toBe(3);
    expect((await head(`since=${SNAPSHOT}&v=spoiler`)).body.count).toBe(1);
  });

  it("returns nothing when nothing arrived since", async () => {
    expect((await head(`since=${after(60).getTime()}`)).body).toEqual({ count: 0, newestCursor: null });
  });

  it("never probes oldest-first, recently-read or search lists", async () => {
    expect((await head(`since=${SNAPSHOT}&sort=old`)).body.count).toBe(0);
    expect((await head(`since=${SNAPSHOT}&v=recent`)).body.count).toBe(0);
    expect((await head(`since=${SNAPSHOT}&q=new`)).body.count).toBe(0);
  });

  it("is user-scoped: another user's feed id matches nothing", async () => {
    expect((await head(`since=${SNAPSHOT}&feed=${ids.bobFeed}`)).body.count).toBe(0);
    state.session = { user: { id: ids.bob } };
    expect((await head(`since=${SNAPSHOT}`)).body.count).toBe(1);
    expect((await head(`since=${SNAPSHOT}&feed=${ids.feed}`)).body.count).toBe(0);
  });

  it("agrees with the list: a list loaded now has exactly the probed rows on top", async () => {
    const res = await listGET(new Request(`https://ff.test/api/app/articles?feed=${ids.feed}`));
    const page = await res.json();
    const newer = page.items.filter((i: { createdAt: string }) => Date.parse(i.createdAt) > SNAPSHOT).map((i: { id: string }) => i.id);
    expect(newer.sort()).toEqual(["new-1", "new-2", "new-backdated"]);
    expect((await head(`since=${SNAPSHOT}&feed=${ids.feed}`)).body.count).toBe(newer.length);
    // The fresh snapshot of that page has nothing newer.
    expect((await head(`since=${page.snapshotAt}&feed=${ids.feed}`)).body.count).toBe(0);
  });

  it(`caps the count at ${HEAD_COUNT_CAP}`, async () => {
    const db = state.db;
    const capFeed = (await db.feed.create({ data: { name: "Flood", url: "https://flood.example/feed", userId: ids.alice } })).id;
    await db.article.createMany({
      data: Array.from({ length: HEAD_COUNT_CAP + 20 }, (_, i) => ({
        id: `flood-${i}`,
        userId: ids.alice,
        feedId: capFeed,
        title: `flood ${i}`,
        link: `https://flood.example/${i}`,
        content: "<p>x</p>",
        publishedAt: after(10),
        createdAt: after(10 + i / 100),
      })),
    });
    const res = await head(`since=${SNAPSHOT}&feed=${capFeed}`);
    expect(res.body.count).toBe(HEAD_COUNT_CAP);
  });

  it("is read-only: no article row changes (updatedAt untouched)", async () => {
    const snapshot = async () =>
      (await state.db.article.findMany({ select: { id: true, updatedAt: true, isRead: true }, orderBy: { id: "asc" } })).map((r) => `${r.id}:${r.updatedAt.getTime()}:${r.isRead}`);
    const beforeRows = await snapshot();
    await head(`since=${SNAPSHOT}`);
    await head(`since=${SNAPSHOT}&feed=${ids.feed}&show=all`);
    expect(await snapshot()).toEqual(beforeRows);
  });

  it("counts display stories in clustered lists, articles in the others", async () => {
    // Feed list (groups stories): cl-1 (story-a + story-b) once, story-solo, story-plain.
    expect((await head(`since=${SNAPSHOT}&feed=${ids.storyFeed}`)).body).toEqual({ count: 3, newestCursor: String(after(5).getTime()) });
    // Starred / Read later never fold clusters: every starred arrival counts.
    await state.db.article.updateMany({ where: { id: { in: ["story-a", "story-b"] } }, data: { isStarred: true } });
    try {
      expect((await head(`since=${SNAPSHOT}&v=starred`)).body.count).toBe(2);
    } finally {
      await state.db.article.updateMany({ where: { id: { in: ["story-a", "story-b"] } }, data: { isStarred: false } });
    }
  });

  it("does not count rows the client already shows (x=…), and rejects oversized lists", async () => {
    expect((await head(`since=${SNAPSHOT}&feed=${ids.feed}&x=new-backdated`)).body.count).toBe(2);
    expect((await head(`since=${SNAPSHOT}&feed=${ids.feed}&x=new-backdated,new-2`)).body).toEqual({ count: 1, newestCursor: String(after(1).getTime()) });
    // Both story members shown: the story is not new any more.
    expect((await head(`since=${SNAPSHOT}&feed=${ids.storyFeed}&x=story-a,story-b`)).body.count).toBe(2);
    const tooMany = Array.from({ length: 51 }, (_, i) => `id${i}`).join(",");
    expect((await head(`since=${SNAPSHOT}&x=${tooMany}`)).status).toBe(400);
  });

  it("is rate-limited per user", async () => {
    state.limit = true;
    state.session = { user: { id: ids.bob } };
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await head(`since=${SNAPSHOT}`)).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    const limited = await head(`since=${SNAPSHOT}`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    // Another user has their own budget.
    state.session = { user: { id: ids.alice } };
    expect((await head(`since=${SNAPSHOT}`)).status).toBe(200);
  });
});
