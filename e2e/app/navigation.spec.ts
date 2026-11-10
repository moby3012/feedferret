import type { Page } from "@playwright/test";
import { test, expect, type App } from "../helpers/test";

/**
 * Navigation (desktop 1280x800 and mobile 390x844 touch). URL + history are
 * the source of truth (.pm/spec-shell-design.md §1.3/§1.4, audit P1-03/P1-04):
 * the open article is `?a=`, feeds/categories are `?feed=` / `?cat=`, system
 * back goes one level up and never leaves the app while a level is open.
 */

const reader = (page: Page, num: number) => page.locator("article").filter({ hasText: `(#${String(num).padStart(3, "0")})` });
const historyLength = (page: Page) => page.evaluate(() => history.length);
const backButton = (page: Page) => page.getByRole("button", { name: /^(Back to list|Back)$/ }).first();

/** Opens the Solo Blog feed (sidebar on desktop, Feeds tab on mobile). */
async function openSoloBlog(app: App, page: Page) {
  await app.selectSidebar(/^Solo Blog\s*\d+$/);
  await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeVisible();
  await expect(app.row(8)).toBeVisible();
}

/** Records RSC (server component) requests: in-shell navigation must not cause any. */
function trackRsc(page: Page) {
  const hits: string[] = [];
  page.on("request", (r) => {
    // Only the shell route: <Link> prefetches of /settings etc. are fine.
    if (new URL(r.url()).pathname === "/" && (r.headers()["rsc"] === "1" || /[?&]_rsc=/.test(r.url()))) hits.push(r.url());
  });
  return hits;
}

test("app opens: list visible with seeded articles and sidebar", async ({ app, page }) => {
  await app.open();
  await expect(page.getByRole("heading", { level: 2, name: "All articles" })).toBeVisible();
  await expect(app.row(1)).toBeVisible();
  await expect(app.row(2)).toBeVisible();
  // Feed list: always visible on desktop, a sheet on mobile.
  await app.openSidebar();
  await expect(app.sidebar().getByRole("button", { name: /^All articles\s*\d+$/ })).toBeVisible();
  await expect(app.sidebar().getByRole("button", { name: /^Solo Blog\s*\d+$/ })).toBeVisible();
  await expect(app.sidebar().getByRole("button", { name: "Expand Tech" })).toBeVisible();
  await app.closeSidebar();
});

test("selecting a feed narrows the list to that feed and puts it in the URL", async ({ app, page }) => {
  await app.open();
  await openSoloBlog(app, page);
  expect(app.where()).toMatch(/^\/\?feed=[^&]+$/);
  // Article #008 belongs to Solo Blog, #001 (Hacker Dispatch) must be gone.
  await expect(app.row(1)).toHaveCount(0);
  const labels = await app.rowsMatching("—").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
  expect(labels.length).toBeGreaterThan(5);
  for (const l of labels) expect(l.endsWith("— Solo Blog")).toBe(true);
});

test("opening an article shows title and content in the reader; the article is in the URL", async ({ app, page }) => {
  const rsc = trackRsc(page);
  await app.open();
  await app.activate(app.row(1));
  const open = page.locator("article").filter({ hasText: app.user.firstArticleTitle });
  await expect(open).toBeVisible();
  await expect(open.getByRole("heading", { level: 1, name: app.user.firstArticleTitle })).toBeVisible();
  await expect(open).toContainText(app.user.firstArticleBodyStart.slice(0, 25));
  expect(app.where()).toBe(`/?a=${app.articleId(1)}`);
  expect(rsc).toEqual([]); // history API, no server round-trip
});

test("reader renders images and code blocks", async ({ app, page }) => {
  await app.open();
  // The row itself (CSS role): touch rows also hold a screen-reader "Actions: <title>" button.
  const row = app.rowsMatching(app.user.sample.code).first();
  await row.scrollIntoViewIfNeeded();
  await app.activate(row);
  await expect(page.locator("article").filter({ hasText: app.user.sample.code }).locator("pre code")).toBeVisible();
});

test("close reader returns to the list", async ({ app, page }) => {
  await app.open();
  await app.activate(app.row(1));
  await expect(reader(page, 1)).toBeVisible();
  await app.activate(backButton(page));
  await expect(reader(page, 1)).toBeHidden();
  await expect(app.row(2)).toBeVisible();
  expect(app.where()).toBe("/");
});

test("browser/Android back from the reader returns to the list at the same offset, not out of the app (P1-03/P1-04)", async ({ app, page }) => {
  const rsc = trackRsc(page);
  await app.open();
  const scroller = app.listScroller();
  await scroller.evaluate((el) => el.scrollTo({ top: 600, behavior: "instant" }));
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(500);
  const before = await scroller.evaluate((el) => el.scrollTop);
  // A row that is fully visible at this offset.
  const id = await scroller.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll<HTMLElement>("[data-article-id]")].find((r) => r.getBoundingClientRect().top > top + 40);
    return row!.getAttribute("data-article-id")!;
  });
  const lengthBefore = await historyLength(page);
  await app.activate(page.locator(`[data-article-id="${id}"] [role="button"]`).first());
  await expect(page.locator("article h1").first()).toBeVisible();
  expect(app.where()).toBe(`/?a=${id}`);

  await page.goBack();
  await expect.poll(() => app.where()).toBe("/"); // still inside the app, article dropped from the URL
  await expect(page.locator(`[data-pane="reader"] article`)).toHaveCount(0, { timeout: 5000 });
  await expect(page.locator(`[data-article-id="${id}"] [role="button"]`).first()).toBeVisible();
  // List stayed mounted under the reader: exactly where it was (±1 px).
  expect(Math.abs((await scroller.evaluate((el) => el.scrollTop)) - before)).toBeLessThanOrEqual(1);
  expect(await historyLength(page)).toBe(lengthBefore + 1); // one forward entry (the article), nothing else
  expect(rsc).toEqual([]);
});

test("mobile: back goes reader → feed list → Feeds root and never leaves the app while a level is open", async ({ app, page, isMobile }) => {
  test.skip(!isMobile, "compact layout has the Feeds root level");
  await app.open();
  await openSoloBlog(app, page);
  const feedUrl = app.where();
  await app.activate(app.row(8));
  await expect(reader(page, 8)).toBeVisible();
  expect(app.where()).toBe(`${feedUrl}&a=${app.articleId(8)}`);

  await page.goBack(); // reader → feed list
  await expect(reader(page, 8)).toBeHidden();
  await expect.poll(() => app.where()).toBe(feedUrl);
  await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeVisible();

  await page.goBack(); // feed list → Feeds root (sources)
  await expect.poll(() => app.where()).toBe("/?tab=feeds");
  const sources = page.locator('[data-pane="sources"]');
  await expect(sources.getByRole("button", { name: /^Solo Blog\s*\d+$/ })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeHidden();

  // Feeds root → a feed drills down again (push), and back returns.
  await app.activate(sources.getByRole("button", { name: /^Solo Blog\s*\d+$/ }));
  await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeVisible();
  expect(app.where()).toBe(feedUrl);
  await page.goBack();
  await expect.poll(() => app.where()).toBe("/?tab=feeds");
});

test("reload restores selected feed and open article (P1-03)", async ({ app, page }) => {
  await app.open();
  await openSoloBlog(app, page);
  await app.activate(app.row(8));
  await expect(reader(page, 8)).toBeVisible();
  const url = app.where();
  await page.reload();
  expect(app.where()).toBe(url);
  await expect(reader(page, 8)).toBeVisible({ timeout: 30_000 });
  await app.navReady();
  if (!app.isMobile) await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeVisible();
  // Back after the reload still lands on the feed list.
  await page.goBack();
  await expect(reader(page, 8)).toBeHidden();
  await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeVisible();
  await expect(app.row(8)).toBeVisible();
});

test("cold deep link ?a=<id> opens the reader with the list underneath; back stays in the app", async ({ app, page }) => {
  await page.goto(`/?a=${app.articleId(3)}`);
  await expect(reader(page, 3)).toBeVisible({ timeout: 30_000 });
  await app.navReady();
  // The list is mounted under the reader (compact) / beside it (wide).
  await expect(app.row(1)).toHaveCount(1);
  await page.goBack(); // seeded parent entry
  await expect.poll(() => app.where()).toBe("/");
  await expect(reader(page, 3)).toBeHidden();
  await expect(app.row(1)).toBeVisible();
});

test("cold deep link into a feed article: back goes to that feed's list", async ({ app, page }) => {
  await app.open();
  await openSoloBlog(app, page);
  const feedUrl = app.where();
  await page.goto("about:blank");
  await page.goto(`${feedUrl}&a=${app.articleId(8)}`);
  await expect(reader(page, 8)).toBeVisible({ timeout: 30_000 });
  await app.navReady();
  await page.goBack();
  await expect.poll(() => app.where()).toBe(feedUrl);
  await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeVisible();
  if (app.isMobile) {
    await page.goBack();
    await expect.poll(() => app.where()).toBe("/?tab=feeds");
  }
});

// j/k REPLACE the entry (only opening the first article pushes).
test("j/k moves between articles without growing history", async ({ app, page, isMobile }) => {
  test.skip(isMobile, "keyboard shortcut; desktop only");
  await app.open();
  await app.activate(app.row(1));
  await expect(reader(page, 1)).toBeVisible();
  const before = await historyLength(page);
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("j");
    await expect(reader(page, i + 2)).toBeVisible();
  }
  for (let i = 5; i > 0; i--) {
    await page.keyboard.press("k");
    await expect(reader(page, i)).toBeVisible();
  }
  expect(await historyLength(page)).toBe(before);
  expect(app.where()).toBe(`/?a=${app.articleId(1)}`);
  // One back still returns to the list.
  await page.goBack();
  await expect.poll(() => app.where()).toBe("/");
});

test("Esc closes the reader", async ({ app, page, isMobile }) => {
  test.skip(isMobile, "keyboard; desktop only");
  await app.open();
  await app.activate(app.row(2));
  await expect(reader(page, 2)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(reader(page, 2)).toBeHidden();
  expect(app.where()).toBe("/");
});

test.describe("old links keep working (aliases → canonical URL)", () => {
  test("manifest shortcut ?view=readlater → /?v=later", async ({ app, page }) => {
    await page.goto("/?view=readlater");
    await expect(page.getByRole("heading", { level: 2, name: "Read later" })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => app.where()).toBe("/?v=later");
  });

  test("?view=starred and ?view=new", async ({ app, page }) => {
    await page.goto("/?view=starred");
    await expect(page.getByRole("heading", { level: 2, name: "Starred" })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => app.where()).toBe("/?v=starred");
    await page.goto("/?view=new");
    await expect(page.getByRole("heading", { level: 2, name: "All articles" })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => app.where()).toBe("/");
  });

  test("notification link ?article=<id> → /?a=<id>", async ({ app, page }) => {
    await page.goto(`/?article=${app.articleId(4)}`);
    await expect(reader(page, 4)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => app.where()).toBe(`/?a=${app.articleId(4)}`);
  });

  test("?addFeed=1 opens Add Feed once and is stripped", async ({ app, page }) => {
    await page.goto("/?addFeed=1");
    await expect(page.getByRole("dialog", { name: "Add Feed" })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => app.where()).toBe(app.isMobile ? "/?tab=feeds" : "/");
  });

  test("share target ?sharedUrl= still pre-fills Add Feed (and is stripped)", async ({ app, page }) => {
    await page.goto(`/?sharedUrl=${encodeURIComponent("https://example.org/blog")}`);
    const dialog = page.getByRole("dialog", { name: "Add Feed" });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByPlaceholder("Feed or site URL, @handle, or topic")).toHaveValue("https://example.org/blog");
    expect(app.where()).not.toContain("sharedUrl");
  });
});

test("no layout spinner at any time during boot", async ({ app, page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __spinner: boolean }).__spinner = false;
    new MutationObserver(() => {
      if (document.querySelector('[class*="rounded-icon"][class*="animate-spin"]')) (window as unknown as { __spinner: boolean }).__spinner = true;
    }).observe(document, { subtree: true, childList: true, attributes: true });
  });
  await app.open();
  await app.activate(app.row(1));
  await expect(reader(page, 1)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __spinner: boolean }).__spinner)).toBe(false);
});

test("resizing 390 → 1280 without reload keeps the open article and the list", async ({ app, page, isMobile }) => {
  test.skip(isMobile, "desktop project drives the viewport");
  await page.setViewportSize({ width: 390, height: 844 });
  await app.open();
  await app.activate(app.row(2));
  await expect(reader(page, 2)).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(reader(page, 2)).toBeVisible();
  await expect(app.row(1)).toBeVisible();
  expect(app.where()).toBe(`/?a=${app.articleId(2)}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(reader(page, 2)).toBeVisible();
});

test("portrait tablet 820x1180: the reader pushes over the list at a readable measure; rail stays, feeds in a drawer", async ({ app, page, isMobile }) => {
  test.skip(isMobile, "desktop project drives the viewport");
  await page.setViewportSize({ width: 820, height: 1180 });
  await app.open();
  const rail = page.getByTestId("shell-rail");
  await expect(rail).toBeVisible();
  await expect(page.getByTestId("tab-bar")).toBeHidden();
  const railBox = (await rail.boundingBox())!;
  const listRow = (await app.row(2).boundingBox())!;
  // No reader column while nothing is open: the list owns the content column.
  expect(railBox.x + railBox.width).toBeLessThanOrEqual(listRow.x + 1);
  expect(listRow.x + listRow.width).toBeGreaterThan(780);

  await app.activate(app.row(1));
  await expect(reader(page, 1)).toBeVisible();
  // Reader layer covers the list column (not a cramped third pane), rail stays visible.
  const article = (await reader(page, 1).boundingBox())!;
  expect(article.x).toBeGreaterThanOrEqual(railBox.x + railBox.width - 1);
  const body = (await page.locator('[data-pane="reader"] .article-content').first().boundingBox())!;
  expect(body.width).toBeGreaterThanOrEqual(480);
  await expect(rail).toBeVisible();
  // The covered list leaves the a11y tree; Back pops the reader and keeps the list.
  await expect(page.locator('[data-pane="list-new"]')).toHaveAttribute("inert", "");
  await page.goBack();
  await expect(app.row(1)).toBeVisible();
  await expect(page.locator('[data-pane="list-new"]')).not.toHaveAttribute("inert", "");

  // The rail is the navigation; its Feeds tab (no feed yet) opens the tree as a drawer.
  await rail.getByRole("tab", { name: "Feeds" }).click();
  await expect(page.getByRole("dialog", { name: /feed navigation/i })).toBeVisible();
  await page.getByRole("dialog", { name: /feed navigation/i }).getByRole("button", { name: /^Solo Blog\s*\d+$/ }).click();
  await expect(page.getByRole("dialog", { name: /feed navigation/i })).toBeHidden();
  await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeVisible();
  await expect(rail.getByRole("tab", { name: "Feeds" })).toHaveAttribute("aria-selected", "true");
});

test("landscape tablet 1180x820: rail + list + reader side by side", async ({ app, page, isMobile }) => {
  test.skip(isMobile, "desktop project drives the viewport");
  await page.setViewportSize({ width: 1180, height: 820 });
  await app.open();
  await app.activate(app.row(1));
  await expect(reader(page, 1)).toBeVisible();
  const list = (await app.row(2).boundingBox())!;
  const article = (await reader(page, 1).boundingBox())!;
  expect(list.x + list.width).toBeLessThanOrEqual(article.x + 1);
  await expect(page.locator('[data-pane="list-new"]')).not.toHaveAttribute("inert", "");
});
