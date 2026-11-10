import { test, expect } from "../helpers/test";

/**
 * Compact shell geometry vs. taps (main b2dd0e6 CI, slim-list.spec.ts:95):
 * - the floating bottom bar covers the list scroller's last ~5rem; without
 *   scroll-padding, scrollIntoView parks a row under it and the tap misses;
 * - the closing reader stays visible for its pop transition and must not
 *   swallow taps meant for the list it reveals;
 * - the off-canvas panes give the shell a horizontal overflow: it must never
 *   be scrollable (overflow: clip), or any scrollIntoView slides it sideways.
 */
test.skip(({ isMobile }) => !isMobile, "compact layout only");

const shellScrollLeft = (page: import("@playwright/test").Page) =>
  page.evaluate(() => document.querySelector<HTMLElement>(".ff-shell")!.scrollLeft);

test("a row action scrolled into view is not under the bottom bar; tapping it moves neither list nor shell", async ({ app, page }) => {
  await app.open();
  const scroller = app.listScroller();
  const star = app.rowActions(7).star;
  // Park the star 30px above the viewport's bottom edge: under the floating bar.
  const vh = page.viewportSize()!.height;
  const box = (await star.boundingBox())!;
  await scroller.evaluate((el, dy) => el.scrollBy(0, dy), box.y - (vh - 30));
  await star.scrollIntoViewIfNeeded();
  const bar = (await page.getByRole("navigation").last().boundingBox())!;
  expect((await star.boundingBox())!.y + (await star.boundingBox())!.height).toBeLessThanOrEqual(bar.y);
  const before = await scroller.evaluate((el) => el.scrollTop);
  await app.activate(star);
  await expect(star).toHaveAccessibleName("Remove star");
  expect(Math.abs((await scroller.evaluate((el) => el.scrollTop)) - before)).toBeLessThanOrEqual(2);
  expect(await shellScrollLeft(page)).toBe(0);
});

test("a row action tapped right after Back hits the list, not the closing reader", async ({ app, page }) => {
  await app.open();
  await app.activate(app.row(2));
  await expect(page.locator("article").filter({ hasText: "(#002)" })).toBeVisible();
  await app.activate(page.getByRole("button", { name: /^(Back to list|Back)$/ }).first());
  // Hit-test at once, during the pop transition (no Playwright retry / scroll).
  const onTop = await app.rowActions(3).read.evaluate((button) => {
    const r = button.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return button.contains(hit) ? "row" : (hit?.closest("[data-pane]")?.getAttribute("data-pane") ?? hit?.tagName ?? "none");
  });
  expect(onTop).toBe("row");
  const before = await app.listScroller().evaluate((el) => el.scrollTop);
  await app.activate(app.rowActions(3).read);
  expect(await app.listScroller().evaluate((el) => el.scrollTop)).toBe(before);
  expect(await shellScrollLeft(page)).toBe(0);
});

test("the shell is never programmatically scrollable sideways", async ({ app, page }) => {
  await app.open();
  await page.evaluate(() => document.querySelector<HTMLElement>(".ff-shell")!.scrollTo({ left: 200 }));
  expect(await shellScrollLeft(page)).toBe(0);
});
