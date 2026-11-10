import zlib from "node:zlib";
import { test, expect } from "../helpers/test";

/**
 * Shell spec PR 1 ("slim list + article detail"): the list comes from
 * GET /api/app/articles (50 slim rows per page, server-filtered unread, no
 * bodies) and the reader body from GET /api/app/articles/:id on demand.
 */

const LIST_URL = /\/api\/app\/articles\?/;
const DETAIL_URL = /\/api\/app\/articles\/[^/?]+(\?|$)/;

test("first list response: 50 slim rows, no `content`, ≤ 100 KB gzipped", async ({ app, page }) => {
  const first = page.waitForResponse((r) => LIST_URL.test(r.url()) && r.request().method() === "GET");
  await app.open();
  const response = await first;
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
