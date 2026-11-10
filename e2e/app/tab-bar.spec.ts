import type { Page } from "@playwright/test";
import { test, expect, ACTIVE_LIST, type App } from "../helpers/test";

/**
 * Compact IA (PR 7, .pm/spec-shell-design.md §1.4 / §4.6): the floating tab
 * bar Neu · Gemerkt · Feeds · Suche on phones, the icon rail on tablets
 * (768–1199 px) and the collapsible sidebar (`[`) on desktop. Each tab keeps
 * its own stack and scroll offset; the old bottom-pill actions live in the
 * list top bar ("…" menu, filter chip) and pull-to-refresh.
 */

const ffIndex = (page: Page) => page.evaluate(() => (history.state as { ff?: { i: number } } | null)?.ff?.i ?? -1);
const scrollTopOf = (app: App) => app.listScroller().evaluate((el) => el.scrollTop);
async function scrollListTo(app: App, top: number) {
  const scroller = app.listScroller();
  await scroller.evaluate((el, y) => el.scrollTo({ top: y, behavior: "instant" }), top);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(top - 5);
  await app.page.waitForTimeout(150); // scroll memory samples on the next frame
  return scroller.evaluate((el) => el.scrollTop);
}

test.describe("mobile tab bar", () => {
  test.skip(({ isMobile }) => !isMobile, "compact layout");

  test("four labelled tabs with tablist semantics; arrow keys move focus; Neu carries a dot, never a number", async ({ app, page }) => {
    await app.open();
    const bar = app.tabBar();
    await expect(bar).toBeVisible();
    const tabs = bar.getByRole("tab");
    await expect(tabs).toHaveText(["New", "Saved", "Feeds", "Search"]);
    await expect(app.tab("New")).toHaveAttribute("aria-selected", "true");
    for (const name of ["Saved", "Feeds", "Search"] as const) await expect(app.tab(name)).toHaveAttribute("aria-selected", "false");
    await expect(app.tab("New")).toHaveAttribute("aria-controls", "ff-pane-new");
    await expect(page.locator("#ff-pane-new")).toHaveCount(1);
    // The controlled panes are tabpanels named by their tab — the Feeds root too.
    await expect(page.locator("#ff-pane-new")).toHaveAttribute("role", "tabpanel");
    await expect(page.locator("#ff-pane-new")).toHaveAccessibleName("New");
    await expect(app.tab("Feeds")).toHaveAttribute("aria-controls", "ff-pane-sources ff-pane-feeds");
    await app.tab("Feeds").tap();
    await expect.poll(() => app.where()).toBe("/?tab=feeds");
    await expect(page.getByRole("tabpanel", { name: "Feeds" }).locator(".ff-feeds-header")).toBeVisible();
    await app.tab("New").tap();
    await expect.poll(() => app.where()).toBe("/");
    // Anti-anxiety: unread is a dot on Neu, no number anywhere in the bar.
    await expect(bar.getByTestId("tab-unread-dot")).toHaveCount(1);
    expect(await bar.innerText()).not.toMatch(/\d/);
    // Roving focus.
    await app.tab("New").focus();
    await page.keyboard.press("ArrowRight");
    await expect(app.tab("Saved")).toBeFocused();
    await page.keyboard.press("End");
    await expect(app.tab("Search")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(app.tab("New")).toBeFocused();
    // The bar floats inside the safe area, centred, ≤420 px wide.
    const box = (await bar.boundingBox())!;
    const vw = page.viewportSize()!.width;
    expect(box.width).toBeLessThanOrEqual(420);
    expect(Math.abs(box.x - (vw - box.x - box.width))).toBeLessThanOrEqual(1);
  });

  test("every destination is at most two taps from launch", async ({ app, page }) => {
    // A fresh launch: no remembered tab stacks (sessionStorage "ff:tabs").
    const launch = async () => {
      if (page.url().startsWith("http")) await page.evaluate(() => sessionStorage.removeItem("ff:tabs"));
      await app.open();
      expect(app.where()).toBe("/");
    };
    // Neu: 0 taps. Gemerkt (Später): 1. Favoriten: 2.
    await launch();
    await app.tab("Saved").tap();
    await expect.poll(() => app.where()).toBe("/?v=later");
    await page.getByRole("radio", { name: "Favorites" }).tap();
    await expect.poll(() => app.where()).toBe("/?v=starred");
    await expect(page.getByRole("heading", { level: 2, name: "Starred" })).toBeAttached();
    // Feeds root: 1. A feed: 2.
    await launch();
    await app.tab("Feeds").tap();
    await expect.poll(() => app.where()).toBe("/?tab=feeds");
    await app.sidebar().getByRole("button", { name: /^Solo Blog\s*\d+$/ }).tap();
    await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeVisible();
    // A label: 2 (Gemerkt → chip).
    await launch();
    await app.tab("Saved").tap();
    await page.locator(`${ACTIVE_LIST} .ff-label-chips`).getByRole("button", { name: /Important/ }).tap();
    await expect.poll(() => app.where()).toMatch(/^\/\?label=/);
    await expect(app.tab("Saved")).toHaveAttribute("aria-selected", "true");
    // Suche: 1, field focused.
    await launch();
    await app.tab("Search").tap();
    await expect.poll(() => app.where()).toBe("/?tab=search");
    await expect(page.getByTestId("search-field").filter({ visible: true })).toBeFocused();
    // Add feed: 2. Settings: 2.
    await launch();
    await app.tab("Feeds").tap();
    await page.locator(".ff-feeds-header").getByRole("button", { name: "Add feed" }).tap();
    await expect(page.getByRole("dialog", { name: "Add Feed" })).toBeVisible();
    await launch();
    await app.tab("Feeds").tap();
    await page.locator(".ff-feeds-header").getByRole("button", { name: "Settings" }).tap();
    await expect(page).toHaveURL(/\/settings/);
  });

  test("switching tabs keeps each tab's scroll offset and the Feeds tab's open feed", async ({ app, page }) => {
    await app.open();
    const neu = await scrollListTo(app, 700);

    await app.tab("Feeds").tap();
    await app.sidebar().getByRole("button", { name: /^Solo Blog\s*\d+$/ }).tap();
    await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeVisible();
    const solo = await scrollListTo(app, 300);

    await app.tab("Saved").tap();
    await expect(page.getByRole("heading", { level: 2, name: "Read later" })).toBeAttached();
    const later = await scrollListTo(app, 200);

    await app.tab("New").tap();
    await expect.poll(() => app.where()).toBe("/");
    expect(Math.abs((await scrollTopOf(app)) - neu)).toBeLessThanOrEqual(1);

    await app.tab("Feeds").tap();
    await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeVisible();
    expect(app.where()).toMatch(/^\/\?feed=/);
    expect(Math.abs((await scrollTopOf(app)) - solo)).toBeLessThanOrEqual(1);

    await app.tab("Saved").tap();
    await expect.poll(() => app.where()).toBe("/?v=later");
    expect(Math.abs((await scrollTopOf(app)) - later)).toBeLessThanOrEqual(1);
  });

  test("Back: feed list → Feeds root → leaves the app; tab switches never stack history", async ({ app, page }) => {
    // A known page before the app: the final Back must land exactly there.
    const before = `http://127.0.0.1:${process.env.E2E_FIXTURE_PORT || 4010}/healthz`;
    await page.goto(before);
    await app.open();
    expect(await ffIndex(page)).toBe(0);
    await app.tab("Feeds").tap();
    await expect.poll(() => app.where()).toBe("/?tab=feeds");
    expect(await ffIndex(page)).toBe(0); // tab root: the bottom of its own stack
    await app.sidebar().getByRole("button", { name: /^Solo Blog\s*\d+$/ }).tap();
    await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeVisible();
    expect(await ffIndex(page)).toBe(1);
    // Switching away and back restores the two-level stack (root + feed).
    await app.tab("New").tap();
    await expect.poll(() => app.where()).toBe("/");
    expect(await ffIndex(page)).toBe(0);
    await app.tab("Feeds").tap();
    await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeVisible();
    expect(await ffIndex(page)).toBe(1);

    await page.goBack();
    await expect.poll(() => app.where()).toBe("/?tab=feeds");
    // At a tab root nothing app-pushed is beneath: the next Back leaves the app (spec §1.4),
    // even after hopping New → Feeds → New → Feeds above.
    expect(await ffIndex(page)).toBe(0);
    await page.goBack();
    await expect(page).toHaveURL(before);
  });

  test("re-tapping the active tab pops a pushed level, then scrolls to the top", async ({ app, page }) => {
    await app.open();
    await app.tab("Feeds").tap();
    await app.sidebar().getByRole("button", { name: /^Solo Blog\s*\d+$/ }).tap();
    await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeVisible();
    await app.tab("Feeds").tap();
    await expect.poll(() => app.where()).toBe("/?tab=feeds");

    await app.tab("New").tap();
    await scrollListTo(app, 900);
    await app.tab("New").tap();
    await expect.poll(() => scrollTopOf(app)).toBeLessThanOrEqual(1);
    expect(app.where()).toBe("/");
  });

  test("the tab bar hides in the reader and while the keyboard is up", async ({ app, page }) => {
    await app.open();
    const bar = app.tabBar();
    await app.activate(app.row(1));
    await expect(page.locator('[data-pane="reader"] article')).toBeVisible();
    await expect(bar).toHaveAttribute("data-hidden", "");
    await expect(bar).toHaveAttribute("inert", "");
    await page.goBack();
    await expect(bar).not.toHaveAttribute("data-hidden", "");

    await app.openSearch(); // focuses the field: the on-screen keyboard is up
    await expect(bar).toHaveAttribute("data-hidden", "");
    await page.getByTestId("search-field").filter({ visible: true }).blur();
    await expect(bar).not.toHaveAttribute("data-hidden", "");
  });

  test("the tab bar comes back when the keyboard is dismissed without a blur (Android Back)", async ({ app, page }) => {
    await app.open();
    const bar = app.tabBar();
    const field = page.getByTestId("search-field").filter({ visible: true });
    // Emulated keyboard: the visual viewport shrinks / recovers while focus stays put.
    const keyboard = (up: boolean) =>
      page.evaluate((up) => {
        const vv = window.visualViewport!;
        const w = window as unknown as { __vvH?: number };
        w.__vvH ??= vv.height;
        const h = up ? w.__vvH - 340 : w.__vvH;
        Object.defineProperty(vv, "height", { configurable: true, get: () => h });
        vv.dispatchEvent(new Event("resize"));
      }, up);

    await app.openSearch();
    await expect(field).toBeFocused();
    await expect(bar).toHaveAttribute("data-hidden", "");
    await keyboard(true);
    await expect(bar).toHaveAttribute("data-hidden", "");
    await keyboard(false); // dismissed, no blur
    await expect(field).toBeFocused();
    await expect(bar).not.toHaveAttribute("data-hidden", "");
    await expect(bar).not.toHaveAttribute("inert", "");
    // Tapping the still-focused field brings the keyboard (and the hiding) back.
    await keyboard(true);
    await expect(bar).toHaveAttribute("data-hidden", "");
    await keyboard(false);
    await expect(bar).not.toHaveAttribute("data-hidden", "");
  });

  test("relocated list actions: filter chip, '…' menu (sort · layout · refresh · mark all), no bottom pill", async ({ app, page }) => {
    await app.open();
    await expect(page.getByRole("button", { name: "Refresh feeds" }).filter({ visible: true })).toHaveCount(0);
    const chip = page.locator(`${ACTIVE_LIST} [data-testid="filter-chip"]`);
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await chip.tap();
    await expect.poll(() => app.where()).toBe("/?show=all");
    await expect(chip).toHaveAttribute("aria-pressed", "false");
    await chip.tap();
    await expect.poll(() => app.where()).toBe("/");

    await page.locator(`${ACTIVE_LIST} [data-testid="list-menu-button"]`).tap();
    const menu = page.getByTestId("list-menu");
    await expect(menu).toBeVisible();
    for (const name of [/^Sort (newest|oldest) first$/, "List", "Compact", "Magazine", "Refresh", "Mark all as read"]) {
      await expect(menu.getByRole("menuitem", { name })).toBeVisible();
    }
    // The menu is a history level on touch: Back closes it in place.
    await page.goBack();
    await expect(menu).toBeHidden();
    expect(app.where()).toBe("/");
    // Pull-to-refresh is the primary refresh path.
    await expect(page.locator(`${ACTIVE_LIST} .ff-pull-indicator`)).toHaveCount(1);
  });

  test("Suche: one search UI — Enter commits, clear returns to the Suche root, recent queries are offered", async ({ app, page }) => {
    await app.open();
    await app.openSearch();
    const needle = app.user.sample.needle;
    await page.keyboard.type(needle);
    await page.keyboard.press("Enter");
    await expect(app.rowsMatching(needle)).toHaveCount(app.user.sample.needleHits);
    expect(app.where()).toBe(`/?q=${encodeURIComponent(needle)}`);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.locator(ACTIVE_LIST).getByRole("button", { name: "Clear search" }).tap();
    await expect.poll(() => app.where()).toBe("/?tab=search");
    const home = page.locator(`${ACTIVE_LIST} [data-testid="search-home"]`);
    await home.getByRole("button", { name: needle }).tap();
    await expect.poll(() => app.where()).toBe(`/?q=${encodeURIComponent(needle)}`);
  });
});

test.describe("tablet 820x1180: rail + list + reader", () => {
  test.skip(({ isMobile }) => isMobile, "desktop project drives the viewport");
  test.use({ viewport: { width: 820, height: 1180 } });

  test("the rail switches tabs (each keeps its scroll); every destination ≤2 clicks", async ({ app, page }) => {
    await app.open();
    const rail = page.getByTestId("shell-rail");
    await expect(rail).toBeVisible();
    await expect(app.tabBar()).toBeHidden();
    await expect(rail.getByRole("tab")).toHaveText(["New", "Saved", "Feeds", "Search"]);
    const neu = await scrollListTo(app, 600);

    await rail.getByRole("tab", { name: "Saved" }).click();
    await expect.poll(() => app.where()).toBe("/?v=later");
    await page.getByRole("radio", { name: "Favorites" }).click();
    await expect.poll(() => app.where()).toBe("/?v=starred");

    await rail.getByRole("tab", { name: "Feeds" }).click(); // no feed yet: the tree opens as a drawer
    const drawer = page.getByRole("dialog", { name: /feed navigation/i });
    await drawer.getByRole("button", { name: /^Solo Blog\s*\d+$/ }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeVisible();

    await rail.getByRole("tab", { name: "Search" }).click();
    await expect(page.getByTestId("search-field").filter({ visible: true })).toBeFocused();

    await rail.getByRole("tab", { name: "New" }).click();
    await expect.poll(() => app.where()).toBe("/");
    expect(Math.abs((await scrollTopOf(app)) - neu)).toBeLessThanOrEqual(1);

    // List and reader side by side, right of the rail.
    await app.activate(app.row(2));
    const article = page.locator('[data-pane="reader"] article');
    await expect(article).toBeVisible();
    const r = (await rail.boundingBox())!;
    const l = (await app.row(2).boundingBox())!;
    const a = (await article.boundingBox())!;
    expect(r.x + r.width).toBeLessThanOrEqual(l.x + 1);
    expect(l.x + l.width).toBeLessThanOrEqual(a.x + 1);
  });
});

test.describe("tablet 820x1180: sources drawer focus", () => {
  test.skip(({ isMobile }) => isMobile, "desktop project drives the viewport");
  test.use({ viewport: { width: 820, height: 1180 } });

  test("panes are tabpanels of the rail; closing the drawer returns focus to the rail control that opened it", async ({ app, page }) => {
    await app.open();
    const rail = page.getByTestId("shell-rail");
    await expect(page.locator("#ff-pane-new")).toHaveAttribute("role", "tabpanel");
    await expect(page.locator("#ff-pane-new")).toHaveAttribute("aria-labelledby", "ff-rail-tab-new");
    const drawer = page.getByRole("dialog", { name: /feed navigation/i });

    // "Show sources" → Escape: focus back on that button.
    const show = rail.getByRole("button", { name: "Show sources" });
    await show.focus();
    await page.keyboard.press("Enter");
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(show).toBeFocused();

    // Feeds tab → pick a feed (the drawer closes through history): focus back on the tab.
    const feeds = rail.getByRole("tab", { name: "Feeds" });
    await feeds.focus();
    await page.keyboard.press("Enter");
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: /^Solo Blog\s*\d+$/ }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeVisible();
    await expect(drawer).toBeHidden();
    await expect(feeds).toBeFocused();
  });
});

test.describe("desktop", () => {
  test.skip(({ isMobile }) => isMobile, "expanded layout");

  test("sidebar collapses to the rail with `[`, persists across reload with no layout shift", async ({ app, page }) => {
    await app.open();
    const shell = page.locator(".ff-shell");
    await expect(shell).toHaveAttribute("data-sources", "full");
    await expect(page.getByTestId("shell-rail")).toBeHidden();
    await expect(app.tabBar()).toBeHidden();
    // No visible tablist with the full sidebar: the list is a plain labelled region.
    await expect(page.getByRole("region", { name: "Article list" })).toHaveCount(1);
    await page.keyboard.press("[");
    await expect(shell).toHaveAttribute("data-sources", "rail");
    await expect(page.getByTestId("shell-rail")).toBeVisible();
    const listX = (await app.row(1).boundingBox())!.x;
    expect(listX).toBeLessThan(150);

    // The first paint after a reload already has the rail (cookie → SSR): the list never moves.
    await page.addInitScript(() => {
      const w = window as unknown as { __xs: number[] };
      w.__xs = [];
      const sample = () => {
        const row = document.querySelector('[data-pane^="list-"][data-active="true"]');
        if (row) w.__xs.push(Math.round(row.getBoundingClientRect().x));
        if (w.__xs.length < 200) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.reload();
    await expect(app.row(1)).toBeVisible({ timeout: 30_000 });
    await expect(shell).toHaveAttribute("data-sources", "rail");
    const xs = await page.evaluate(() => (window as unknown as { __xs: number[] }).__xs);
    expect(xs.length).toBeGreaterThan(0);
    expect(new Set(xs).size).toBe(1);

    // And back.
    await page.keyboard.press("[");
    await expect(shell).toHaveAttribute("data-sources", "full");
    await expect(page.getByRole("navigation", { name: /feed navigation/i })).toBeVisible();
  });

  test("`/` opens the Suche tab with its field focused (no search dialog)", async ({ app, page }) => {
    await app.open();
    await page.keyboard.press("/");
    await expect.poll(() => app.where()).toBe("/?tab=search");
    await expect(page.getByTestId("search-field").filter({ visible: true })).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
