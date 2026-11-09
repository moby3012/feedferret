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
export async function swipeOn(page: Page, locator: Locator, dx: number, dy = 0, offset?: { x?: number; y?: number }) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("swipeOn: element has no bounding box");
  // Wide content (code, long lines) can extend past the viewport: aim at the visible part.
  const vw = page.viewportSize()?.width ?? 390;
  const left = Math.max(box.x, 0);
  const right = Math.min(box.x + box.width, vw);
  const x = offset?.x !== undefined ? box.x + offset.x : left + (right - left) / 2;
  await swipeAt(page, { x, y: box.y + (offset?.y ?? box.height / 2) }, dx, dy);
}
