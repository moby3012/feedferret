import type { Page } from "@playwright/test";
import { touchDrag } from "../helpers/gestures";
import { test, expect, type App } from "../helpers/test";

/**
 * Reader swipe-back (lib/gestures/back-swipe.ts, owner report 2026-11-11): a
 * swipe to the right that starts anywhere in the article goes back to the list
 * (nav.up(): one history step, like the back chevron); the reader follows the
 * finger. Real touch input over CDP, so pointer events, `touch-action` and
 * native scrolling behave as on a device. Seed: #006 has a code block, #005 is
 * long.
 */

test.skip(({ isMobile }) => !isMobile, "touch layouts only");

const num = (n: number) => `(#${String(n).padStart(3, "0")})`;
const pane = (page: Page) => page.locator('[data-pane="reader"]');
const shell = (page: Page) => page.locator(".ff-shell");
const SHOTS = process.env.SWIPEBACK_SHOTS;

/** Opens article #n from the list and waits until the slide-in is over. */
async function openArticle(app: App, page: Page, n: number) {
  await app.row(n).scrollIntoViewIfNeeded();
  await app.activate(app.row(n));
  await expect(pane(page).locator("article").filter({ hasText: num(n) }).locator(".article-content")).toBeVisible();
  await expect(shell(page)).toHaveAttribute("data-reader", "open");
  await expect.poll(async () => (await pane(page).boundingBox())?.x).toBe(0);
  await page.waitForTimeout(150); // scroll guard of the tap's own scroll
}

async function readerGeometry(page: Page) {
  return page.evaluate(() => {
    const r = document.querySelector('[data-pane="reader"]')!.getBoundingClientRect();
    const l = document.querySelector('.ff-shell > [data-pane^="list-"][data-active="true"]')!.getBoundingClientRect();
    return { overlaps: r.left < l.right - 1 && r.right > l.left + 1, width: r.width, left: r.left };
  });
}

const rowIdOf = (app: App, n: number) => app.row(n).evaluate((el) => el.closest<HTMLElement>("[data-article-id]")?.dataset.articleId ?? null);

/** Focused element's row id (the list row the article was opened from). */
const focusedRowId = (page: Page) => page.evaluate(() => document.activeElement?.closest<HTMLElement>("[data-article-id]")?.dataset.articleId ?? null);

test("right swipe in the article goes back: one history step, list position kept, focus on the row", async ({ app, page }) => {
  await app.open();
  // Scroll the list so a lost position would show.
  await app.listScroller().evaluate((el) => (el.scrollTop = 600));
  await page.waitForTimeout(200);
  const urlBefore = page.url();
  const n = 9;
  const rowId = await rowIdOf(app, n);
  await openArticle(app, page, n);
  expect(page.url()).not.toBe(urlBefore);
  // The list stays mounted under the reader: its position now is what must survive.
  const before = await app.firstVisibleRow();
  expect(await app.listScroller().evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  await touchDrag(page, { x: 120, y: 420 }, 220, 6, { steps: 12, stepMs: 16 });
  await expect(shell(page)).toHaveAttribute("data-reader", "closed");
  await expect.poll(() => page.url()).toBe(urlBefore);
  // The reader's inline swipe styles are gone (the next open slides in normally).
  await expect(pane(page)).not.toHaveAttribute("data-back-swipe", /.*/);
  expect(await pane(page).evaluate((el) => el.style.transform)).toBe("");
  const after = await app.firstVisibleRow();
  expect(after.id).toBe(before.id);
  expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2);
  await expect.poll(() => focusedRowId(page)).toBe(rowId);
  // Exactly one level: the URL is the list's (a double back would have left it), and Forward reopens the article.
  await page.waitForTimeout(300);
  expect(page.url()).toBe(urlBefore);
  await page.goForward();
  await expect(shell(page)).toHaveAttribute("data-reader", "open");
});

test("a short slow swipe springs back; a left swipe does nothing", async ({ app, page }) => {
  await app.open();
  await openArticle(app, page, 3);
  await touchDrag(page, { x: 120, y: 420 }, 70, 0, { steps: 10, stepMs: 40 });
  await page.waitForTimeout(600);
  await expect(shell(page)).toHaveAttribute("data-reader", "open");
  await expect(pane(page)).not.toHaveAttribute("data-back-swipe", /.*/);
  expect(await pane(page).evaluate((el) => el.style.transform)).toBe("");
  await expect.poll(async () => Math.abs((await pane(page).boundingBox())?.x ?? 99)).toBeLessThan(0.5);

  await touchDrag(page, { x: 330, y: 420 }, -250, 0, { steps: 10, stepMs: 16 });
  await page.waitForTimeout(500);
  await expect(shell(page)).toHaveAttribute("data-reader", "open");
});

test("vertical scrolling never triggers it", async ({ app, page }) => {
  await app.open();
  await openArticle(app, page, 5);
  // A slightly diagonal upward drag: the reader scrolls, nothing moves sideways.
  await touchDrag(page, { x: 150, y: 600 }, 40, -360, { steps: 12, stepMs: 16 });
  await page.waitForTimeout(500);
  await expect(shell(page)).toHaveAttribute("data-reader", "open");
  expect(await app.readerScroller().evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  expect((await pane(page).boundingBox())?.x).toBe(0);
});

test("a swipe starting in a code block does not go back", async ({ app, page }) => {
  await app.open();
  await openArticle(app, page, 6);
  const pre = pane(page).locator(".article-content pre").first();
  await pre.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const box = (await pre.boundingBox())!;
  await touchDrag(page, { x: box.x + 40, y: box.y + Math.min(30, box.height / 2) }, 250, 0, { steps: 12, stepMs: 16 });
  await page.waitForTimeout(500);
  await expect(shell(page)).toHaveAttribute("data-reader", "open");
});

test("setting off disables it; the pill's back button still goes back", async ({ app, page }) => {
  await page.addInitScript(() => localStorage.setItem("ff:swipe-back", "0"));
  await app.open();
  const rowId = await rowIdOf(app, 4);
  await openArticle(app, page, 4);
  await touchDrag(page, { x: 120, y: 420 }, 250, 0, { steps: 12, stepMs: 16 });
  await page.waitForTimeout(500);
  await expect(shell(page)).toHaveAttribute("data-reader", "open");

  const back = page.getByTestId("reader-pill-back");
  await expect(back).toHaveAccessibleName("Back");
  await back.tap();
  await expect(shell(page)).toHaveAttribute("data-reader", "closed");
  await expect.poll(() => focusedRowId(page)).toBe(rowId);
});

test("settings: the toggle and the gesture reference", async ({ app, page }) => {
  await app.open();
  await app.openSettings("Gestures & help");
  const toggle = page.getByTestId("gesture-swipe-back");
  await expect(toggle).toHaveAccessibleName("Swipe right: back");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.tap();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(await page.evaluate(() => localStorage.getItem("ff:swipe-back"))).toBe("0");
  await expect(page.getByTestId("gesture-help")).toContainText("Swipe right");
});

test.describe("first use", () => {
  test.use({ gestureHint: true });
  test("the reader explains the gesture once", async ({ app, page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("ff:gesture-hint", "done");
      localStorage.setItem("ff:feeds-hint", "done");
    });
    await app.open();
    await openArticle(app, page, 2);
    const hint = page.getByTestId("reader-back-hint");
    await expect(hint).toContainText("Swipe right to go back");
    await hint.getByRole("button", { name: "Got it" }).tap();
    await expect(hint).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("ff:back-hint"))).toBe("done");
  });
});

test("pill at 320 px: six items, each a ≥44 px target", async ({ app, page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await app.open();
  await openArticle(app, page, 2);
  const buttons = page.locator(".ff-reader-pill > button, .ff-reader-pill button[aria-haspopup]");
  const boxes = await page.locator(".ff-reader-pill").evaluate((nav) =>
    Array.from(nav.querySelectorAll("button")).map((b) => {
      const r = b.getBoundingClientRect();
      return { w: r.width, h: r.height, label: b.getAttribute("aria-label") };
    }),
  );
  expect(boxes[0]?.label).toBe("Back");
  expect(boxes.length).toBe(6);
  for (const b of boxes) expect(Math.min(b.w, b.h)).toBeGreaterThanOrEqual(44);
  expect(await buttons.count()).toBeGreaterThan(0);
});

test("portrait tablet: swipe-back works where the reader covers the list", async ({ app, page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await app.open();
  await app.row(3).scrollIntoViewIfNeeded();
  await app.activate(app.row(3));
  await expect(shell(page)).toHaveAttribute("data-reader", "open");
  await page.waitForTimeout(500);
  const geo = await readerGeometry(page);
  await touchDrag(page, { x: geo.left + 120, y: 500 }, 400, 0, { steps: 12, stepMs: 16 });
  await page.waitForTimeout(600);
  // Stacked (reader over the list) → back; two panes side by side → nothing to go back from.
  await expect(shell(page)).toHaveAttribute("data-reader", geo.overlaps ? "closed" : "open");
});

test("mid-gesture screenshots (390 px)", async ({ app, page }) => {
  test.skip(!SHOTS, "set SWIPEBACK_SHOTS=<dir> to record");
  await app.open();
  await openArticle(app, page, 7);
  const cdp = await page.context().newCDPSession(page);
  const at = (x: number) => cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: 420, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 60, y: 420, id: 1 }] });
  let x = 60;
  for (const [i, target] of [80, 160, 270].entries()) {
    while (x < target + 60) {
      x += 10;
      await at(x);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(120);
    await page.screenshot({ path: `${SHOTS}/swipeback-${i + 1}.png` });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await expect(shell(page)).toHaveAttribute("data-reader", "closed");
});
