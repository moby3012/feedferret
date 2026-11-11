import type { Locator } from "@playwright/test";
import { test, expect } from "../helpers/test";

/**
 * Regression: the feed-edit dialog's tab row (6 tabs in a ~510 px dialog) was a
 * horizontally scrolling track that clipped "Aufbewahrung…" with no affordance.
 * The shared segmented tab nav now wraps: every trigger sits fully inside the
 * tablist's box and nothing needs scrolling. Runs at 1280 px (desktop project)
 * and 390 px (mobile project).
 */
async function expectAllTabsVisible(tablist: Locator) {
  const tabs = tablist.getByRole("tab");
  expect(await tabs.count()).toBeGreaterThanOrEqual(4);
  const res = await tablist.evaluate((list) => {
    const l = list.getBoundingClientRect();
    return {
      noScroll: list.scrollWidth <= list.clientWidth + 1,
      clipped: Array.from(list.querySelectorAll('[role="tab"]'))
        .map((t) => ({ name: t.textContent, r: t.getBoundingClientRect() }))
        .filter(({ r }) => r.width === 0 || r.left < l.left - 1 || r.right > l.right + 1 || r.top < l.top - 1 || r.bottom > l.bottom + 1)
        .map(({ name }) => name),
    };
  });
  expect(res.clipped, "tab triggers outside the tablist box").toEqual([]);
  expect(res.noScroll, "tablist must not need horizontal scrolling").toBe(true);
  const last = tabs.last();
  await expect(last).toBeInViewport({ ratio: 1 });
}

test("feed edit dialog: every tab is fully visible and selectable", async ({ app, page }) => {
  await app.open();
  await page.goto("/manage-feeds");
  await page.getByRole("button", { name: "Settings" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const tablist = dialog.getByRole("tablist");
  await expectAllTabsVisible(tablist);
  // The last tab is reachable and activates.
  await tablist.getByRole("tab").last().click();
  await expect(tablist.getByRole("tab").last()).toHaveAttribute("aria-selected", "true");
});

test("manage feeds page: every tab is fully visible", async ({ page, app }) => {
  await app.open();
  await page.goto("/manage-feeds");
  await expectAllTabsVisible(page.getByRole("tablist").filter({ has: page.getByRole("tab", { name: "Categories" }) }));
});
