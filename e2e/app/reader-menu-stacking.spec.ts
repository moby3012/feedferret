import type { Locator } from "@playwright/test";
import { ACTIVE_LIST, test, expect } from "../helpers/test";

/**
 * Regression: on a wide desktop window the reader's "…" dropdown opened BEHIND
 * the article body (large images, KI summary card) and was unusable. Every
 * floating menu must be the topmost element at its centre, and clickable.
 * Seed: article #3 carries a figure image.
 */
test.use({ viewport: { width: 2000, height: 950 } });

/** The element at the centre of `item` is `item` (or inside it): nothing covers it. */
async function expectTopmost(item: Locator, what: string) {
  const hit = await item.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)[0];
    return { inside: !!top && el.contains(top), top: top ? `${top.tagName}.${String((top as HTMLElement).className).slice(0, 80)}` : "nothing (off-screen)" };
  });
  expect(hit.inside, `${what} covered by ${hit.top}`).toBe(true);
}

test("desktop 2000×950: reader … menu is above the article and clickable", async ({ app, page }) => {
  test.skip(app.isMobile, "wide desktop layout only");
  await app.open();
  await app.row(3).scrollIntoViewIfNeeded();
  await app.activate(app.row(3));
  await expect(page.locator('[data-pane="reader"] article .article-content img').first()).toBeVisible();
  await page.waitForTimeout(300);

  await page.locator(".ff-reader-bar").getByTestId("reader-more-button").click();
  const menu = page.getByTestId("reader-menu");
  await expect(menu).toBeVisible();
  await page.waitForTimeout(250); // open animation
  const items = menu.getByRole("menuitem");
  expect(await items.count()).toBeGreaterThan(2);
  for (const name of [/Open original/i, /Scroll to top/i]) {
    const item = menu.getByRole("menuitem", { name });
    await expectTopmost(item, String(name));
    const box = await item.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(2000);
  }
  // Clickable: "Scroll to top" runs and closes the menu.
  await menu.getByRole("menuitem", { name: /Scroll to top/i }).click({ timeout: 3_000 });
  await expect(menu).toBeHidden();
});

test("desktop 2000×950: list … menu opens on-screen and above the list", async ({ app, page }) => {
  test.skip(app.isMobile, "wide desktop layout only");
  await app.open();
  await page.locator(`${ACTIVE_LIST} [data-testid="list-menu-button"]`).click();
  const menu = page.getByTestId("list-menu");
  await expect(menu).toBeVisible();
  await page.waitForTimeout(250);
  const first = menu.getByRole("menuitem").first();
  await expectTopmost(first, "first list-menu item");
  // Read-only: Escape closes it (activating an item would persist list settings across specs).
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});
