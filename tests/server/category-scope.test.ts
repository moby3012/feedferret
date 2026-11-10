// Category names are not unique: `@@unique([userId, name, parentId])` allows
// "News" under two parents, and — NULL parentIds being distinct — several root
// "News" too. The list resolves a by-name selection to ONE category id, so the
// header count and "mark all read" must use that id, not every category with
// the name.
//
// Runs on a temporary SQLite DB by default. Set TEST_DATABASE_PROVIDER=postgresql
// and TEST_DATABASE_URL=postgresql://… (an empty, throwaway database; the
// Prisma client must be generated for postgresql) to run it on Postgres.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";

const PROVIDER = process.env.TEST_DATABASE_PROVIDER === "postgresql" ? "postgresql" : "sqlite";

const state = vi.hoisted(() => ({
  db: null as unknown as PrismaClient,
  provider: "sqlite" as "sqlite" | "postgresql",
  userId: null as string | null,
}));
vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
  getDatabaseProvider: () => state.provider,
}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => (state.userId ? { user: { id: state.userId } } : null)) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Heavy modules feeds.ts imports at top level; irrelevant to these actions.
vi.mock("@/lib/rss-sync", () => ({}));
vi.mock("@/lib/feed-fetcher", () => ({}));
vi.mock("@/lib/ssrf", () => ({}));
vi.mock("@/lib/feed-extraction", () => ({}));
vi.mock("@/lib/page-feed-suggest", () => ({}));
vi.mock("@/lib/page-feed-create", () => ({}));
vi.mock("@/lib/webhooks", () => ({}));
vi.mock("@/lib/retention", () => ({}));
vi.mock("@/lib/crypto", () => ({}));
vi.mock("@/lib/ai-summary", () => ({}));
vi.mock("@/lib/rate-limit", () => ({ RATE_LIMITS: {} }));
vi.mock("@/lib/logger", () => ({ logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/sanitize-html", () => ({}));
vi.mock("@/lib/full-text-fetch", () => ({}));

import { getViewUnreadCount, markAllAsRead } from "../../app/actions/feeds";
import { listArticles } from "../../server/articles/list";
import { categoryKey, markViewScopeOf, scopeFromSidebarKey } from "../../features/reader/nav/sidebar-keys";

const dir = mkdtempSync(join(tmpdir(), "feedferret-category-scope-"));
const ids = { alice: "", bob: "", tech: "", newsChild: "", newsRoot: "", newsRoot2: "", bobNews: "" };
// Unread rows per category.
const N = { newsChild: 3, newsRoot: 4, newsRoot2: 5, bobNews: 6 };

beforeAll(async () => {
  state.provider = PROVIDER;
  const env = { ...process.env, DATABASE_PROVIDER: PROVIDER };
  if (PROVIDER === "postgresql") {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL is required for TEST_DATABASE_PROVIDER=postgresql");
    const schema = join(dir, "schema.prisma");
    writeFileSync(schema, readFileSync("prisma/schema.prisma", "utf8").replace(/provider\s*=\s*"(?:sqlite|postgresql)"/, 'provider = "postgresql"'));
    execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", schema], { env: { ...env, DATABASE_URL: url }, stdio: "pipe" });
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  } else {
    const url = `file:${join(dir, "test.db")}`;
    execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.generated.prisma"], { env: { ...env, DATABASE_URL: url }, stdio: "pipe" });
    state.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  }
  const db = state.db;

  ids.alice = (await db.user.create({ data: { email: "alice@cat.test" } })).id;
  ids.bob = (await db.user.create({ data: { email: "bob@cat.test" } })).id;
  ids.tech = (await db.category.create({ data: { name: "Tech", userId: ids.alice } })).id;
  ids.newsChild = (await db.category.create({ data: { name: "News", userId: ids.alice, parentId: ids.tech, order: 0 } })).id;
  ids.newsRoot = (await db.category.create({ data: { name: "News", userId: ids.alice, order: 1 } })).id;
  // A second root "News": allowed by the unique index (parentId NULL ≠ NULL).
  ids.newsRoot2 = (await db.category.create({ data: { name: "News", userId: ids.alice, order: 2 } })).id;
  ids.bobNews = (await db.category.create({ data: { name: "News", userId: ids.bob } })).id;

  let n = 0;
  for (const [key, count] of Object.entries(N) as [keyof typeof N, number][]) {
    const userId = key === "bobNews" ? ids.bob : ids.alice;
    const feed = await db.feed.create({ data: { name: `feed-${key}`, url: `https://${key}.example/feed`, userId, categoryId: ids[key] } });
    await db.article.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        id: `${key}-${i}`,
        userId,
        feedId: feed.id,
        title: `${key} ${i}`,
        link: `https://${key}.example/${i}`,
        content: "<p>x</p>",
        publishedAt: new Date(Date.UTC(2026, 0, 1) - n++ * 60_000),
      })),
    });
  }
}, 120_000);

afterAll(async () => {
  await state.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  state.userId = ids.alice;
  await state.db.article.updateMany({ data: { isRead: false, readAt: null } });
});

const unreadIn = (categoryId: string) => state.db.article.count({ where: { isRead: false, feed: { categoryId } } });

describe(`same-named categories (${PROVIDER})`, () => {
  it("a sidebar selection carries the category id: each same-named folder lists only itself", async () => {
    for (const [key, n] of [["newsChild", N.newsChild], ["newsRoot", N.newsRoot], ["newsRoot2", N.newsRoot2]] as const) {
      const scope = scopeFromSidebarKey(categoryKey(ids[key]));
      expect(scope).toEqual({ kind: "category", id: ids[key] });
      const page = await listArticles(ids.alice, { scope, show: "unread", sort: "new" });
      expect(page.items.map((i) => i.id).sort()).toEqual(Array.from({ length: n }, (_, i) => `${key}-${i}`).sort());
    }
  });

  it("mark all read from a category scope (by id) marks exactly that folder", async () => {
    const result = await markAllAsRead(markViewScopeOf({ kind: "category", id: ids.newsRoot }));
    expect(result.ids).toHaveLength(N.newsRoot);
    expect(await unreadIn(ids.newsRoot)).toBe(0);
    expect(await unreadIn(ids.newsChild)).toBe(N.newsChild);
    expect(await unreadIn(ids.newsRoot2)).toBe(N.newsRoot2);
    await state.db.article.updateMany({ where: { id: { in: result.ids } }, data: { isRead: false, readAt: null } });
  });

  it("header count counts the resolved category only", async () => {
    expect(await getViewUnreadCount(null, "News", undefined, ids.newsChild)).toBe(N.newsChild);
    expect(await getViewUnreadCount(null, "News", undefined, ids.newsRoot)).toBe(N.newsRoot);
    expect(await getViewUnreadCount(null, "News", undefined, ids.newsRoot2)).toBe(N.newsRoot2);
  });

  it("mark all read marks the resolved category only (child, then a root)", async () => {
    const child = await markAllAsRead({ feedId: null, category: "News", categoryId: ids.newsChild });
    expect(child.ids).toHaveLength(N.newsChild);
    expect(await unreadIn(ids.newsChild)).toBe(0);
    expect(await unreadIn(ids.newsRoot)).toBe(N.newsRoot);
    expect(await unreadIn(ids.newsRoot2)).toBe(N.newsRoot2);

    const root = await markAllAsRead({ feedId: null, category: "News", categoryId: ids.newsRoot2 });
    expect(root.ids).toHaveLength(N.newsRoot2);
    expect(await unreadIn(ids.newsRoot)).toBe(N.newsRoot);
    expect(await unreadIn(ids.newsRoot2)).toBe(0);
  });

  it("another user's category id matches nothing", async () => {
    expect(await getViewUnreadCount(null, "News", undefined, ids.bobNews)).toBe(0);
    expect((await markAllAsRead({ feedId: null, category: "News", categoryId: ids.bobNews })).ids).toEqual([]);
    expect(await unreadIn(ids.bobNews)).toBe(N.bobNews);
  });

  it("without an id (old clients) the by-name scope still covers every same-named category of the user", async () => {
    expect(await getViewUnreadCount(null, "News")).toBe(N.newsChild + N.newsRoot + N.newsRoot2);
  });
});
