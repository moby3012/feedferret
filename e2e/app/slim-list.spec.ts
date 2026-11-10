import zlib from "node:zlib";
import { test, expect } from "../helpers/test";
import { articleFlags } from "../helpers/db";

/**
 * Shell spec PR 1 ("slim list + article detail"): the list comes from
 * GET /api/app/articles (50 slim rows per page, server-filtered unread, no
 * bodies) and the reader body from GET /api/app/articles/:id on demand.
 */

const LIST_URL = /\/api\/app\/articles\?/;
const DETAIL_URL = /\/api\/app\/articles\/[^/?]+(\?|$)/;

test("first list response: 50 slim rows, no `content`, ≤ 100 KB gzipped", async ({ app, page }) => {
  // Since the cold-start bootstrap (shell spec PR 5) the first page arrives in
  // the HTML; the endpoint serves every page after it (and other scopes):
  // request the same URL the client would.
  await app.open();
  const response = await page.request.get("/api/app/articles?show=unread&sort=new&limit=50", { headers: { "accept-encoding": "gzip" } });
  expect(response.status()).toBe(200);
  const raw = await response.body();
  const body = JSON.parse(raw.toString("utf8"));
  expect(body.items).toHaveLength(50);
  expect(typeof body.nextCursor).toBe("string");
  for (const item of body.items) {
    expect(item).not.toHaveProperty("content");
    expect(item.isRead).toBe(false); // default view is server-filtered to unread
  }
  expect(raw.toString("utf8")).not.toContain('"content"');
  expect(zlib.gzipSync(raw).length).toBeLessThanOrEqual(100 * 1024);
  expect(response.headers()["cache-control"]).toContain("no-store");
});

test("reader shows the title at once and the body after the (slow) detail fetch", async ({ app, page }) => {
  await app.open();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(DETAIL_URL, async (route) => {
    await gate;
    await route.continue();
  });

  await app.activate(app.row(1));
  const reader = page.locator("article").filter({ hasText: app.user.firstArticleTitle });
  // Title + meta come from the list row: painted while the body is still in flight.
  await expect(reader.getByRole("heading", { level: 1, name: app.user.firstArticleTitle })).toBeVisible({ timeout: 2_000 });
  await expect(reader.getByTestId("reader-body-loading")).toBeVisible();
  await expect(reader.locator(".article-content")).toHaveCount(0);

  release();
  await expect(reader.locator(".article-content")).toContainText(app.user.firstArticleBodyStart.slice(0, 25));
  await expect(reader.getByTestId("reader-body-loading")).toHaveCount(0);
});

test("unread view pages at 50 and the oldest unread article is reachable by scrolling", async ({ app, page }) => {
  // Ground truth straight from the API (same session): every unread row, oldest last.
  const unread: { id: string; title: string }[] = [];
  let cursor: string | null = null;
  do {
    const res: import("@playwright/test").APIResponse = await page.request.get(`/api/app/articles?show=unread&sort=new&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    expect(res.status()).toBe(200);
    const body: { items: { id: string; title: string }[]; nextCursor: string | null } = await res.json();
    expect(body.items.length).toBeLessThanOrEqual(50);
    unread.push(...body.items);
    cursor = body.nextCursor;
  } while (cursor);
  expect(unread.length).toBe(app.user.counts.unread);
  expect(unread.length).toBeGreaterThan(50);

  const pageRequests: string[] = [];
  page.on("request", (r) => {
    if (LIST_URL.test(r.url())) pageRequests.push(r.url());
  });
  await app.open();
  const oldest = unread[unread.length - 1];
  const target = page.locator(`[data-article-id="${oldest.id}"]`);
  for (let i = 0; i < 40 && (await target.count()) === 0; i++) {
    await page.locator("[data-article-id]").last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
  }
  await expect(target).toBeVisible();
  // Reached through cursor pages, never one big response.
  expect(pageRequests.some((u) => u.includes("cursor="))).toBe(true);
  expect(await page.locator("[data-article-id]").count()).toBeGreaterThanOrEqual(unread.length);
});

test("app endpoints need a session", async ({ playwright }, testInfo) => {
  const anonymous = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL, storageState: { cookies: [], origins: [] } });
  try {
    expect((await anonymous.get("/api/app/articles")).status()).toBe(401);
    expect((await anonymous.get("/api/app/articles/anything")).status()).toBe(401);
  } finally {
    await anonymous.dispose();
  }
});

test("unread view keeps rows read this session across toggles and focus; an explicit refresh resets the snapshot", async ({ app, page }) => {
  await app.open();
  const viewport = app.listScroller();
  // Scroll a bit so the position check means something.
  await viewport.evaluate((el) => el.scrollTo(0, 240));

  // Read three articles: one by opening it, two from the row action.
  await app.activate(app.row(4));
  await expect.poll(() => articleFlags(app.articleId(4)).isRead).toBe(true);
  if (app.isMobile) await app.activate(page.getByRole("button", { name: /^(Back to list|Back)$/ }).first());
  for (const num of [5, 6]) {
    await app.activate(app.rowActions(num).read);
    await expect.poll(() => articleFlags(app.articleId(num)).isRead).toBe(true);
  }
  await page.waitForLoadState("networkidle");
  // The star click below must not scroll the list itself.
  await app.rowActions(7).star.scrollIntoViewIfNeeded();
  const before = await viewport.evaluate((el) => el.scrollTop);
  const rowTop = async () => (await app.row(5).boundingBox())?.y ?? -1;
  const rowTopBefore = await rowTop();

  const listRequests: string[] = [];
  page.on("request", (r) => {
    if (LIST_URL.test(r.url())) listRequests.push(r.url());
  });
  // Star another article (used to invalidate + refetch every list), then
  // bring the window back into focus (used to refetch stale lists).
  await app.activate(app.rowActions(7).star);
  await expect.poll(() => articleFlags(app.articleId(7)).isStarred).toBe(true);
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    window.dispatchEvent(new Event("focus"));
  });
  await page.waitForTimeout(500);
  await page.waitForLoadState("networkidle");

  for (const num of [4, 5, 6]) {
    await expect(app.row(num)).toHaveCount(1);
    await expect(app.rowActions(num).read).toHaveAccessibleName("Mark as unread");
  }
  await expect(app.rowActions(7).star).toHaveAccessibleName("Remove star");
  // Star is patched into the cache; focus does not refetch the list.
  expect(listRequests).toEqual([]);
  expect(Math.abs((await viewport.evaluate((el) => el.scrollTop)) - before)).toBeLessThanOrEqual(2);
  expect(Math.abs((await rowTop()) - rowTopBefore)).toBeLessThanOrEqual(2);

  // An explicit refresh (keyboard "r") resets the snapshot (shell spec §2.3 /
  // §4.8): the server no longer returns the three read rows, so they leave.
  const refetched = page.waitForResponse((r) => LIST_URL.test(r.url()) && r.request().method() === "GET", { timeout: 30_000 });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("r");
  const body = await (await refetched).json();
  for (const num of [4, 5, 6]) expect(body.items.map((i: { id: string }) => i.id)).not.toContain(app.articleId(num));
  await page.waitForLoadState("networkidle");
  for (const num of [4, 5, 6]) await expect(app.row(num)).toHaveCount(0);
  await expect(app.row(7)).toHaveCount(1);
});
