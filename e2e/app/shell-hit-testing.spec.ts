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
  const back = (await page.getByRole("button", { name: /^(Back to list|Back)$/ }).first().elementHandle())!;
  // CSS, not getByRole: under the open reader the list is inert (out of the a11y tree).
  const target = (await app.row(3).locator('button[aria-label^="Mark as "]').elementHandle())!;
  // One synchronous probe: stretch the pop transition (so a busy main thread
  // cannot skip past it), press Back, wait rAF by rAF until the reader is
  // closed but still visible and sliding out OVER the target, and hit-test there.
  const probe = await page.evaluate(
    async ([backButton, button]) => {
      document.documentElement.style.setProperty("--dur-base", "3000ms");
      const pane = document.querySelector<HTMLElement>('.ff-shell > [data-pane="reader"]')!;
      const shell = pane.parentElement!;
      (backButton as HTMLElement).click();
      const deadline = performance.now() + 2500;
      for (;;) {
        await new Promise((r) => requestAnimationFrame(r));
        const closing =
          shell.dataset.reader === "closed" &&
          getComputedStyle(pane).visibility === "visible" &&
          pane.getAnimations().some((a) => a.playState === "running");
        if (closing) break;
        if (performance.now() > deadline) return { closing: false, covered: false, hit: "timeout" };
      }
      const r = button.getBoundingClientRect();
      const [x, y] = [r.x + r.width / 2, r.y + r.height / 2];
      const hit = document.elementFromPoint(x, y);
      const p = pane.getBoundingClientRect();
      return {
        closing: pane.getAnimations().some((a) => a.playState === "running"),
        covered: p.left <= x && x <= p.right && p.top <= y && y <= p.bottom,
        hit: button.contains(hit) ? "row" : (hit?.closest("[data-pane]")?.getAttribute("data-pane") ?? hit?.tagName ?? "none"),
      };
    },
    [back, target] as const,
  );
  expect(probe).toEqual({ closing: true, covered: true, hit: "row" });
  const before = await app.listScroller().evaluate((el) => el.scrollTop);
  await app.activate(app.rowActions(3).read);
  expect(await app.listScroller().evaluate((el) => el.scrollTop)).toBe(before);
  expect(await shellScrollLeft(page)).toBe(0);
  await page.evaluate(() => document.documentElement.style.removeProperty("--dur-base"));
});

test("the shell is never programmatically scrollable sideways", async ({ app, page }) => {
  await app.open();
  await page.evaluate(() => document.querySelector<HTMLElement>(".ff-shell")!.scrollTo({ left: 200 }));
  expect(await shellScrollLeft(page)).toBe(0);
});
