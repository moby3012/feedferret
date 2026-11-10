import type { Page } from "@playwright/test";
import { test, expect, type App } from "../helpers/test";
import { insertArrivals, setCountDisplay } from "../helpers/db";
import { touchDrag } from "../helpers/gestures";

/**
 * PR 9 — "↑ N neu" + anti-anxiety (spec §4.8 / §4.9, research-reeder 2/3/5).
 * New rows never enter the list under the finger: the head probe counts them
 * (after each counts poll), the pill shows the number, a tap inserts them on
 * top and scrolls up. Idle at the very top they enter without a pill.
 * Unread numbers are muted, capped at 99+, and follow "Show counts".
 */

const HEAD_URL = /\/api\/app\/articles\/head\?/;
/** The Neu list itself (idle prefetches of other lists, e.g. `v=later`, do not count). */
const LIST_URL = /\/api\/app\/articles\?show=unread&sort=new/;
/** One counts poll interval (COUNTS_POLL_MS = 120 s) and a bit. */
const POLL = 125_000;

function track(page: Page, url: RegExp) {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (url.test(r.url())) seen.push(r.url());
  });
  return seen;
}

/** Scrolls the list well past the top (loads enough rows first) and lets it settle. */
async function scrollDown(app: App, page: Page, y = 1500) {
  const scroller = app.listScroller();
  await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(y);
  await scroller.evaluate((el, to) => el.scrollTo(0, to), y);
  await expect.poll(() => scroller.evaluate((el) => Math.round(el.scrollTop))).toBe(y);
  await page.waitForTimeout(250);
}

test.describe("↑ N neu", () => {
  test("arrivals while scrolled down: pill, nothing moves; a tap inserts them on top and scrolls up", async ({ app, page }) => {
    await page.clock.install();
    await app.open();
    await scrollDown(app, page);
    const scroller = app.listScroller();
    const anchor = await app.firstVisibleRow();
    const rowCount = await app.rows().count();
    const heads = track(page, HEAD_URL);
    const lists = track(page, LIST_URL);

    const arrivals = insertArrivals(app.userKey, 3, "scrolled");
    try {
      // The next counts poll carries the head probe.
      await page.clock.fastForward(POLL);
      await expect(app.newItemsPill()).toBeVisible({ timeout: 15_000 });
      await expect(app.newItemsPill()).toHaveText("3 new");
      expect(heads.length).toBe(1);
      expect(lists).toEqual([]);

      // Nothing moved: same first visible row at the same y, same offset, same DOM.
      const now = await app.firstVisibleRow();
      expect(now.id).toBe(anchor.id);
      expect(Math.abs(now.top - anchor.top)).toBeLessThanOrEqual(1);
      expect(Math.round(await scroller.evaluate((el) => el.scrollTop))).toBe(1500);
      await expect(app.rows()).toHaveCount(rowCount);
      for (const id of arrivals.ids) await expect(page.locator(`[data-article-id="${id}"]`)).toHaveCount(0);

      await app.activate(app.newItemsPill());
      for (const id of arrivals.ids) await expect(page.locator(`[data-article-id="${id}"]`)).toHaveCount(1);
      await expect.poll(() => scroller.evaluate((el) => el.scrollTop), { timeout: 10_000 }).toBe(0);
      // Newest first, on top; the pill is gone.
      expect((await app.firstVisibleRow()).id).toBe(arrivals.ids[2]);
      await expect(app.newItemsPill()).toBeHidden();
    } finally {
      arrivals.cleanup();
    }
  });

  test("idle at the very top: arrivals enter without a pill", async ({ app, page }) => {
    await page.clock.install();
    await app.open();
    const scroller = app.listScroller();
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0);
    const arrivals = insertArrivals(app.userKey, 2, "top");
    try {
      await page.clock.fastForward(POLL);
      for (const id of arrivals.ids) await expect(page.locator(`[data-article-id="${id}"]`)).toHaveCount(1, { timeout: 15_000 });
      await expect(app.newItemsPill()).toBeHidden();
      expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0);
    } finally {
      arrivals.cleanup();
    }
  });

  test("offline pauses the probe; back online it resumes", async ({ app, page, context }) => {
    await page.clock.install();
    await app.open();
    await scrollDown(app, page);
    const heads = track(page, HEAD_URL);
    const arrivals = insertArrivals(app.userKey, 2, "offline");
    try {
      await context.setOffline(true);
      await page.clock.fastForward(POLL);
      await page.waitForTimeout(1000);
      expect(heads).toEqual([]);
      await expect(app.newItemsPill()).toBeHidden();

      await context.setOffline(false);
      // Reconnect refetches the (stale) counts, and the probe follows.
      await expect(app.newItemsPill()).toBeVisible({ timeout: 15_000 });
      await expect(app.newItemsPill()).toHaveText("2 new");
      expect(heads.length).toBe(1);
    } finally {
      await context.setOffline(false);
      arrivals.cleanup();
    }
  });

  test("an explicit refresh while scrolled down buffers too", async ({ app, page, isMobile }) => {
    test.skip(isMobile, "keyboard refresh is the desktop path; mobile pulls (next test)");
    await app.open();
    await scrollDown(app, page);
    const anchor = await app.firstVisibleRow();
    const lists = track(page, LIST_URL);
    const arrivals = insertArrivals(app.userKey, 2, "refresh");
    try {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("r");
      await expect(app.newItemsPill()).toBeVisible({ timeout: 30_000 });
      await expect(app.newItemsPill()).toHaveText("2 new");
      const now = await app.firstVisibleRow();
      expect(now.id).toBe(anchor.id);
      expect(Math.abs(now.top - anchor.top)).toBeLessThanOrEqual(1);
      expect(lists).toEqual([]);
    } finally {
      arrivals.cleanup();
    }
  });

  test("pull-to-refresh that ends after the user scrolled away buffers instead of jumping", async ({ app, page, isMobile }) => {
    test.skip(!isMobile, "pull-to-refresh is a touch gesture");
    await app.open();
    const scroller = app.listScroller();
    // Hold the refresh (server action POST) until the user has scrolled down.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let refreshSeen = false;
    await page.route("**/*", async (route) => {
      const req = route.request();
      if (req.method() === "POST" && req.headers()["next-action"] && !refreshSeen) {
        refreshSeen = true;
        await held;
      }
      await route.continue();
    });
    const arrivals = insertArrivals(app.userKey, 2, "pull");
    try {
      const box = (await scroller.boundingBox())!;
      await touchDrag(page, { x: box.x + box.width / 2, y: box.y + 40 }, 0, 320, { steps: 14, stepMs: 16 });
      await expect.poll(() => refreshSeen, { timeout: 10_000 }).toBe(true);
      await scrollDown(app, page);
      // The pull's spring back has settled.
      await expect(scroller).not.toHaveAttribute("data-pull", /.*/);
      const anchor = await app.firstVisibleRow();
      const lists = track(page, LIST_URL);
      release();

      await expect(app.newItemsPill()).toBeVisible({ timeout: 30_000 });
      await expect(app.newItemsPill()).toHaveText("2 new");
      const now = await app.firstVisibleRow();
      expect(now.id).toBe(anchor.id);
      expect(Math.abs(now.top - anchor.top)).toBeLessThanOrEqual(1);
      expect(lists).toEqual([]);
    } finally {
      release?.();
      await page.unroute("**/*");
      arrivals.cleanup();
    }
  });
});

test.describe("calm unread counts", () => {
  test("counts are muted text capped at 99+, never a filled or red badge", async ({ app, page }) => {
    await app.open();
    await app.openSidebar();
    const all = app.sidebar().getByRole("button", { name: /^All articles/ }).first();
    const count = all.locator("[data-unread-count]");
    await expect(count).toBeVisible();
    const exact = Number(await count.getAttribute("data-unread-count"));
    expect(exact).toBeGreaterThan(99);
    // Visible "99+"; assistive tech gets the exact number.
    await expect(count.locator("[data-unread-label]")).toHaveText("99+");
    await expect(count.locator("[data-unread-label]")).toBeVisible();
    // The top bar of the Neu list reads the same capped number.
    await app.closeSidebar();
    await expect(app.listCount()).toHaveText("99+");

    // Every unread number in the sources: no background fill, no red.
    await app.openSidebar();
    const styles = await app.sidebar().locator("[data-unread-count]").evaluateAll((els) =>
      els.map((el) => {
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, color: cs.color };
      }),
    );
    expect(styles.length).toBeGreaterThan(1);
    for (const s of styles) {
      expect(s.bg).toBe("rgba(0, 0, 0, 0)");
      const m = s.color.match(/\d+(\.\d+)?/g)!.map(Number);
      // Not red-dominant (muted grey text).
      expect(m[0] - Math.max(m[1], m[2])).toBeLessThan(40);
    }
  });

  test("'Show counts': All · Categories only · Off", async ({ app, page }) => {
    const feedName = app.user.firstArticleFeed;
    const expandTech = () => app.sidebar().getByRole("button", { name: "Expand Tech" });
    const techCount = () => expandTech().locator("xpath=..").locator("[data-unread-count]");
    const feedButton = () => app.sidebar().getByRole("button", { name: new RegExp(`^${feedName}`) }).first();

    setCountDisplay(app.userKey, "categories");
    await app.open();
    await app.openSidebar();
    await expect(app.sidebar().getByRole("button", { name: /^All articles/ }).first().locator("[data-unread-count]")).toBeVisible();
    await expect(techCount()).toBeVisible();
    await expandTech().click();
    await expect(feedButton()).toBeVisible();
    await expect(feedButton().locator("[data-unread-count]")).toHaveCount(0);
    await app.closeSidebar();
    await expect(app.listCount()).toBeVisible();

    setCountDisplay(app.userKey, "off");
    await app.open();
    await app.openSidebar();
    await expect(expandTech()).toBeVisible();
    await expect(app.sidebar().locator("[data-unread-count]")).toHaveCount(0);
    await app.closeSidebar();
    await expect(app.listCount()).toHaveCount(0);
    // Unread stays visible as the brand dot on rows / the Neu tab.
    if (app.isMobile) await expect(page.getByTestId("tab-unread-dot")).toBeVisible();

    // The setting itself (Settings → Show counts) writes it back.
    await page.goto("/settings");
    if (app.isMobile) {
      // Compact settings: the section tabs are a select.
      await page.getByRole("combobox").first().tap();
      await page.getByRole("option", { name: "Reading" }).tap();
    } else {
      await page.getByRole("tab", { name: "Reading" }).click();
    }
    const select = page.getByTestId("count-display-select");
    await select.scrollIntoViewIfNeeded();
    await app.activate(select);
    await app.activate(page.getByRole("option", { name: "All", exact: true }));
    await expect(select).toHaveText("All");
    await app.open();
    await app.openSidebar();
    await expandTech().click();
    await expect(feedButton().locator("[data-unread-count]")).toBeVisible();
  });
});
