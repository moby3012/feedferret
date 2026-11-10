import type { Page, Route } from "@playwright/test";
import { test, expect, ACTIVE_LIST } from "../helpers/test";
import { articleFlags, clearSaved, createEmptyUser, manifest, resetArticleState, unreadCountInDb } from "../helpers/db";
import { touchSwipeOn } from "../helpers/gestures";

/**
 * UX wave 1 (audit-ux-2 R1/R2/R4/R6/R8/R9/R10, owner decisions 2026-11-10):
 * true error / empty states, shortcuts suspended under overlays, the compact
 * offline chip, one Back behaviour for every "…", the Feed-Zustand link,
 * no window-controls-overlay, the app-badge switch, and touch rows without
 * buttons whose gestures are discoverable (one-time hint, settings help, a
 * screen-reader "Actions" button).
 */

const isListRequest = (url: URL) => url.pathname === "/api/app/articles";
const isDetailRequest = (url: URL) => url.pathname.startsWith("/api/app/articles/") && !url.pathname.endsWith("/head");

async function failRequests(page: Page, match: (url: URL) => boolean) {
  const handler = (route: Route) => (match(new URL(route.request().url())) ? route.abort("failed") : route.continue());
  await page.route("**/api/app/articles**", handler);
  return () => page.unroute("**/api/app/articles**", handler);
}

test.describe("error and empty states", () => {
  test("a failed list load shows an error with retry — never the end card; retry recovers", async ({ app, page }) => {
    await app.open();
    const restore = await failRequests(page, isListRequest);
    await app.selectSidebar(/^Solo Blog\s*\d+$/);
    const error = page.locator(ACTIVE_LIST).getByTestId("list-error");
    await expect(error).toBeVisible({ timeout: 20_000 });
    await expect(error).toContainText("Couldn't load this list");
    await expect(page.locator(ACTIVE_LIST).getByTestId("end-of-list-card")).toHaveCount(0);
    await expect(page.locator(ACTIVE_LIST).getByText("You're all caught up")).toHaveCount(0);
    await restore();
    await app.activate(error.getByRole("button", { name: "Try again" }));
    await expect(app.rows().first()).toBeVisible({ timeout: 15_000 });
    await expect(error).toHaveCount(0);
  });

  test("a failed article body shows an inline error with retry, not 'No content'", async ({ app, page }) => {
    await app.open();
    const restore = await failRequests(page, isDetailRequest);
    await app.activate(app.row(5));
    const reader = page.locator('[data-pane="reader"]');
    await expect(reader.locator("article h1")).toContainText("(#005)");
    const error = reader.getByTestId("reader-body-error");
    await expect(error).toBeVisible({ timeout: 20_000 });
    await expect(error).toContainText("Couldn't load this article");
    await expect(reader.getByText("No content", { exact: true })).toHaveCount(0);
    await restore();
    await app.activate(error.getByRole("button", { name: "Try again" }));
    await expect(reader.locator(".article-content").first()).toBeVisible({ timeout: 15_000 });
    await expect(error).toHaveCount(0);
  });

  test("offline, a list that is not stored says so instead of 'caught up'", async ({ app, page, context }) => {
    await app.open();
    // The Feeds screen's chunk loads online first (the SW, which would cache it, is blocked in tests).
    await app.openSidebar();
    await app.closeSidebar();
    await context.setOffline(true);
    try {
      await app.selectSidebar(/^Solo Blog\s*\d+$/);
      const state = page.locator(ACTIVE_LIST).getByTestId("list-error");
      await expect(state).toBeVisible({ timeout: 20_000 });
      await expect(state).toContainText("Not available offline");
      await expect(page.locator(ACTIVE_LIST).getByTestId("end-of-list-card")).toHaveCount(0);
      await expect(state.getByRole("button", { name: "Try again" })).toBeVisible();
      // Back online: the list recovers (by itself, or with "Try again").
      await context.setOffline(false);
      const retry = page.locator(ACTIVE_LIST).getByRole("button", { name: "Try again" });
      await expect(async () => {
        if (await retry.isVisible()) await retry.click();
        await expect(app.rows().first()).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 20_000 });
    } finally {
      await context.setOffline(false);
    }
  });

  test("server unreachable (5xx): stored rows carry a 'saved copy' banner with retry — never the end card", async ({ app, page }) => {
    await app.open();
    try {
      // Star a row and open it: the opened article (with its flags) is now in the device store.
      if (!articleFlags(app.articleId(4)).isStarred) {
        await app.toggle(4, "star");
        await app.expectRow(4, { starred: true });
      }
      const title = (await app.row(4).locator("h3").first().textContent())!.trim();
      await app.activate(app.row(4));
      const reader = page.locator('[data-pane="reader"]');
      await expect(reader.locator(".article-content").first()).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(500); // recordOpened → IndexedDB
      await page.goBack();
      await app.navReady();

      const down = (route: Route) =>
        isListRequest(new URL(route.request().url())) ? route.fulfill({ status: 503, body: "upstream down" }) : route.continue();
      await page.route("**/api/app/articles**", down);
      // Favorites were never loaded in this page: the list request fails and the store answers.
      await app.selectSidebar(/^Starred/);
      const list = page.locator(ACTIVE_LIST);
      const banner = list.getByTestId("list-stored-banner");
      await expect(banner).toBeVisible({ timeout: 30_000 });
      await expect(banner).toContainText("Saved copy – server unreachable");
      await expect(list.locator(".ff-row h3", { hasText: title })).toBeVisible();
      await expect(list.getByTestId("list-stored-end")).toContainText("Only articles saved on this device");
      await expect(list.getByTestId("end-of-list-card")).toHaveCount(0);
      await expect(list.getByText("You're all caught up")).toHaveCount(0);
      // Still down: retry answers from the store again.
      await app.activate(banner.getByRole("button", { name: "Try again" }));
      await expect(banner).toBeVisible();
      // Back up: retry loads the real list, the banner goes.
      await page.unroute("**/api/app/articles**", down);
      await app.activate(banner.getByRole("button", { name: "Try again" }));
      await expect(banner).toHaveCount(0, { timeout: 15_000 });
      await expect(list.getByTestId("list-stored-end")).toHaveCount(0);
    } finally {
      resetArticleState(app.userKey);
    }
  });

  test("a brand-new account gets 'Add feed' (not 'caught up'); an empty Read later has its own copy", async ({ app, page }) => {
    const { email, cleanup } = createEmptyUser(app.userKey, test.info().project.name);
    try {
      await page.context().clearCookies();
      await page.goto("/login");
      await page.getByPlaceholder("Email").fill(email);
      await page.getByPlaceholder("Password").fill(manifest().password);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });

      const empty = page.locator(ACTIVE_LIST).getByTestId("list-no-feeds");
      await expect(empty).toBeVisible({ timeout: 20_000 });
      await expect(empty.getByRole("button", { name: "Add feed" })).toBeVisible();
      await expect(empty.getByRole("button", { name: "Discover feeds" })).toBeVisible();
      await expect(empty.getByRole("link", { name: "Import OPML" })).toHaveAttribute("href", "/manage-feeds?tab=opml");
      await expect(page.getByTestId("end-of-list-card")).toHaveCount(0);
      await expect(page.getByText("You're all caught up")).toHaveCount(0);
      await app.activate(empty.getByRole("button", { name: "Add feed" }));
      await expect(page.getByRole("dialog").filter({ hasText: "Add feed" }).first()).toBeVisible();
      await page.keyboard.press("Escape");

      // Gemerkt says the same: there is nothing to save without feeds.
      await page.goto("/?v=later");
      await expect(page.locator(ACTIVE_LIST).getByTestId("list-no-feeds")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText("You're all caught up")).toHaveCount(0);
    } finally {
      await page.context().clearCookies();
      cleanup();
    }
  });
});

test("empty Read later / Favorites have their own copy, never 'caught up'", async ({ app, page }) => {
  clearSaved(app.userKey);
  await page.goto("/?v=later");
  const later = page.locator(ACTIVE_LIST).getByTestId("list-empty-later");
  await expect(later).toBeVisible({ timeout: 30_000 });
  await expect(later).toContainText("Nothing saved for later");
  await page.goto("/?v=starred");
  const starred = page.locator(ACTIVE_LIST).getByTestId("list-empty-starred");
  await expect(starred).toBeVisible({ timeout: 30_000 });
  await expect(starred).toContainText("No favourites yet");
  await expect(page.getByText("You're all caught up")).toHaveCount(0);
  await expect(page.getByTestId("end-of-list-card")).toHaveCount(0);
});

test.describe("keyboard", () => {
  test.beforeEach(({ app }) => {
    test.skip(app.isMobile, "hardware keyboard");
  });

  test("single-key shortcuts incl. Shift+A do nothing while a dialog or menu is open", async ({ app, page }) => {
    await app.open();
    const unreadBefore = unreadCountInDb(app.userKey);

    // The list "…" menu.
    await page.locator(`${ACTIVE_LIST} [data-testid="list-menu-button"]`).click();
    await expect(page.getByTestId("list-menu")).toBeVisible();
    await page.keyboard.press("j");
    await page.keyboard.press("Shift+A");
    await page.waitForTimeout(800);
    expect(app.where()).not.toContain("a=");
    expect(unreadCountInDb(app.userKey)).toBe(unreadBefore);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("list-menu")).toHaveCount(0);

    // The shortcuts dialog.
    await page.keyboard.press("?");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("j");
    await page.keyboard.press("Shift+A");
    await page.waitForTimeout(800);
    expect(app.where()).not.toContain("a=");
    expect(unreadCountInDb(app.userKey)).toBe(unreadBefore);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // Nothing open: the keys work again.
    await page.keyboard.press("j");
    await expect.poll(() => app.where()).toContain("a=");
  });
});

test.describe("offline chip", () => {
  test.beforeEach(({ app }) => {
    test.skip(!app.isMobile, "compact top bar");
  });

  for (const width of [320, 390]) {
    test(`at ${width} px the chip stays compact: title / segments keep their room, "…" stays on screen`, async ({ app, page, context }) => {
      await page.setViewportSize({ width, height: 800 });
      await app.open();
      await context.setOffline(true);
      try {
        const bar = page.locator(`${ACTIVE_LIST} [data-testid="list-top-bar"]`);
        const chip = bar.getByTestId("offline-chip");
        await expect(chip).toBeVisible();
        await expect(chip).toHaveAccessibleName("Offline – changes only when back online");
        const more = bar.getByTestId("list-menu-button");
        const title = bar.getByTestId("list-bar-title");
        const moreBox = (await more.boundingBox())!;
        expect(moreBox.x + moreBox.width).toBeLessThanOrEqual(width);
        expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(120);

        // Gemerkt: the segmented control keeps its width too.
        await app.tab("Saved").tap();
        const savedBar = page.locator(`${ACTIVE_LIST} [data-testid="list-top-bar"]`);
        await expect(savedBar.getByTestId("offline-chip")).toBeVisible();
        await expect(savedBar.getByTestId("saved-segments")).toBeVisible();
        expect((await savedBar.getByTestId("list-bar-title").boundingBox())!.width).toBeGreaterThanOrEqual(120);
        const savedMore = (await savedBar.getByTestId("list-menu-button").boundingBox())!;
        expect(savedMore.x + savedMore.width).toBeLessThanOrEqual(width);
      } finally {
        await context.setOffline(false);
      }
    });
  }
});

test.describe("overlays: Back closes the menu, not the screen beneath", () => {
  test.beforeEach(({ app }) => {
    test.skip(!app.isMobile, "system Back on touch");
  });

  test("reader '…' (a sheet with a Labels step) and Aa", async ({ app, page }) => {
    await app.open();
    await app.activate(app.row(2));
    const reader = page.locator('[data-pane="reader"]');
    await expect(reader.locator("article h1")).toContainText("(#002)");
    const url = app.where();

    await app.activate(reader.locator(".ff-reader-pill").getByRole("button", { name: "More actions" }));
    const menu = page.getByTestId("reader-menu");
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "Labels" }).tap();
    await expect(menu.getByTestId("menu-sheet-back")).toBeVisible();
    await page.goBack();
    await expect(menu).toHaveCount(0);
    await expect.poll(() => app.where()).toBe(url);
    await expect(reader.locator("article h1")).toContainText("(#002)");

    await app.activate(reader.getByRole("button", { name: "Text appearance" }));
    const aa = page.getByRole("dialog", { name: "Text appearance" });
    await expect(aa).toBeVisible();
    await page.goBack();
    await expect(aa).toHaveCount(0);
    await expect.poll(() => app.where()).toBe(url);
    await expect(reader.locator("article h1")).toContainText("(#002)");

    // A menu action that navigates runs after the menu's history entry is gone.
    await app.activate(reader.locator(".ff-reader-pill").getByRole("button", { name: "More actions" }));
    await menu.getByRole("menuitem", { name: "Next article" }).tap();
    await expect(reader.locator("article h1")).toContainText("(#003)");
    await page.goBack();
    await expect.poll(() => app.where()).not.toContain("a=");
  });

  test("feed '…' and notifications on the Feeds screen", async ({ app, page }) => {
    await app.open();
    const feedMenu = await app.openFeedMenu();
    await expect(feedMenu.getByRole("menuitem", { name: "Feed health" })).toBeVisible();
    await page.goBack();
    await expect(feedMenu).toHaveCount(0);
    if (app.isMobile) await expect.poll(() => app.where()).toBe("/?tab=feeds");

    if (app.isMobile) {
      // Compact: notifications are a step of the Feeds header "…" sheet.
      await page.getByTestId("feeds-menu-button").tap();
      await page.getByTestId("feeds-menu").getByRole("menuitem", { name: /^Notifications/ }).tap();
    } else {
      await page.getByRole("button", { name: "Notifications" }).click();
    }
    await expect(page.getByRole("menu")).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect.poll(() => app.where()).toBe("/?tab=feeds");
  });
});

test.describe("links and settings", () => {
  test("Feed health opens the Health tab of feed management", async ({ app, page }) => {
    await app.open();
    const feedMenu = await app.openFeedMenu();
    await app.activate(feedMenu.getByRole("menuitem", { name: "Feed health" }));
    await expect.poll(() => app.where()).toBe("/manage-feeds?tab=health");
    // The active tab panel is Health (phones navigate the tabs with a select, so check the panel).
    await expect(page.locator('[role="tabpanel"][data-state="active"]').getByRole("heading", { name: "Feed Health Dashboard" })).toBeVisible();
  });

  test("the manifest no longer asks for window-controls-overlay", async ({ page }) => {
    const res = await page.request.get("/manifest.json");
    const json = await res.json();
    expect(JSON.stringify(json)).not.toContain("window-controls-overlay");
    expect(json.display).toBe("standalone");
  });

  test("app badge is on by default and can be switched off per device", async ({ app, page }) => {
    void app; // fixture: PWA prompt + gesture hint off
    await page.goto("/settings?tab=notifications");
    const toggle = page.getByTestId("app-badge-setting").getByRole("switch");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(await page.evaluate(() => localStorage.getItem("feedferret:app-badge"))).toBe("off");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(await page.evaluate(() => localStorage.getItem("feedferret:app-badge"))).toBeNull();
  });

  test("Settings → Reading → gestures explains swipe and long-press and can show the tip again", async ({ app, page }) => {
    void app; // fixture: PWA prompt + gesture hint off
    await page.goto("/settings?tab=reading#gestures");
    const section = page.getByTestId("gesture-settings");
    await expect(section).toBeVisible();
    await expect(section.getByTestId("gesture-demo")).toContainText("long press opens the menu with every action");
    await expect(section.getByTestId("gesture-demo")).toContainText("Screen readers");
    expect(await page.evaluate(() => localStorage.getItem("ff:gesture-hint"))).toBe("done");
    if (!app.isMobile) {
      // Rows keep their buttons with a mouse: there is no tip to show again.
      await expect(section.getByTestId("gesture-hint-reset")).toHaveCount(0);
      return;
    }
    await section.getByTestId("gesture-hint-reset").click();
    expect(await page.evaluate(() => localStorage.getItem("ff:gesture-hint"))).toBeNull();
  });
});

test.describe("app badge and the service worker", () => {
  test.use({ serviceWorkers: "allow" });

  test("the worker learns the badge switch on every shell start, not only on toggle", async ({ app, page }) => {
    void app; // fixture: PWA prompt + gesture hint off
    // The headless shell's renderer crashes when the worker calls the real Badge API (see
    // offline-reading.spec.ts): the badge messages stay out, and the switch stays ON here — "off" makes the
    // worker clear the badge. Off is covered against a fake Badge API in tests/features/service-worker.test.ts.
    await page.addInitScript(() => {
      const post = ServiceWorker.prototype.postMessage;
      ServiceWorker.prototype.postMessage = function (this: ServiceWorker, message: unknown, ...rest: unknown[]) {
        const type = (message as { type?: string } | null)?.type;
        if (type === "SET_BADGE" || type === "CLEAR_BADGE") return;
        return (post as (...a: unknown[]) => void).call(this, message, ...rest);
      } as typeof post;
    });
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    // Nobody touched the switch: only the shell's start-up message can have stored it.
    const stored = () =>
      page.evaluate(async () => (await (await caches.open("feedferret-settings-v1")).match("/__feedferret/badge-pref"))?.text() ?? null);
    await expect.poll(stored, { timeout: 30_000 }).toBe("1");
  });
});

test.describe("touch rows without buttons", () => {
  test("touch: no buttons in the rows; screen readers get one 'Actions' button that opens the row menu", async ({ app, page }) => {
    test.skip(!app.isMobile, "touch");
    await app.open();
    const row = app.row(1);
    await expect(row.getByRole("button", { name: "Star" })).toBeHidden();
    await expect(row.getByRole("button", { name: /^Mark as / })).toBeHidden();
    const actions = app.rowHost(1).getByRole("button", { name: /^Actions: / });
    await expect(actions).toHaveCount(1);
    await actions.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByTestId("article-context-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Star" })).toBeVisible();
    await page.goBack();
    await expect(menu).toHaveCount(0);
  });

  test("mouse: the row buttons stay", async ({ app }) => {
    test.skip(app.isMobile, "fine pointer");
    await app.open();
    await expect(app.row(1).getByRole("button", { name: "Star" })).toBeVisible();
    await expect(app.rowHost(1).getByRole("button", { name: /^Actions: / })).toBeHidden();
  });
});

test.describe("first-use gesture hint", () => {
  test.use({ gestureHint: true });

  test("touch: shown once with the swipe mapping and a nudge of the first row; 'Got it' retires it for good", async ({ app, page }) => {
    test.skip(!app.isMobile, "touch");
    await app.open();
    const hint = page.locator(ACTIVE_LIST).getByTestId("gesture-hint");
    await expect(hint).toBeVisible();
    await expect(hint.getByTestId("gesture-hint-swipe")).toHaveText("Swipe: ← Later · → Read");
    await expect(hint).toContainText("Long press: all actions");
    // The nudge waits until the first row is on screen (the briefing card is above it on Neu)…
    const first = page.locator(`${ACTIVE_LIST} .ff-row`).first();
    await page.waitForTimeout(1500);
    await expect(page.locator(`${ACTIVE_LIST} .ff-row[data-coach]`)).toHaveCount(0);
    // …then opens it to one side, then the other.
    await first.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await expect(first).toHaveAttribute("data-coach", "lead", { timeout: 5_000 });
    await expect(first).toHaveAttribute("data-coach", "trail", { timeout: 5_000 });
    await expect(first).not.toHaveAttribute("data-coach", /.*/, { timeout: 5_000 });

    await app.activate(hint.getByRole("button", { name: "Got it" }));
    await expect(hint).toHaveCount(0);
    // Focus lands on the first row, not on <body>.
    await expect(page.locator(`${ACTIVE_LIST} .ff-row-content`).first()).toBeFocused();
    expect(await page.evaluate(() => localStorage.getItem("ff:gesture-hint"))).toBe("done");
    await page.reload();
    await expect(app.row(1)).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1000);
    await expect(page.getByTestId("gesture-hint")).toHaveCount(0);
  });

  test("touch: the first real swipe retires the hint, and the swipe still works", async ({ app, page }) => {
    test.skip(!app.isMobile, "touch");
    await app.open();
    await expect(page.locator(ACTIVE_LIST).getByTestId("gesture-hint")).toBeVisible();
    // Let the nudge finish (a touch would stop it anyway).
    await page.waitForTimeout(3500);
    await touchSwipeOn(page, app.row(3), 220);
    await expect.poll(() => articleFlags(app.articleId(3)).isRead).toBe(true);
    await expect(page.getByTestId("gesture-hint")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("ff:gesture-hint"))).toBe("done");
  });

  test("touch: the nudge plays once per session — a reload keeps the hint but not the nudge", async ({ app, page }) => {
    test.skip(!app.isMobile, "touch");
    await app.open();
    const first = page.locator(`${ACTIVE_LIST} .ff-row`).first();
    await first.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await expect(first).toHaveAttribute("data-coach", "lead", { timeout: 5_000 });
    await page.reload();
    await expect(page.locator(ACTIVE_LIST).getByTestId("gesture-hint")).toBeVisible({ timeout: 30_000 });
    await page.locator(`${ACTIVE_LIST} .ff-row`).first().evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(3000);
    await expect(page.locator(`${ACTIVE_LIST} .ff-row[data-coach]`)).toHaveCount(0);
  });

  test("touch: with both swipes off the hint only explains long-press and nothing moves", async ({ app, page }) => {
    test.skip(!app.isMobile, "touch");
    await page.addInitScript(() => {
      localStorage.setItem("ff:swipe-start", "none");
      localStorage.setItem("ff:swipe-end", "none");
    });
    await app.open();
    const hint = page.locator(ACTIVE_LIST).getByTestId("gesture-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("Actions with a long press");
    await expect(hint.getByTestId("gesture-hint-swipe")).toHaveCount(0);
    await page.locator(`${ACTIVE_LIST} .ff-row`).first().evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(1500);
    await expect(page.locator(`${ACTIVE_LIST} .ff-row[data-coach]`)).toHaveCount(0);
  });

  test("touch + reduced motion: the hint shows, the row never moves", async ({ app, page }) => {
    test.skip(!app.isMobile, "touch");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await app.open();
    await expect(page.locator(ACTIVE_LIST).getByTestId("gesture-hint")).toBeVisible();
    await page.locator(`${ACTIVE_LIST} .ff-row`).first().evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(1500);
    await expect(page.locator(`${ACTIVE_LIST} .ff-row[data-coach]`)).toHaveCount(0);
  });

  test("mouse: never shown", async ({ app, page }) => {
    test.skip(app.isMobile, "fine pointer");
    await app.open();
    await page.waitForTimeout(1000);
    await expect(page.getByTestId("gesture-hint")).toHaveCount(0);
  });
});
