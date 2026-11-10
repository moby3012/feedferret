import { test, expect, ACTIVE_LIST } from "../helpers/test";

const ACTIVE_LIST_SCROLLER = `${ACTIVE_LIST} [data-testid="list-scroller"]`;
import type { Page } from "@playwright/test";
import {
  articleFlags,
  makeSpoilers,
  markEverythingUnread,
  setUserSettings,
  unreadCountForFeed,
  unreadCountInDb,
  unreadIds,
  unreadIdsMatching,
  userSettings,
} from "../helpers/db";
import { swipeAt, swipeOn, touchSwipeOn } from "../helpers/gestures";

/**
 * "No accidental mark-all-read" (UX audit P1-01 / P1-02). Owner decisions:
 *  - no gesture / overscroll ever marks more than one article read,
 *  - every bulk mark-read shows a 6 s Undo toast and stays on the current view,
 *  - the end-of-list card is the only bulk way out of a feed,
 *  - optional setting "Mark as read when moving on" (default off) makes the
 *    card's "Continue to …" button also mark the current view read.
 * Seed: Solo Blog is the last feed (next with unread wraps to Hacker Dispatch).
 */

const listRegion = (page: Page) => page.getByRole("region", { name: "Article list" });
const endCard = (page: Page) => page.getByTestId("end-of-list-card");
const toast = (page: Page) => page.locator("[data-sonner-toast]").filter({ hasText: /Marked \d+ articles? as read/ });

async function scrollListToEnd(page: Page) {
  const viewport = page.locator(ACTIVE_LIST_SCROLLER);
  await expect
    .poll(
      async () => {
        await viewport.evaluate((el) => el.scrollTo(0, el.scrollHeight));
        return endCard(page).count();
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  await endCard(page).scrollIntoViewIfNeeded();
}

async function openSoloBlog(app: import("../helpers/test").App, page: Page) {
  await app.open();
  await app.selectSidebar(/^Solo Blog\s*\d+$/);
  await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeVisible();
  await expect(app.row(8)).toBeVisible();
}

test.describe("no gesture or scroll marks anything read in bulk", () => {
  test("wheel overscroll past the end and top of a feed does nothing", async ({ app, page }) => {
    test.skip(app.isMobile, "wheel overscroll is a desktop input");
    await openSoloBlog(app, page);
    const before = unreadCountInDb(app.userKey);
    const viewport = page.locator(ACTIVE_LIST_SCROLLER);
    await viewport.hover();
    await viewport.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    // Far more than the old 500-delta threshold, repeatedly, past the cooldown.
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(250);
    }
    await viewport.evaluate((el) => el.scrollTo(0, 0));
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, -600);
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(1500);
    await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeVisible();
    expect(unreadCountInDb(app.userKey)).toBe(before);
    await expect(toast(page)).toHaveCount(0);
  });

  test("horizontal swipes on the list background and on the header title never switch feed or mark read", async ({ app, page }) => {
    await openSoloBlog(app, page);
    const before = unreadCountInDb(app.userKey);
    const region = await listRegion(page).boundingBox();
    if (!region) throw new Error("no list region");
    const heading = page.getByRole("heading", { level: 2, name: "Solo Blog" });

    for (const dx of [-220, 220]) {
      // Left padding of the list = background between/beside rows.
      await swipeAt(page, { x: region.x + 4, y: region.y + region.height / 2 }, dx);
      await swipeOn(page, heading, dx);
    }
    await page.waitForTimeout(800);
    await expect(heading).toBeVisible();
    expect(unreadCountInDb(app.userKey)).toBe(before);
    await expect(toast(page)).toHaveCount(0);
  });

  test("a swipe on a row only toggles that one article (and does not also switch feeds)", async ({ app, page }) => {
    await openSoloBlog(app, page);
    const before = unreadCountInDb(app.userKey);
    const row = app.row(8);
    await expect(row).toBeVisible();
    await touchSwipeOn(page, row, 220, { offsetX: 60 });
    await expect.poll(() => articleFlags(app.articleId(8)).isRead).toBe(true);
    await page.waitForTimeout(800);
    expect(unreadCountInDb(app.userKey)).toBe(before - 1);
    await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeVisible();
  });
});

test.describe("explicit mark-all + undo", () => {
  test("header mark-all stays on the view, shows Undo, and undo restores exactly the changed articles", async ({ app, page }) => {
    await openSoloBlog(app, page);
    const unreadBefore = unreadIds(app.userKey);
    const soloBefore = unreadCountForFeed(app.userKey, "Solo Blog");
    expect(soloBefore).toBeGreaterThan(5);
    // Pre-existing read article in the same feed must stay read after undo.
    await app.markAllRead();

    await expect.poll(() => unreadCountForFeed(app.userKey, "Solo Blog")).toBe(0);
    // Other feeds untouched, still on the same view (no auto-jump).
    expect(unreadCountInDb(app.userKey)).toBe(unreadBefore.length - soloBefore);
    await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeVisible();
    await expect(toast(page)).toBeVisible();
    await expect(toast(page)).toContainText(String(soloBefore));

    await app.activate(toast(page).getByRole("button", { name: "Undo" }));
    await expect.poll(() => unreadIds(app.userKey), { timeout: 15_000 }).toEqual(unreadBefore);
    await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeVisible();
  });

  test("the Undo toast stays for ~6 seconds", async ({ app, page }) => {
    await openSoloBlog(app, page);
    await app.markAllRead();
    // Desktop: sonner pauses its timer while the mouse hovers the toast area,
    // so park the mouse elsewhere. (Touch needs no such help — see the tap-only test.)
    if (!app.isMobile) await page.mouse.move(1, 1);
    await expect(toast(page)).toBeVisible();
    await page.waitForTimeout(4500);
    await expect(toast(page)).toBeVisible();
    await expect(toast(page)).toBeHidden({ timeout: 6000 });
  });

  test("on touch, the Undo toast also expires by itself after a tap-only interaction (no mouse moves)", async ({ app, page }) => {
    test.skip(!app.isMobile, "tap-only behaviour");
    await openSoloBlog(app, page);
    // Tap (synthesised mouse events included) — and never touch the mouse again.
    await app.markAllRead();
    await expect(toast(page)).toBeVisible();
    await page.waitForTimeout(4500);
    await expect(toast(page)).toBeVisible();
    await expect(toast(page)).toBeHidden({ timeout: 6000 });
  });

  test("list header unread count is the server count and matches the sidebar (more than the 200-row list cap)", async ({ app, page }) => {
    markEverythingUnread(app.userKey);
    await app.open();
    const sidebar = await app.sidebarCount("All articles");
    expect(sidebar).toBe(app.user.counts.total); // 300 > 200 loaded rows
    // The bar shows a muted, capped count ("99+"); the exact server count is its data / tooltip.
    const count = page.locator(`${ACTIVE_LIST} [data-testid="list-count"]`);
    await expect(count).toHaveAttribute("data-count", String(sidebar));
    await expect(count).toHaveText(sidebar > 99 ? "99+" : String(sidebar));
    await expect(count).toHaveAttribute("title", `${sidebar} unread`);
  });
});


test.describe("every bulk mark-read path is undoable and scoped to the visible view", () => {
  test("sidebar feed menu 'Mark all as read' shows the Undo toast and undo restores exactly that feed", async ({ app, page }) => {
    await app.open();
    const before = unreadIds(app.userKey);
    const solo = unreadCountForFeed(app.userKey, "Solo Blog");
    await app.openSidebar();
    const feedButton = app.sidebar().getByRole("button", { name: /^Solo Blog\s*\d+$/ }).first();
    const row = feedButton.locator('xpath=ancestor::div[contains(@class,"group/row")][1]');
    await row.hover();
    await app.activate(row.getByRole("button", { name: "Feed actions" }));
    await app.activate(page.getByRole("menuitem", { name: "Mark all as read" }));

    await expect.poll(() => unreadCountForFeed(app.userKey, "Solo Blog")).toBe(0);
    expect(unreadCountInDb(app.userKey)).toBe(before.length - solo);
    await expect(page.getByRole("menu")).toBeHidden();
    await app.closeSidebar();
    await expect(toast(page)).toBeVisible();
    await expect(toast(page)).toContainText(String(solo));

    await app.activate(toast(page).getByRole("button", { name: "Undo" }));
    await expect.poll(() => unreadIds(app.userKey), { timeout: 15_000 }).toEqual(before);
  });

  test("mark-all during an active search only marks the matching articles", async ({ app, page }) => {
    await app.open();
    const needle = app.user.sample.needle;
    const before = unreadIds(app.userKey);
    const matching = unreadIdsMatching(app.userKey, needle);
    expect(matching.length).toBeGreaterThan(0);
    expect(before.length).toBeGreaterThan(matching.length);

    await app.openSearch();
    await page.keyboard.type(needle);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 2, name: new RegExp(needle) })).toBeVisible();
    await expect(app.rowsMatching(needle)).toHaveCount(app.user.sample.needleHits);

    // Search view: desktop has the Shift+A shortcut, mobile the top bar's "…" menu.
    if (app.isMobile) await app.markAllRead();
    else await page.keyboard.press("Shift+A");
    await expect(toast(page)).toBeVisible();
    await expect.poll(() => unreadIdsMatching(app.userKey, needle)).toEqual([]);
    expect(unreadIds(app.userKey)).toEqual(before.filter((id) => !matching.includes(id)));

    await app.activate(toast(page).getByRole("button", { name: "Undo" }));
    await expect.poll(() => unreadIds(app.userKey), { timeout: 15_000 }).toEqual(before);
  });

  test("read-only 'Spoiler' view has no mark-all controls and a bulk shortcut changes nothing", async ({ app, page }) => {
    makeSpoilers(app.userKey, 3);
    await app.open();
    const before = unreadIds(app.userKey);
    await app.selectSidebar(/^Spoiler\s*\d*$/);
    await expect(page.getByRole("heading", { level: 2, name: "Spoiler" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark all as read" })).toHaveCount(0);
    if (!app.isMobile) {
      await page.keyboard.press("Shift+A");
      await page.waitForTimeout(800);
      expect(unreadIds(app.userKey)).toEqual(before);
      await expect(toast(page)).toHaveCount(0);
    }
    await expect(endCard(page).getByRole("button", { name: "Mark all as read" })).toHaveCount(0);
  });

  test("mark-all reconciles an article toggled earlier in the session, and undo restores it", async ({ app, page }) => {
    await openSoloBlog(app, page);
    const id = app.articleId(8);
    // read -> unread again leaves a stale "unread" session snapshot behind.
    await app.activate(app.rowActions(8).read);
    await expect.poll(() => articleFlags(id).isRead).toBe(true);
    await app.activate(app.rowActions(8).read);
    await expect.poll(() => articleFlags(id).isRead).toBe(false);
    await expect(app.row(8)).toHaveAttribute("aria-label", /^Unread:/);

    await app.markAllRead();
    await expect.poll(() => articleFlags(id).isRead).toBe(true);
    // Default list is "unread only": the now-read article must be gone, not
    // lingering as a stale "unread" session copy.
    await expect(app.row(8)).toHaveCount(0);

    await app.activate(toast(page).getByRole("button", { name: "Undo" }));
    await expect.poll(() => articleFlags(id).isRead, { timeout: 15_000 }).toBe(false);
    await expect(app.row(8)).toHaveAttribute("aria-label", /^Unread:/);
  });
});

test.describe("end-of-list card", () => {
  for (const mode of ["list", "magazine", "minimal"] as const) {
    test(`is shown after the last row in ${mode} view`, async ({ app, page }) => {
      setUserSettings(app.userKey, { defaultViewMode: mode });
      await openSoloBlog(app, page);
      await scrollListToEnd(page);
      await expect(endCard(page)).toContainText("End of list");
      await expect(endCard(page).getByRole("button", { name: "Mark all as read" })).toBeVisible();
      await expect(endCard(page).getByRole("button", { name: "Continue to Hacker Dispatch" })).toBeVisible();
    });
  }

  test("'Continue to …' moves on to the next feed with unread and marks nothing (setting off)", async ({ app, page }) => {
    await openSoloBlog(app, page);
    const before = unreadIds(app.userKey);
    await scrollListToEnd(page);
    await expect(endCard(page).getByText(/read/i).and(page.getByText(/continue marks/i))).toHaveCount(0);
    await app.activate(endCard(page).getByRole("button", { name: "Continue to Hacker Dispatch" }));
    await expect(page.getByRole("heading", { level: 2, name: "Hacker Dispatch" })).toBeVisible();
    await page.waitForTimeout(800);
    expect(unreadIds(app.userKey)).toEqual(before);
    await expect(toast(page)).toHaveCount(0);
  });

  test("'Mark all as read' on the card stays on the feed, becomes 'caught up', and Undo brings it back", async ({ app, page }) => {
    await openSoloBlog(app, page);
    const before = unreadIds(app.userKey);
    const solo = unreadCountForFeed(app.userKey, "Solo Blog");
    await scrollListToEnd(page);
    await app.activate(endCard(page).getByRole("button", { name: "Mark all as read" }));

    await expect.poll(() => unreadCountForFeed(app.userKey, "Solo Blog")).toBe(0);
    expect(unreadCountInDb(app.userKey)).toBe(before.length - solo);
    await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeVisible();
    await expect(endCard(page)).toContainText("You're all caught up");
    await expect(endCard(page).getByRole("button", { name: "Mark all as read" })).toHaveCount(0);
    await expect(endCard(page).getByRole("button", { name: "Continue to Hacker Dispatch" })).toBeVisible();

    await app.activate(toast(page).getByRole("button", { name: "Undo" }));
    await expect.poll(() => unreadIds(app.userKey), { timeout: 15_000 }).toEqual(before);
    await expect(app.row(8)).toBeVisible();
  });
});

test.describe("setting: mark as read when moving on", () => {
  test("can be toggled in Settings → Reading and is persisted (default off)", async ({ app, page }) => {
    expect(userSettings(app.userKey).markReadOnAdvance).toBe(false);
    await app.open();
    await page.goto("/settings");
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible({ timeout: 20_000 });
    if (app.isMobile) {
      await page.getByRole("combobox").first().tap();
      await page.getByRole("option", { name: "Reading" }).tap();
    } else {
      await page.getByRole("tab", { name: "Reading" }).click();
    }
    const toggle = page.getByRole("switch", { name: "Mark as read when moving on" });
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await app.activate(toggle);
    await expect.poll(() => userSettings(app.userKey).markReadOnAdvance).toBe(true);
    await app.activate(toggle);
    await expect.poll(() => userSettings(app.userKey).markReadOnAdvance).toBe(false);
  });

  test("ON: 'Continue to …' also marks the current view read, with Undo", async ({ app, page }) => {
    setUserSettings(app.userKey, { markReadOnAdvance: true });
    await openSoloBlog(app, page);
    const before = unreadIds(app.userKey);
    const solo = unreadCountForFeed(app.userKey, "Solo Blog");
    await scrollListToEnd(page);
    await expect(endCard(page)).toContainText("also marks the current list as read");
    await app.activate(endCard(page).getByRole("button", { name: "Continue to Hacker Dispatch" }));

    await expect(page.getByRole("heading", { level: 2, name: "Hacker Dispatch" })).toBeVisible();
    await expect.poll(() => unreadCountForFeed(app.userKey, "Solo Blog")).toBe(0);
    expect(unreadCountInDb(app.userKey)).toBe(before.length - solo);
    await expect(toast(page)).toBeVisible();

    await app.activate(toast(page).getByRole("button", { name: "Undo" }));
    await expect.poll(() => unreadIds(app.userKey), { timeout: 15_000 }).toEqual(before);
  });
});

test.describe("reader gestures (P1-02)", () => {
  async function stubWindowOpen(page: Page) {
    await page.evaluate(() => {
      (window as unknown as { __opened: unknown[] }).__opened = [];
      window.open = ((...args: unknown[]) => {
        (window as unknown as { __opened: unknown[] }).__opened.push(args);
        return null;
      }) as typeof window.open;
    });
  }
  const opened = (page: Page) => page.evaluate(() => (window as unknown as { __opened: unknown[] }).__opened.length);

  test("a left swipe in the reader does nothing (never opens the original)", async ({ app, page }) => {
    await app.open();
    await app.activate(app.row(1));
    const article = page.locator("article").filter({ hasText: app.user.firstArticleTitle });
    await expect(article).toBeVisible();
    await stubWindowOpen(page);
    await page.waitForTimeout(600); // mobile reader slide-in animation (280 ms)
    const para = article.locator("p").first();
    await swipeOn(page, para, -240);
    await page.waitForTimeout(500);
    expect(await opened(page)).toBe(0);
    await expect(article).toBeVisible();
  });

  // Reader chrome v2 (spec §4.7): the reader has no horizontal app gestures at
  // all — back is the chevron, Esc and the system back gesture.
  test("panning a code block never navigates, and neither does the same swipe on plain text", async ({ app, page }) => {
    await app.open();
    await page
      .getByRole("button", { name: new RegExp(app.user.sample.code.replace(/[()#]/g, "\\$&")) })
      .first()
      .scrollIntoViewIfNeeded();
    await app.activate(page.getByRole("button", { name: new RegExp(app.user.sample.code.replace(/[()#]/g, "\\$&")) }).first());
    const article = page.locator("article").filter({ hasText: app.user.sample.code });
    await expect(article.locator("pre code")).toBeVisible();

    const pre = article.locator("pre").first();
    await pre.scrollIntoViewIfNeeded();
    await swipeOn(page, pre, 240);
    await swipeOn(page, pre, -240);
    await page.waitForTimeout(600);
    await expect(article).toBeVisible(); // reader still open

    const para = article.locator("p").first();
    await para.scrollIntoViewIfNeeded();
    await swipeOn(page, para, 240);
    await page.waitForTimeout(600);
    await expect(article).toBeVisible();
  });

  test("clicking the headline does not open the original", async ({ app, page }) => {
    await app.open();
    await app.activate(app.row(1));
    const heading = page.getByRole("heading", { level: 1, name: app.user.firstArticleTitle });
    await expect(heading).toBeVisible();
    await stubWindowOpen(page);
    await app.activate(heading);
    await page.waitForTimeout(300);
    expect(await opened(page)).toBe(0);
    // The explicit button still works.
    await expect(heading).toBeVisible();
  });
});

test("sign-out asks for confirmation first", async ({ app, page }) => {
  await app.open();
  await app.openSidebar();
  await app.activate(page.getByRole("button", { name: "Sign out" }).first());
  const dialog = page.getByRole("alertdialog", { name: "Sign out?" });
  await expect(dialog).toBeVisible();
  await app.activate(dialog.getByRole("button", { name: "Cancel" }));
  await expect(dialog).toBeHidden();
  // Still where it was (mobile: the Feeds tab hosts the sign-out button).
  await expect(page).toHaveURL(app.isMobile ? /\/\?tab=feeds$/ : /\/$/);
  await expect(page.getByRole("button", { name: "Sign out" }).first()).toBeVisible(); // still signed in
});
