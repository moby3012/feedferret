import { test, expect } from "../helpers/test";
import type { Page } from "@playwright/test";
import {
  articleFlags,
  markEverythingUnread,
  setUserSettings,
  unreadCountForFeed,
  unreadCountInDb,
  unreadIds,
  userSettings,
} from "../helpers/db";
import { swipeAt, swipeOn } from "../helpers/gestures";

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
  const viewport = listRegion(page).locator('[data-slot="scroll-area-viewport"]').first();
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
    const viewport = listRegion(page).locator('[data-slot="scroll-area-viewport"]').first();
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
    await swipeOn(page, row, 160, 0, { x: 60 });
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
    await app.activate(page.getByRole("button", { name: "Mark all as read" }).first());

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
    await app.activate(page.getByRole("button", { name: "Mark all as read" }).first());
    // Sonner pauses its timer while the pointer hovers the toast area; the
    // emulated pointer of a tap can linger there, so park it elsewhere.
    await page.mouse.move(1, 1);
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
    const header = page.locator("header").filter({ has: page.getByRole("heading", { level: 2, name: "All articles" }) });
    await expect(header.getByText(/^\d+\s+unread$/)).toHaveText(`${sidebar} unread`);
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

  test("panning a code block never navigates; the same swipe on plain text still goes back", async ({ app, page }) => {
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

    // Control: a right swipe on ordinary article text is still "back".
    const para = article.locator("p").first();
    await para.scrollIntoViewIfNeeded();
    await swipeOn(page, para, 240);
    await expect(article).toBeHidden({ timeout: 5000 });
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
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: "Sign out" }).first()).toBeVisible(); // still signed in
});
