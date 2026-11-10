import { test, expect } from "../helpers/test";
import { touchHoldOn } from "../helpers/gestures";

// UX wave 2a: the compact Feeds screen (Feeds tab root) and the settings
// shell (section in the URL, navigation list on phones, two panes on wide).

test.describe("Feeds screen (mobile)", () => {
  test.beforeEach(({ app }) => {
    test.skip(!app.isMobile, "the compact Feeds tab");
  });

  test("Reeder-style list: smart views + labels on top, one add / settings / more control, rows ≥44 px without buttons", async ({ app, page }) => {
    await app.open();
    await app.openSidebar();
    const pane = app.sidebar();
    const screen = pane.getByTestId("feeds-screen");
    for (const name of [/^All articles/, /^Starred/, /^Read later/, /^Important/, /^Tutorial/, /^Solo Blog/]) {
      await expect(screen.getByRole("button", { name }).first()).toBeVisible();
    }
    await expect(screen.getByRole("heading", { name: "Labels" })).toBeVisible();
    await expect(screen.getByRole("heading", { name: "Feeds" })).toBeVisible();
    // One "+", one settings entry, one "…" — and no legacy footer row above the tab bar.
    await expect(pane.getByRole("button", { name: "Add feed" }).filter({ visible: true })).toHaveCount(1);
    await expect(pane.getByRole("button", { name: "Settings" }).filter({ visible: true })).toHaveCount(1);
    await expect(pane.getByRole("button", { name: "Manage feeds" })).toHaveCount(0);
    await expect(pane.getByRole("button", { name: "Sign out" })).toHaveCount(0);
    // Every visible control is a 44 px target; feed rows carry no visible buttons on touch.
    const small = await pane.locator("button").evaluateAll((els) =>
      els
        .filter((el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.clipPath !== "inset(50%)" && r.top < window.innerHeight;
        })
        .filter((el) => el.getBoundingClientRect().height < 44 && !el.classList.contains("hit-slop"))
        .map((el) => el.getAttribute("aria-label") ?? el.textContent),
    );
    expect(small).toEqual([]);
    const actions = screen.locator('.ff-feeds-line[data-feed-id] [data-testid="feed-menu-button"]').first();
    expect(await actions.evaluate((el) => getComputedStyle(el).clipPath)).toBe("inset(50%)");
  });

  test("a smart view or label stays in the Feeds tab: Back returns to the Feeds root", async ({ app, page }) => {
    await app.open();
    await app.openSidebar();
    await app.sidebar().getByRole("button", { name: /^Read later/ }).first().tap();
    await expect.poll(() => app.where()).toBe("/?tab=feeds&v=later");
    await expect(app.tab("Feeds")).toHaveAttribute("aria-selected", "true");
    await page.goBack();
    await expect.poll(() => app.where()).toBe("/?tab=feeds");
    await app.sidebar().getByRole("button", { name: /^Important/ }).first().tap();
    await expect.poll(() => app.where()).toMatch(/^\/\?tab=feeds&label=/);
    await expect(app.tab("Feeds")).toHaveAttribute("aria-selected", "true");
    // Re-tapping the active tab pops the level, like a feed.
    await app.tab("Feeds").tap();
    await expect.poll(() => app.where()).toBe("/?tab=feeds");
  });

  test("folders collapse with their unread sum, remember the state, and the name opens the folder", async ({ app, page }) => {
    await app.open();
    await app.openSidebar();
    const screen = app.sidebar().getByTestId("feeds-screen");
    const toggle = screen.getByRole("button", { name: "Expand Tech" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(screen.getByRole("button", { name: /^Hacker Dispatch/ })).toHaveCount(0);
    await toggle.tap();
    await expect(screen.getByRole("button", { name: "Collapse Tech" })).toHaveAttribute("aria-expanded", "true");
    await expect(screen.getByRole("button", { name: /^Hacker Dispatch/ })).toBeVisible();
    // Feeds inside a folder are indented to the folder name; an unfiled feed is not.
    const textStart = (name: RegExp) =>
      screen.getByRole("button", { name }).first().locator("span.truncate").evaluate((el) => el.getBoundingClientRect().left);
    const nested = await textStart(/^Hacker Dispatch/);
    expect(Math.abs(nested - (await textStart(/^Tech\s*\d*$/)) - 32)).toBeLessThanOrEqual(2); // favicon under the folder name (20 px + 12 px gap)
    expect(nested - (await textStart(/^Solo Blog/))).toBeGreaterThanOrEqual(30);
    await page.reload();
    await app.navReady();
    await expect(app.sidebar().getByTestId("feeds-screen").getByRole("button", { name: /^Hacker Dispatch/ })).toBeVisible();
    await app.sidebar().getByTestId("feeds-screen").getByRole("button", { name: /^Tech\s*\d*$/ }).tap();
    await expect.poll(() => app.where()).toMatch(/^\/\?cat=/);
    await page.goBack();
    await expect.poll(() => app.where()).toBe("/?tab=feeds");
  });

  test("long-press a feed: its menu; 'mark all as read' always asks first", async ({ app, page }) => {
    await app.open();
    const before = await app.sidebarCount("Solo Blog");
    expect(before).toBeGreaterThan(0);
    await app.openSidebar();
    await touchHoldOn(page, app.sidebar().getByRole("button", { name: /^Solo Blog/ }), 22);
    const menu = page.getByTestId("feed-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Edit feed" })).toBeVisible();
    await menu.getByRole("menuitem", { name: "Mark all as read…" }).tap();
    const confirm = page.getByTestId("feeds-mark-all-confirm");
    await expect(confirm).toContainText(`${before} unread articles in “Solo Blog”`);
    await confirm.getByRole("button", { name: "Cancel" }).tap();
    await expect(confirm).toHaveCount(0);
    expect(await app.sidebarCount("Solo Blog")).toBe(before);

    await app.openSidebar();
    await touchHoldOn(page, app.sidebar().getByRole("button", { name: /^Solo Blog/ }), 22);
    await page.getByTestId("feed-menu").getByRole("menuitem", { name: "Mark all as read…" }).tap();
    await page.getByTestId("feeds-mark-all-confirm").getByRole("button", { name: "Mark as read" }).tap();
    await expect(app.sidebar().getByRole("button", { name: /^Solo Blog/ }).locator("[data-unread-count]")).toHaveCount(0, { timeout: 15_000 });
  });

  test("header '…': manage feeds, notifications step, gestures help; Back closes it", async ({ app, page }) => {
    await app.open();
    await app.openSidebar();
    await page.getByTestId("feeds-menu-button").tap();
    const menu = page.getByTestId("feeds-menu");
    await expect(menu.getByRole("menuitem", { name: "Manage feeds" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Gestures & help" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
    await page.goBack();
    await expect(menu).toHaveCount(0);
    await expect.poll(() => app.where()).toBe("/?tab=feeds");
    await page.getByTestId("feeds-menu-button").tap();
    await page.getByTestId("feeds-menu").getByRole("menuitem", { name: "Gestures & help" }).tap();
    await expect(page).toHaveURL(/\/settings\?tab=gestures$/);
    await expect(page.getByTestId("gesture-help")).toBeVisible();
  });
});

test.describe("Feeds screen tip", () => {
  test.use({ gestureHint: true });

  test("a one-time tip explains the long-press; gone after 'Got it'", async ({ app, page }) => {
    test.skip(!app.isMobile, "touch rows only");
    await app.open();
    await app.openSidebar();
    const hint = page.getByTestId("feeds-hint");
    await expect(hint).toContainText("Long-press");
    await hint.getByRole("button", { name: "Got it" }).tap();
    await expect(hint).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("ff:feeds-hint"))).toBe("done");
  });
});

test.describe("desktop sidebar", () => {
  test("the expanded sidebar keeps the full tree with its feed '…'", async ({ app, page }) => {
    test.skip(app.isMobile, "desktop");
    await app.open();
    await expect(page.getByRole("navigation", { name: "Feed navigation" })).toBeVisible();
    await expect(page.getByTestId("feeds-screen")).toHaveCount(0);
    const menu = await app.openFeedMenu();
    await expect(menu.getByRole("menuitem", { name: "Feed health" })).toBeVisible();
  });
});

test.describe("settings shell", () => {
  test("phones: a navigation list, the section is a pushed level; Back returns to the list", async ({ app, page }) => {
    test.skip(!app.isMobile, "compact");
    void app;
    await page.goto("/settings");
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    await expect(nav).toBeVisible({ timeout: 20_000 });
    // No <select> as navigation.
    await expect(page.getByRole("combobox")).toHaveCount(0);
    const links = nav.getByRole("link");
    await expect(links).toHaveText(["Appearance", "Reading", "Gestures & help", "Account", "Notifications", "Integrations"]);
    for (const box of await links.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(44);
    await nav.getByRole("link", { name: "Account" }).tap();
    await expect(page).toHaveURL(/\/settings\?tab=account$/);
    await expect(page.locator("#settings-section-title").filter({ hasText: "Account" })).toBeFocused();
    await expect(nav).toBeHidden();
    await page.goBack();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(nav).toBeVisible();
    // In-app back from a section opened cold (deep link): the list, not out of settings.
    await page.goto("/settings?tab=notifications");
    await expect(page.getByTestId("app-badge-setting")).toBeVisible();
    await page.waitForLoadState("networkidle"); // hydrated: the back button acts
    await page.getByRole("button", { name: "Settings", exact: true }).tap();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(nav).toBeVisible();
  });

  test("desktop: two panes, the section is in the URL and survives a reload", async ({ app, page }) => {
    test.skip(app.isMobile, "wide");
    void app;
    await page.goto("/settings");
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    await expect(nav).toBeVisible({ timeout: 20_000 });
    await expect(nav.getByRole("link", { name: "Appearance" })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#settings-section-title").filter({ hasText: "Appearance" })).toBeVisible();
    await nav.getByRole("link", { name: "Integrations" }).click();
    await expect(page).toHaveURL(/\/settings\?tab=integrations$/);
    await expect(nav.getByRole("link", { name: "Integrations" })).toHaveAttribute("aria-current", "page");
    await page.reload();
    await expect(page.locator("#settings-section-title").filter({ hasText: "Integrations" })).toBeVisible({ timeout: 20_000 });
    await expect(nav.getByRole("link", { name: "Appearance" })).toBeVisible();
  });

  test("Gestures & help: swipe settings + every gesture explained; the old reading#gestures link lands there", async ({ app, page }) => {
    await app.openSettings("Gestures & help");
    await expect(page.getByTestId("gesture-settings")).toBeVisible();
    const help = page.getByTestId("gesture-help");
    await expect(help).toContainText("Long-press");
    await expect(help).toContainText("Always asks first");
    await expect(page.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
    await page.goto("/settings?tab=reading#gestures");
    await expect(page).toHaveURL(/\/settings\?tab=gestures#gestures$/);
    await expect(page.getByTestId("gesture-settings")).toBeVisible();
  });
});
