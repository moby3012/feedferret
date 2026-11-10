import type { Page, Request } from "@playwright/test";
import { test, expect, type App } from "../helpers/test";
import { articleFlags, starredCountInDb, unreadCountInDb } from "../helpers/db";

/**
 * Single cache owner + batched optimistic toggles (shell spec PR 2, UX audit
 * P1-05): toggles flip before the network answers, a failed write reverts
 * exactly that field with one toast, counts stay consistent, and rapid
 * toggles are coalesced into few action calls.
 *
 * Seed (e2e/fixtures/data.mjs): #001–#012 unread; #004 starred; #006 read-later.
 */

const isAction = (r: Request) => r.method() === "POST" && !!r.headers()["next-action"];

function countActions(page: Page) {
  const seen: Request[] = [];
  const onRequest = (r: Request) => {
    if (isAction(r)) seen.push(r);
  };
  page.on("request", onRequest);
  return {
    get count() {
      return seen.length;
    },
    stop: () => page.off("request", onRequest),
  };
}

/** Chromium network emulation (Slow 3G-like: 2 s RTT) for the whole page. */
async function throttle(page: Page, latencyMs = 2000) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: latencyMs,
    downloadThroughput: (400 * 1024) / 8,
    uploadThroughput: (400 * 1024) / 8,
  });
  return cdp;
}

/** Clicks a row's toggle inside the page and returns its accessible name one animation frame later. */
async function clickAndReadNextFrame(page: Page, num: number, name: RegExp) {
  const pad = String(num).padStart(3, "0");
  return page.evaluate(
    ({ pad, source }) => {
      const re = new RegExp(source);
      const row = () => document.querySelector(`[role="button"][aria-label*="(#${pad})"]`);
      const button = () => [...(row()?.querySelectorAll("button") ?? [])].find((b) => re.test(b.getAttribute("aria-label") ?? ""));
      button()!.click();
      return new Promise<string[]>((resolve) =>
        requestAnimationFrame(() => resolve([...(row()?.querySelectorAll("button") ?? [])].map((b) => b.getAttribute("aria-label") ?? ""))),
      );
    },
    { pad, source: name.source },
  );
}

test("star, read-later and read flip in the same frame on a throttled network; counts move at once", async ({ app, page }) => {
  await app.open();
  const starredBefore = await app.sidebarCount("Starred");
  const unreadBefore = await app.sidebarCount("All articles");
  const cdp = await throttle(page);

  expect(await clickAndReadNextFrame(page, 1, /^Star$/)).toContain("Remove star");
  expect(await clickAndReadNextFrame(page, 1, /^Save to Read Later$/)).toContain("Remove from Read Later");
  expect(await clickAndReadNextFrame(page, 2, /^Mark as read$/)).toContain("Mark as unread");

  // Sidebar counts are optimistic too (the write is still on the wire).
  expect(await app.sidebarCount("Starred")).toBe(starredBefore + 1);
  expect(await app.sidebarCount("All articles")).toBe(unreadBefore - 1);
  // A read row stays in the unread list (snapshot semantics).
  await expect(app.row(2)).toBeVisible();

  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await expect.poll(() => articleFlags(app.articleId(1)), { timeout: 15_000 }).toMatchObject({ isStarred: true, isReadLater: true });
  await expect.poll(() => articleFlags(app.articleId(2)).isRead, { timeout: 15_000 }).toBe(true);
});

test("a failed write reverts exactly that field and shows one toast", async ({ app, page }) => {
  await app.open();
  // A successful write first: it must survive the later failure.
  await app.toggle(3, "read");
  await expect.poll(() => articleFlags(app.articleId(3)).isRead).toBe(true);
  const starredBefore = await app.sidebarCount("Starred");

  await page.route("**/*", (route) => (isAction(route.request()) ? route.abort("failed") : route.continue()));
  await app.toggle(3, "star");
  await app.toggle(5, "later");

  const failToast = page.locator("[data-sonner-toast]").filter({ hasText: "Couldn't save that change" });
  await expect(failToast).toHaveCount(1);
  await app.expectRow(3, { starred: false });
  await app.expectRow(5, { later: false });
  // The earlier, successful read is untouched.
  await app.expectRow(3, { read: true });
  expect(await app.sidebarCount("Starred")).toBe(starredBefore);
  await page.waitForTimeout(1500);
  await expect(failToast).toHaveCount(1);
  expect(articleFlags(app.articleId(3))).toMatchObject({ isRead: true, isStarred: false });
  expect(articleFlags(app.articleId(5)).isReadLater).toBe(false);
  await page.unroute("**/*");
});

test("20 rapid toggles: UI, sidebar counts and DB agree, before and after reload", async ({ app, page }) => {
  // Touch: each toggle is a long-press + menu tap (~1.5 s).
  if (app.isMobile) test.setTimeout(120_000);
  await app.open();
  const actions = countActions(page);
  for (let i = 0; i < 20; i++) {
    const num = (i % 7) + 1;
    await app.toggle(num, i % 2 === 0 ? "star" : "read");
  }
  // Coalesced: far fewer action calls than toggles. (Touch toggles go through
  // the long-press menu, ~1 s each: every one flushes alone there — the
  // batching itself is covered at tap cadence by the tests below.)
  await expect.poll(() => actions.count, { timeout: 10_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  if (!app.isMobile) expect(actions.count).toBeLessThanOrEqual(6);
  actions.stop();

  const starredInDb = () => [1, 2, 3, 4, 5, 6, 7].filter((n) => articleFlags(app.articleId(n)).isStarred).length;
  const starredInUi = async () => {
    let n = 0;
    for (const num of [1, 2, 3, 4, 5, 6, 7]) if ((await app.rowHost(num).getAttribute("data-starred")) !== null) n++;
    return n;
  };
  await expect.poll(starredInDb, { timeout: 10_000 }).toBe(await starredInUi());

  const check = async () => {
    expect(await app.sidebarCount("All articles")).toBe(unreadCountInDb(app.userKey));
    expect(await app.sidebarCount("Starred")).toBe(starredCountInDb(app.userKey));
  };
  await check();
  // Fresh page: the server-side counts must agree with what was shown.
  await page.reload();
  await expect(page.locator('[role="button"][aria-label*=" — "]').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  await check();
});

/**
 * A star button of #001 that a finger can hit at tap cadence: the row's with
 * a mouse; on touch (rows have no buttons) the reader pill's — opened first,
 * and only once its automatic mark-read has been written.
 */
async function tapStar(app: App, page: Page) {
  if (!app.isMobile) return app.rowActions(1).star;
  await app.activate(app.row(1));
  await expect.poll(() => articleFlags(app.articleId(1)).isRead).toBe(true);
  await page.waitForTimeout(1200);
  return page.locator('[data-pane="reader"] .ff-reader-pill').getByRole("button", { name: /^(Star|Remove star)$/ });
}

test("10 rapid toggles of one star send at most 2 action calls", async ({ app, page }) => {
  await app.open();
  const star = await tapStar(app, page);
  const actions = countActions(page);
  for (let i = 0; i < 10; i++) await app.activate(star);
  await page.waitForTimeout(2000);
  // Each toggle meets its inverse in the queue (taps land well inside the
  // trailing window), so the count does not grow with how long tapping took.
  expect(actions.count).toBeLessThanOrEqual(2);
  actions.stop();
  // Even number of toggles: back where it started, on screen and on the server.
  await expect(star).toHaveAccessibleName("Star");
  expect(articleFlags(app.articleId(1)).isStarred).toBe(false);
});

test("toggles at human tap cadence (~220 ms apart) cancel out instead of one call per tap", async ({ app, page }) => {
  // Regression: with a 150 ms trailing window every tap of mobile-emulated CI
  // (~200 ms apart) was flushed alone -> 10 taps, 10 calls. Paced so local and
  // CI runs see the same gap.
  await app.open();
  const star = await tapStar(app, page);
  const actions = countActions(page);
  for (let i = 0; i < 10; i++) {
    const started = Date.now();
    await app.activate(star);
    await page.waitForTimeout(Math.max(0, 220 - (Date.now() - started)));
  }
  await page.waitForTimeout(2000);
  expect(actions.count).toBeLessThanOrEqual(2);
  actions.stop();
  await expect(star).toHaveAccessibleName("Star");
  expect(articleFlags(app.articleId(1)).isStarred).toBe(false);
});

test("a single toggle is one action call: no feeds / labels / counts refetch afterwards", async ({ app, page }) => {
  await app.open();
  // The offline-reading boot pass (4 s after mount: session check, Read-later
  // list, then the bodies, paced) must not land in the window: a touch toggle
  // goes through the long-press menu and takes ~1 s longer than a click.
  await app.offlinePassDone();
  const actions = countActions(page);
  const gets: string[] = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    // Article BODIES are not refetches: the offline store's paced Read-later
    // prefetch, and the press-to-open prefetch of the touched row.
    if (/^\/api\/app\/articles\/[^/]+$/.test(path)) return;
    if (r.method() === "GET" && path.startsWith("/api/")) gets.push(path);
  });
  await app.toggle(1, "star");
  await page.waitForTimeout(2500);
  expect(actions.count).toBe(1);
  expect(gets).toEqual([]);
  actions.stop();
});

test("marking read keeps the row until the view changes", async ({ app, page }) => {
  await app.open();
  await app.toggle(2, "read");
  await app.expectRow(2, { read: true });
  await page.waitForTimeout(500);
  await expect(app.row(2)).toBeVisible();
  // Leave and come back: the read row is gone from the unread view.
  await app.selectSidebar(/^Starred\s*\d*$/);
  await expect(page.getByRole("heading", { level: 2, name: "Starred" })).toBeVisible();
  await app.selectSidebar(/^All articles\s*\d*$/);
  await expect(app.row(1)).toBeVisible();
  await expect(app.row(2)).toHaveCount(0);
});

test("offline is read-only: chip shown, toggles refused with a toast", async ({ app, page, context }) => {
  await app.open();
  await context.setOffline(true);
  await expect(page.getByTestId("offline-chip")).toBeVisible();
  await app.toggle(1, "star");
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Offline – changes only when back online" })).toHaveCount(1);
  await app.expectRow(1, { starred: false });
  await context.setOffline(false);
  await expect(page.getByTestId("offline-chip")).toHaveCount(0);
  expect(articleFlags(app.articleId(1)).isStarred).toBe(false);
});
