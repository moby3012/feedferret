import type { Locator, Page } from "@playwright/test";

/**
 * Dispatches a real (synthetic-but-trusted-enough) touch sequence
 * touchstart -> touchmove(s) -> touchend on whatever element sits at the start
 * point. Playwright's touchscreen only supports taps, and the app's gestures
 * are hand-rolled `touch*` handlers, so this is the way to drive swipes.
 * Works in both projects (Chromium exposes Touch/TouchEvent on desktop too).
 */
export async function swipeAt(page: Page, from: { x: number; y: number }, dx: number, dy = 0, steps = 6) {
  await page.evaluate(
    ({ from, dx, dy, steps }) => {
      const target = document.elementFromPoint(from.x, from.y);
      if (!target) throw new Error(`no element at ${from.x},${from.y}`);
      const point = (x: number, y: number) =>
        new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y });
      const fire = (type: string, x: number, y: number, ended = false) => {
        const t = point(x, y);
        target.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            touches: ended ? [] : [t],
            targetTouches: ended ? [] : [t],
            changedTouches: [t],
          }),
        );
      };
      fire("touchstart", from.x, from.y);
      for (let i = 1; i <= steps; i++) fire("touchmove", from.x + (dx * i) / steps, from.y + (dy * i) / steps);
      fire("touchend", from.x + dx, from.y + dy, true);
    },
    { from, dx, dy, steps },
  );
}

/** Swipe horizontally starting at the centre of `locator` (or an offset inside it). */
/** Waits until the element stops moving (e.g. the mobile reader slide-in animation). */
async function stableBox(page: Page, locator: Locator) {
  let prev = await locator.boundingBox();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(50);
    const next = await locator.boundingBox();
    if (prev && next && prev.x === next.x && prev.y === next.y && prev.width === next.width && prev.height === next.height) return next;
    prev = next;
  }
  return prev;
}

export async function swipeOn(page: Page, locator: Locator, dx: number, dy = 0, offset?: { x?: number; y?: number }) {
  const box = await stableBox(page, locator);
  if (!box) throw new Error("swipeOn: element has no bounding box");
  const vh = page.viewportSize()?.height ?? 844;
  // Wide content (code, long lines) can extend past the viewport: aim at the visible part.
  const vw = page.viewportSize()?.width ?? 390;
  const left = Math.max(box.x, 0);
  const right = Math.min(box.x + box.width, vw);
  const x = offset?.x !== undefined ? box.x + offset.x : left + (right - left) / 2;
  const top = Math.max(box.y, 0);
  const bottom = Math.min(box.y + box.height, vh);
  const y = offset?.y !== undefined ? box.y + offset.y : top + (bottom - top) / 2;
  await swipeAt(page, { x, y }, dx, dy);
}

// --- Real touch input (CDP) -------------------------------------------------
// The list gestures run on Pointer Events (lib/gestures), which synthetic
// TouchEvents never produce. CDP `Input.dispatchTouchEvent` goes through the
// browser's input pipeline: pointer + touch streams, `touch-action`, native
// scrolling and `pointercancel` all behave as on a device.

type Point = { x: number; y: number };

async function touchSession(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const hasTouch = await page.evaluate(() => navigator.maxTouchPoints > 0);
  if (!hasTouch) await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  return cdp;
}

/**
 * One finger from `from` by (dx, dy) in `steps` moves, `stepMs` apart (≈ a
 * 60 Hz digitizer at 16 ms), then lift. `holdMs` waits before moving.
 */
export async function touchDrag(page: Page, from: Point, dx: number, dy = 0, opts: { steps?: number; stepMs?: number; holdMs?: number } = {}) {
  const { steps = 10, stepMs = 16, holdMs = 0 } = opts;
  const cdp = await touchSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
    if (holdMs) await page.waitForTimeout(holdMs);
    for (let i = 1; i <= steps; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: from.x + (dx * i) / steps, y: from.y + (dy * i) / steps, id: 1 }],
      });
      if (stepMs) await page.waitForTimeout(stepMs);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Long-press (finger down, still, `ms`, lift). */
export async function touchHold(page: Page, at: Point, ms = 650) {
  const cdp = await touchSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: at.x, y: at.y, id: 1 }] });
    await page.waitForTimeout(ms);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Swipe a row horizontally with real touch input, starting `offsetX` px into it (default: its centre). */
export async function touchSwipeOn(page: Page, locator: Locator, dx: number, opts: { offsetX?: number; dy?: number; steps?: number; stepMs?: number } = {}) {
  await locator.scrollIntoViewIfNeeded();
  // Let the scroll's momentum guard (100 ms) pass: a swipe right after a scroll is ignored by design.
  await page.waitForTimeout(150);
  const box = await stableBox(page, locator);
  if (!box) throw new Error("touchSwipeOn: element has no bounding box");
  const x = opts.offsetX !== undefined ? box.x + opts.offsetX : box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 40);
  await touchDrag(page, { x, y }, dx, opts.dy ?? 0, { steps: opts.steps, stepMs: opts.stepMs });
}

/** Long-press on `locator` (scrolled into view first), `dy` px below its top edge. */
export async function touchHoldOn(page: Page, locator: Locator, dy = 30, ms = 650) {
  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const box = await stableBox(page, locator);
  if (!box) throw new Error("touchHoldOn: element has no bounding box");
  await touchHold(page, { x: box.x + box.width / 2, y: box.y + Math.min(dy, box.height / 2) }, ms);
}
