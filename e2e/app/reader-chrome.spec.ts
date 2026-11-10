import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { setUserSettings } from "../helpers/db";
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
  expect(await uiCookie(page)).not.toHaveProperty("rt");
});

/** The `ff_ui` cookie (device prefs, server-readable) as the browser holds it. */
async function uiCookie(page: Page): Promise<Record<string, unknown>> {
  const raw = (await page.context().cookies()).find((c) => c.name === "ff_ui")?.value;
  return raw ? JSON.parse(decodeURIComponent(raw)) : {};
}

async function setReaderTypographyCookie(page: Page, rt: Record<string, unknown> | null) {
  const current = await uiCookie(page);
  if (rt) current.rt = rt;
  else delete current.rt;
  await page.context().addCookies([{ name: "ff_ui", value: encodeURIComponent(JSON.stringify(current)), url: test.info().project.use.baseURL! }]);
}

test("non-default Aa prefs are rendered on the server: no restyle or layout shift of the body across hydration", async ({ app, page }) => {
  const rt = { font: "serif", size: 21, leading: 1.8, width: "narrow", theme: "sepia" };
  await setReaderTypographyCookie(page, rt);
  try {
    const href = `/?a=${app.articleId(5)}`;
    // 1) The server HTML already carries the typography on the reader root.
    const html = await (await page.request.get(href)).text();
    const root = html.match(/<[^>]*class="[^"]*ff-reader[ "][^>]*>/)?.[0] ?? "";
    expect(root).toContain('data-reader-font="serif"');
    expect(root).toContain('data-reader-width="narrow"');
    expect(root).toContain('data-reader-theme="sepia"');
    expect(root).toMatch(/--reader-size-user:\s*21px/);
    expect(root).toMatch(/--reader-leading-user:\s*1\.8/);

    // 2) In the browser: watch the reader root + body from the first parsed byte.
    await page.addInitScript(() => {
      const w = window as unknown as { __rt: { mutations: string[]; shifts: number; firstRect: string | null } };
      w.__rt = { mutations: [], shifts: 0, firstRect: null };
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) w.__rt.shifts += e.value;
        }).observe({ type: "layout-shift", buffered: true });
      } catch {
        /* layout-shift unsupported */
      }
      const watch = new MutationObserver(() => {
        const rootEl = document.querySelector('[data-pane="reader"] .ff-reader');
        const body = rootEl?.querySelector(".article-content");
        if (!rootEl || !body) return;
        watch.disconnect();
        const r = body.getBoundingClientRect();
        w.__rt.firstRect = `${Math.round(r.left)},${Math.round(r.width)}`;
        // Typography = the data-reader-* attributes, the `.dark` scope and the --reader-*-user/-delta
        // properties (the scroll hook's --reader-progress / data-chrome are not typography).
        const typo = (el: HTMLElement) =>
          ["--reader-size-user", "--reader-size-delta", "--reader-leading-user"].map((p) => `${p}:${el.style.getPropertyValue(p)}`).join(";") +
          `|dark=${el.classList.contains("dark")}`;
        const first = typo(rootEl as HTMLElement);
        new MutationObserver((ms) => {
          for (const m of ms) {
            if (m.attributeName?.startsWith("data-reader-")) w.__rt.mutations.push(`${m.attributeName}=${(m.target as Element).getAttribute(m.attributeName)}`);
            else if (typo(rootEl as HTMLElement) !== first) w.__rt.mutations.push(`${first} → ${typo(rootEl as HTMLElement)}`);
          }
        }).observe(rootEl, { attributes: true, attributeFilter: ["data-reader-font", "data-reader-width", "data-reader-theme", "style", "class"] });
      });
      watch.observe(document, { childList: true, subtree: true });
    });
    await page.goto(href);
    await expect(readerArticle(page, 5).locator(".article-content")).toBeVisible({ timeout: 30_000 });
    await expect(readerRoot(page)).toHaveAttribute("data-reader-font", "serif");
    // Hydrated (the chrome is client-only) and settled.
    await expect(topBar(page).getByRole("button", { name: "Text appearance" })).toBeVisible();
    await page.waitForTimeout(500);
    const seen = await page.evaluate(() => (window as unknown as { __rt: { mutations: string[]; shifts: number; firstRect: string | null } }).__rt);
    const body = await readerArticle(page, 5).locator(".article-content").boundingBox();
    expect(seen.firstRect).toBe(`${Math.round(body!.x)},${Math.round(body!.width)}`);
    // The typography attributes of the root never change after the server rendered them.
    expect(seen.mutations).toEqual([]);
    expect(seen.shifts).toBeLessThan(0.01);
  } finally {
    await setReaderTypographyCookie(page, null);
  }
});

test("Aa sheet: the account width 'Full' is represented and keyboard reachable", async ({ app, page }) => {
  setUserSettings(app.userKey, { readerWidth: "full" });
  try {
    await openArticle(app, page, 1);
    await expect(readerRoot(page)).toHaveAttribute("data-reader-width", "full");
    await app.activate(topBar(page).getByRole("button", { name: "Text appearance" }));
    const sheet = page.getByRole("dialog", { name: "Text appearance" });
    const widths = sheet.getByRole("radiogroup", { name: "Line width" });
    const full = widths.getByRole("radio", { name: "Full" });
    await expect(full).toHaveAttribute("aria-checked", "true");
    await expect(full).toHaveAttribute("tabindex", "0");
    // Every radiogroup in the sheet has exactly one tab stop.
    const stops = await sheet.getByRole("radiogroup").evaluateAll((groups) => groups.map((g) => g.querySelectorAll('[role="radio"][tabindex="0"]').length));
    expect(stops.every((n) => n === 1)).toBe(true);
    // Keyboard: focus the group's tab stop, arrows move the choice.
    await full.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(widths.getByRole("radio", { name: "Wide" })).toHaveAttribute("aria-checked", "true");
    await expect(widths.getByRole("radio", { name: "Wide" })).toBeFocused();
    await expect(readerRoot(page)).toHaveAttribute("data-reader-width", "wide");
    // Contrast is measured on the settled sheet (not mid fade-in / colour transition).
    await page.locator(".ff-aa-sheet").evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
    const axe = await new AxeBuilder({ page }).include(".ff-aa-sheet").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((x) => `${x.target.join(" ")} — ${x.failureSummary}`).join("\n")}`)).toEqual([]);
    await app.activate(sheet.getByRole("button", { name: "Reset" }));
    await expect(readerRoot(page)).toHaveAttribute("data-reader-width", "full");
  } finally {
    setUserSettings(app.userKey, { readerWidth: "normal" });
  }
});

/** Touch sequence on the reader scroller; returns the indicator state seen before the finger lifts. */
async function pullUp(page: Page, dy: number, o: { dx?: number; startIn?: string } = {}) {
  return page.locator('[data-pane="reader"] [data-testid="reader-scroller"]').evaluate(async (scroller, { dy, dx, startIn }) => {
    const box = scroller.getBoundingClientRect();
    const x0 = box.left + box.width / 2;
    const y0 = box.top + box.height * 0.6;
    const target = (startIn && scroller.querySelector(startIn)) || document.elementFromPoint(x0, y0) || scroller;
    const touch = (x: number, y: number) => new Touch({ identifier: 7, target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y });
    const fire = (type: string, x: number, y: number, ended = false) => {
      const t = touch(x, y);
      target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, composed: true, touches: ended ? [] : [t], targetTouches: ended ? [] : [t], changedTouches: [t] }));
    };
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    fire("touchstart", x0, y0);
    // Sideways first (dx): the first moves go horizontal only, then the vertical pull follows.
    const steps = [...(dx ? [1, 2, 3].map((i) => [x0 + (dx * i) / 3, y0]) : []), ...Array.from({ length: 12 }, (_, i) => [x0 + (dx ?? 0), y0 + (dy * (i + 1)) / 12])];
    for (const [x, y] of steps) {
      fire("touchmove", x, y);
      await frame();
    }
    const indicator = document.querySelector<HTMLElement>('[data-testid="reader-pull"]');
    const seen = indicator?.dataset.pull ?? "missing";
    fire("touchend", x0 + (dx ?? 0), y0 + dy, true);
    return seen;
  }, { dy, dx: o.dx, startIn: o.startIn });
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

test("a pull that starts in a code block or goes sideways first does not navigate", async ({ app, page, isMobile }) => {
  test.skip(!isMobile, "touch gesture (compact)");
  await openArticle(app, page, 2);
  const scroller = app.readerScroller();
  // A code block at the end of the article (pannable content: it scrolls sideways on its own).
  await readerArticle(page, 2)
    .locator(".article-content")
    .evaluate((el) => {
      const pre = document.createElement("pre");
      pre.dataset.testid = "e2e-pre";
      pre.textContent = "const x = 1;".repeat(40);
      el.appendChild(pre);
    });
  await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));

  expect(await pullUp(page, -260, { startIn: '[data-testid="e2e-pre"]' })).toBe("idle");
  expect(await pullUp(page, -260, { dx: 40 })).toBe("idle");
  await page.waitForTimeout(300);
  await expect(readerArticle(page, 2)).toBeVisible();
  await expect.poll(() => app.where()).toBe(`/?a=${app.articleId(2)}`);
});
