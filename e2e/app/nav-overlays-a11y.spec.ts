import type { Page } from "@playwright/test";
import { test, expect, ACTIVE_LIST } from "../helpers/test";

/**
 * Review follow-ups of the nav core (PR 228): overlays live in the nav store
 * (system Back closes them instead of navigating beneath), the compact
 * reader takes focus and makes what it covers inert, a dismissed search
 * dialog never commits, tab roots keep `a`, and deep scroll offsets restore
 * beyond the list's initial render window.
 */

const dialog = (page: Page, name: string | RegExp) => page.getByRole("dialog", { name });
const activeInReader = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('[data-pane="reader"]'));

test.describe("overlays are history levels on touch / compact", () => {
  test("system Back closes the command palette, shortcuts and Add Feed without leaving the place", async ({ app, page, isMobile }) => {
    test.skip(!isMobile, "fine-pointer wide overlays push no history entry (spec §1.4 row 8)");
    await app.open();
    await app.activate(app.row(1));
    await expect(page.locator('[data-pane="reader"] article')).toBeVisible();
    const url = app.where();

    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByPlaceholder(/command/i)).toBeVisible();
    await page.goBack();
    await expect(page.getByPlaceholder(/command/i)).toBeHidden();
    await expect.poll(() => app.where()).toBe(url);
    await expect(page.locator('[data-pane="reader"] article')).toBeVisible();

    // Palette → "Keyboard shortcuts": swapped, not stacked — one Back closes it.
    await page.keyboard.press("ControlOrMeta+k");
    const length = await page.evaluate(() => history.length);
    await page.getByRole("option", { name: /keyboard shortcuts/i }).click();
    await expect(dialog(page, /keyboard shortcuts/i)).toBeVisible();
    await expect(page.getByPlaceholder(/command/i)).toBeHidden();
    expect(await page.evaluate(() => history.length)).toBe(length);
    await page.goBack();
    await expect(dialog(page, /keyboard shortcuts/i)).toBeHidden();
    await expect.poll(() => app.where()).toBe(url);
  });

  test("Add Feed from the Feeds tab: Back closes it and stays on the Feeds root", async ({ app, page, isMobile }) => {
    test.skip(!isMobile, "the Feeds tab is the compact feed picker");
    await app.open();
    await app.openSidebar();
    await app.sidebar().getByRole("button", { name: /^Add feed$/i }).first().tap();
    await expect(dialog(page, "Add Feed")).toBeVisible();
    expect(app.where()).toBe("/?tab=feeds");
    await page.goBack();
    await expect(dialog(page, "Add Feed")).toBeHidden();
    await expect.poll(() => app.where()).toBe("/?tab=feeds");
    await expect(page.locator('[data-pane="sources"]').getByRole("button", { name: /^Solo Blog\s*\d+$/ })).toBeVisible();
  });

  test("?addFeed=1: Back closes the dialog first and stays on the Feeds root", async ({ app, page, isMobile }) => {
    test.skip(!isMobile, "fine-pointer wide overlays push no history entry");
    await page.goto("/?addFeed=1");
    await expect(dialog(page, "Add Feed")).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => app.where()).toBe("/?tab=feeds");
    await page.goBack();
    await expect(dialog(page, "Add Feed")).toBeHidden();
    await expect.poll(() => app.where()).toBe("/?tab=feeds");
  });

  test("a search edit still pending when the tab changes is never committed", async ({ app, page, isMobile }) => {
    test.skip(!isMobile, "tab bar");
    await app.open();
    await app.openSearch();
    await page.getByTestId("search-field").filter({ visible: true }).fill("cancelled draft");
    // Keyboard down (the bar hides while it is up), then a tab tap — well within the 300 ms commit delay.
    await page.evaluate(async () => {
      (document.activeElement as HTMLElement | null)?.blur();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      document.querySelector<HTMLElement>("#ff-tab-new")!.click();
    });
    await page.waitForTimeout(800);
    expect(app.where()).toBe("/");
    // Back on Suche: the committed (empty) query, not the dismissed draft.
    await app.tab("Search").tap();
    await expect(page.getByTestId("search-field").filter({ visible: true })).toHaveValue("");
    expect(app.where()).toBe("/?tab=search");
  });
});

test.describe("compact reader: focus and inert", () => {
  test("opening moves focus into the reader; the list and tab bar behind it are inert; closing restores focus to the row", async ({ app, page, isMobile }) => {
    test.skip(!isMobile, "compact layout: the reader covers the list");
    await app.open();
    const id = app.articleId(2);
    await app.activate(app.row(2));
    await expect(page.locator('[data-pane="reader"] article')).toBeVisible();

    await expect.poll(() => activeInReader(page)).toBe(true);
    await expect(page.locator(ACTIVE_LIST)).toHaveAttribute("inert", "");
    await expect(page.getByTestId("tab-bar")).toHaveAttribute("inert", "");
    // Tabbing never escapes into the covered list / bottom controls.
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const where = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return "body";
        // Covered = the list panes, the Feeds root and the tab bar under the reader.
        if (el.closest('[data-pane^="list-"], [data-pane="sources"], [data-testid="tab-bar"]')) return `covered: ${el.outerHTML.slice(0, 160)}`;
        return el.closest('[data-pane="reader"]') ? "reader" : "outside-shell"; // e.g. the skip link
      });
      expect(where).not.toMatch(/^covered/);
    }

    await page.goBack();
    await expect(page.locator('[data-pane="reader"] article')).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator(ACTIVE_LIST)).not.toHaveAttribute("inert", "");
    await expect(page.getByTestId("tab-bar")).not.toHaveAttribute("inert", "");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest("[data-article-id]")?.getAttribute("data-article-id") ?? null))
      .toBe(id);
  });

  test("wide: list and reader stay interactive side by side", async ({ app, page, isMobile }) => {
    test.skip(isMobile, "wide layout");
    await app.open();
    await app.activate(app.row(2));
    await expect(page.locator('[data-pane="reader"] article')).toBeVisible();
    await expect(page.locator(ACTIVE_LIST)).not.toHaveAttribute("inert", "");
  });
});

test("tab root + article round-trips through reload, back and forward", async ({ app, page }) => {
  const id = app.articleId(5);
  await page.goto(`/?tab=feeds&a=${id}`);
  const reader = page.locator('[data-pane="reader"] article').filter({ hasText: "(#005)" });
  await expect(reader).toBeVisible({ timeout: 30_000 });
  await app.navReady();
  expect(app.where()).toBe(`/?tab=feeds&a=${id}`);
  await page.reload();
  await expect(reader).toBeVisible({ timeout: 30_000 });
  expect(app.where()).toBe(`/?tab=feeds&a=${id}`);
  await page.goBack();
  await expect.poll(() => app.where()).toBe("/?tab=feeds");
  await page.goForward();
  await expect.poll(() => app.where()).toBe(`/?tab=feeds&a=${id}`);
  await expect(reader).toBeVisible();
});

test("a deep list offset (beyond the first 30 rows) restores after reload", async ({ app, page }) => {
  await app.open();
  const scroller = app.listScroller();
  // Scroll in steps so the list reveals more rows on the way down.
  for (let i = 0; i < 40; i++) {
    const count = await app.rows().count();
    if (count > 45) break;
    await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: "instant" }));
    await page.waitForTimeout(150);
  }
  expect(await app.rows().count()).toBeGreaterThan(45);
  // Park the 41st row at the top of the scroller.
  const anchor = await scroller.evaluate((el) => {
    const row = el.querySelectorAll<HTMLElement>("[data-article-id]")[40];
    el.scrollTo({ top: el.scrollTop + row.getBoundingClientRect().top - el.getBoundingClientRect().top, behavior: "instant" });
    return row.getAttribute("data-article-id")!;
  });
  await page.waitForTimeout(300); // scroll memory samples on the next frame
  await page.reload();
  await expect(app.row(1)).toHaveCount(1, { timeout: 30_000 });
  // The anchor row is back at the top of the scroller (rows past the initial 30 were revealed).
  await expect
    .poll(
      () =>
        scroller.evaluate((el, id) => {
          const row = el.querySelector<HTMLElement>(`[data-article-id="${id}"]`);
          return row ? Math.abs(Math.round(row.getBoundingClientRect().top - el.getBoundingClientRect().top)) : Infinity;
        }, anchor),
      { timeout: 10_000 },
    )
    .toBeLessThanOrEqual(8);
});
