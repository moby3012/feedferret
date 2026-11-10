import type { Locator, Page } from "@playwright/test";
import { test, expect, type App } from "../helpers/test";

/**
 * Reader chrome v2 (.pm/spec-shell-design.md §4.7 + PR 8): instant title,
 * hide-on-scroll top bar + progress, explicit prev/next, per-article position
 * memory, the "Aa" typography sheet and the tracked pull past the end.
 * Seed: articles #1–#11 are unread and consecutive in the default list; #5 is
 * a long one (40 paragraphs).
 */

const num = (n: number) => `(#${String(n).padStart(3, "0")})`;
const readerArticle = (page: Page, n: number) => page.locator('[data-pane="reader"] article').filter({ hasText: num(n) });
const readerRoot = (page: Page) => page.locator('[data-pane="reader"] .ff-reader');
const topBar = (page: Page) => page.locator('[data-pane="reader"] .ff-reader-bar');

/** Opens article #n and waits until its body is in and the compact slide-in is over. */
async function openArticle(app: App, page: Page, n: number) {
  await app.open();
  await app.row(n).scrollIntoViewIfNeeded();
  await app.activate(app.row(n));
  await expect(readerArticle(page, n).locator(".article-content")).toBeVisible();
  // Compact: the pane slides in (320 ms); wide: a 140 ms content fade.
  if (app.isMobile) await expect.poll(async () => (await page.locator('[data-pane="reader"]').boundingBox())?.x).toBe(0);
  await page.waitForTimeout(200);
}

/** Scrolls the reader in small per-frame steps (like a finger / wheel), so scroll events see continuous movement. */
async function scrollReaderBy(scroller: Locator, total: number, step = 8) {
  await scroller.evaluate(
    async (el, { total, step }) => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: Math.sign(total) })); // counts as user interaction
      const n = Math.ceil(Math.abs(total) / step);
      for (let i = 0; i < n; i++) {
        el.scrollTop += Math.sign(total) * step;
        await frame();
      }
    },
    { total, step },
  );
}

test("tap → reader title is painted within 100 ms (User Timing ff:tap-to-title)", async ({ app, page }) => {
  await app.open();
  await page.evaluate(() => performance.clearMeasures("ff:tap-to-title"));
  await app.activate(app.row(2));
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(num(2).replace(/[()#]/g, "\\$&")) })).toBeVisible();
  const duration = await expect
    .poll(() => page.evaluate(() => performance.getEntriesByName("ff:tap-to-title")[0]?.duration ?? null), { timeout: 5_000 })
    .not.toBeNull()
    .then(() => page.evaluate(() => performance.getEntriesByName("ff:tap-to-title")[0]!.duration));
  test.info().annotations.push({ type: "tap-to-title", description: `${duration.toFixed(1)} ms` });
  expect(duration).toBeLessThanOrEqual(100);
  // The headline and body carry no entrance animation of their own (one entrance per open).
  const animated = await page.locator('[data-pane="reader"] article :is(h1, .article-content)').evaluateAll((els) =>
    els.filter((el) => getComputedStyle(el).animationName !== "none" || /\banimate-/.test(el.className)).length,
  );
  expect(animated).toBe(0);
});

test("top bar hides on scroll down, returns on scroll up; progress follows the scroll", async ({ app, page }) => {
  await openArticle(app, page, 5);
  const scroller = app.readerScroller();
  await expect(readerRoot(page)).toHaveAttribute("data-chrome", "shown");

  await scrollReaderBy(scroller, 400);
  await expect(readerRoot(page)).toHaveAttribute("data-chrome", "hidden");
  await expect.poll(async () => {
    const box = await topBar(page).boundingBox();
    return box ? Math.round(box.y + box.height) : 999;
  }).toBeLessThanOrEqual(1);

  await scrollReaderBy(scroller, -40, 5);
  await expect(readerRoot(page)).toHaveAttribute("data-chrome", "shown");
  await expect.poll(async () => Math.round((await topBar(page).boundingBox())?.y ?? -999)).toBeGreaterThanOrEqual(0);

  // Focus inside the bar keeps it visible (keyboard users never lose it).
  await scrollReaderBy(scroller, 200);
  await expect(readerRoot(page)).toHaveAttribute("data-chrome", "hidden");
  await topBar(page).getByRole("button", { name: "Back" }).focus();
  await expect(readerRoot(page)).toHaveAttribute("data-chrome", "shown");

  // Progress: 0 at the top … 1 at the end.
  const progress = () => readerRoot(page).evaluate((el) => Number(getComputedStyle(el).getPropertyValue("--reader-progress")));
  await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect.poll(progress).toBeGreaterThan(0.99);
  await expect(readerRoot(page)).toHaveAttribute("data-chrome", "shown"); // back at the end
  await scroller.evaluate((el) => (el.scrollTop = 0));
  await expect.poll(progress).toBeLessThan(0.01);
});

test("explicit previous / next step through the list without growing history; previous never acts as back", async ({ app, page }) => {
  await openArticle(app, page, 1);
  const bar = topBar(page);
  const prev = bar.getByRole("button", { name: "Previous article" });
  const next = bar.getByRole("button", { name: "Next article" });
  await expect(prev).toBeDisabled(); // first article of the list
  const before = await page.evaluate(() => history.length);

  await app.activate(next);
  await expect(readerArticle(page, 2)).toBeVisible();
  await expect.poll(() => app.where()).toBe(`/?a=${app.articleId(2)}`);
  await expect(readerArticle(page, 2)).toHaveAttribute("data-enter", "next");
  await app.activate(next);
  await expect(readerArticle(page, 3)).toBeVisible();
  await app.activate(prev);
  await expect(readerArticle(page, 2)).toBeVisible();
  await expect(readerArticle(page, 2)).toHaveAttribute("data-enter", "prev");
  await app.activate(prev);
  await expect(readerArticle(page, 1)).toBeVisible();
  await expect(prev).toBeDisabled();
  expect(await page.evaluate(() => history.length)).toBe(before);
  // The reader is still open: there is no "previous = back" fallback.
  await expect.poll(() => app.where()).toBe(`/?a=${app.articleId(1)}`);
});

test("compact: the action pill has five ≥44 px actions and no back/prev doubling", async ({ app, page, isMobile }) => {
  test.skip(!isMobile, "the pill is the compact layout");
  await openArticle(app, page, 1);
  const pill = page.locator('[data-pane="reader"] nav.ff-reader-pill');
  await expect(pill).toBeVisible();
  const buttons = pill.getByRole("button");
  await expect(buttons).toHaveCount(5);
  const names = await buttons.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
  expect(names).toEqual(["Star", expect.stringMatching(/^Mark as (read|unread)$/), "Save to Read Later", "Share", "More actions"]);
  for (const box of await buttons.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()))) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  // State shows on the toggles.
  await app.activate(pill.getByRole("button", { name: "Star" }));
  await expect(pill.getByRole("button", { name: "Remove star" })).toHaveAttribute("aria-pressed", "true");
  await app.activate(pill.getByRole("button", { name: "Remove star" }));
  await expect(pill.getByRole("button", { name: "Star" })).toHaveAttribute("aria-pressed", "false");
});

test("reopening an article restores its reading position; another article opens at the top", async ({ app, page }) => {
  await openArticle(app, page, 5);
  const scroller = app.readerScroller();
  await scrollReaderBy(scroller, 1200, 40);
  await scrollReaderBy(scroller, -40, 5); // a short scroll up brings the (hidden) bar back
  await expect(readerRoot(page)).toHaveAttribute("data-chrome", "shown");
  const saved = await scroller.evaluate((el) => el.scrollTop);
  expect(saved).toBeGreaterThan(1000);
  await page.waitForTimeout(400); // debounced save (250 ms)

  // Another article opens at the top …
  await app.activate(topBar(page).getByRole("button", { name: "Next article" }));
  await expect(readerArticle(page, 6)).toBeVisible();
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0);

  // … and #5 comes back where it was left, also after closing the reader and a reload.
  await app.activate(topBar(page).getByRole("button", { name: "Previous article" }));
  await expect(readerArticle(page, 5).locator(".article-content")).toBeVisible();
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(saved - 4);
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeLessThan(saved + 4);

  await page.reload();
  await expect(readerArticle(page, 5).locator(".article-content")).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(saved - 4);
});

test("Aa sheet: font, size, spacing, width and reader theme apply live and persist", async ({ app, page }) => {
  await openArticle(app, page, 1);
  const body = readerArticle(page, 1).locator(".article-content");
  const column = readerArticle(page, 1);
  const style = (loc: Locator, prop: string) => loc.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
  const sizeBefore = parseFloat(await style(column, "font-size"));
  const appBg = await style(page.locator("body"), "background-color");

  await app.activate(topBar(page).getByRole("button", { name: "Text appearance" }));
  const sheet = page.getByRole("dialog", { name: "Text appearance" });
  await expect(sheet).toBeVisible();

  await app.activate(sheet.getByRole("radio", { name: "Serif" }));
  await expect(sheet.getByRole("radio", { name: "Serif" })).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => style(body, "font-family")).toMatch(/Charter|Georgia/);
  await expect.poll(() => style(sheet.getByTestId("typography-preview"), "font-family")).toMatch(/Charter|Georgia/);

  await app.activate(sheet.getByRole("button", { name: "Larger text" }));
  await app.activate(sheet.getByRole("button", { name: "Larger text" }));
  await expect.poll(async () => parseFloat(await style(column, "font-size"))).toBe(sizeBefore + 2);
  await expect(sheet.getByTestId("typography-size")).toHaveText(`${sizeBefore + 2}px`);

  await app.activate(sheet.getByRole("radio", { name: "Airy" }));
  await expect.poll(async () => parseFloat(await style(body, "line-height")) / parseFloat(await style(body, "font-size"))).toBeCloseTo(1.8, 1);

  await app.activate(sheet.getByRole("radio", { name: "Narrow" }));
  await expect(readerRoot(page)).toHaveAttribute("data-reader-width", "narrow");

  await app.activate(sheet.getByRole("radio", { name: "Sepia" }));
  await expect(readerRoot(page)).toHaveAttribute("data-reader-theme", "sepia");
  await expect.poll(() => style(readerRoot(page), "background-color")).not.toBe(appBg);
  // The app theme itself is untouched.
  expect(await style(page.locator("body"), "background-color")).toBe(appBg);
  await expect(sheet).toBeVisible(); // all of it while the sheet stayed open

  // Persisted on this device: a reload of the deep link comes back styled.
  // The headline follows the font choice too.
  await expect.poll(() => style(readerArticle(page, 1).locator("h1"), "font-family")).toMatch(/Charter|Georgia/);
  // Esc closes just the sheet, never the reader behind it.
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(readerArticle(page, 1)).toBeVisible();
  await expect.poll(() => app.where()).toBe(`/?a=${app.articleId(1)}`);
  await page.reload();
  await expect(readerArticle(page, 1).locator(".article-content")).toBeVisible({ timeout: 30_000 });
  await expect(readerRoot(page)).toHaveAttribute("data-reader-theme", "sepia");
  await expect(readerRoot(page)).toHaveAttribute("data-reader-font", "serif");
  await expect.poll(async () => parseFloat(await style(readerArticle(page, 1), "font-size"))).toBe(sizeBefore + 2);

  // Reset brings every field back to its default.
  await app.activate(topBar(page).getByRole("button", { name: "Text appearance" }));
  await app.activate(page.getByRole("dialog", { name: "Text appearance" }).getByRole("button", { name: "Reset" }));
  await expect(readerRoot(page)).not.toHaveAttribute("data-reader-theme", /.+/);
  await expect(readerRoot(page)).toHaveAttribute("data-reader-font", "sans");
  expect(await page.evaluate(() => localStorage.getItem("ff:reader-typography"))).toBeNull();
});

/** Touch sequence on the reader scroller; returns the indicator state seen before the finger lifts. */
async function pullUp(page: Page, dy: number) {
  return page.locator('[data-pane="reader"] [data-testid="reader-scroller"]').evaluate(async (scroller, dy) => {
    const box = scroller.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y0 = box.top + box.height * 0.6;
    const target = document.elementFromPoint(x, y0) ?? scroller;
    const touch = (y: number) => new Touch({ identifier: 7, target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y });
    const fire = (type: string, y: number, ended = false) => {
      const t = touch(y);
      target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, composed: true, touches: ended ? [] : [t], targetTouches: ended ? [] : [t], changedTouches: [t] }));
    };
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    fire("touchstart", y0);
    for (let i = 1; i <= 12; i++) {
      fire("touchmove", y0 + (dy * i) / 12);
      await frame();
    }
    const indicator = document.querySelector<HTMLElement>('[data-testid="reader-pull"]');
    const seen = indicator?.dataset.pull ?? "missing";
    fire("touchend", y0 + dy, true);
    return seen;
  }, dy);
}

test("pull past the end of an article tracks an indicator and opens the next one", async ({ app, page, isMobile }) => {
  test.skip(!isMobile, "touch gesture (compact)");
  await openArticle(app, page, 2);
  const scroller = app.readerScroller();
  await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));

  // A short pull is tracked but does not commit.
  expect(await pullUp(page, -90)).toBe("tracking");
  await page.waitForTimeout(200);
  await expect(readerArticle(page, 2)).toBeVisible();
  await expect(page.getByTestId("reader-pull")).toHaveAttribute("data-pull", "idle");

  // Past the trigger distance it arms; releasing opens the next article.
  expect(await pullUp(page, -260)).toBe("armed");
  await expect(readerArticle(page, 3)).toBeVisible();
  await expect.poll(() => app.where()).toBe(`/?a=${app.articleId(3)}`);
});

test("pulling in the middle of an article does nothing", async ({ app, page, isMobile }) => {
  test.skip(!isMobile, "touch gesture (compact)");
  await openArticle(app, page, 5);
  await app.readerScroller().evaluate((el) => (el.scrollTop = 600));
  expect(await pullUp(page, -260)).toBe("idle");
  await page.waitForTimeout(300);
  await expect(readerArticle(page, 5)).toBeVisible();
});
