"use client";

import { springStep, type SpringState } from "./math";
import { prefersReducedMotion } from "./guards";

/**
 * Runs the release spring (k 320, c 32) from `x` (px) seeded with the release
 * velocity `v` (px/ms) towards 0, calling `write(x)` once per frame and
 * `done()` at rest. Reduced motion snaps. Returns a cancel function (which
 * does not call `done`).
 */
export function springBack(x: number, v: number, write: (x: number) => void, done: () => void): () => void {
  if (prefersReducedMotion() || Math.abs(x) < 0.5) {
    write(0);
    done();
    return () => {};
  }
  let state: SpringState | null = { x, v };
  let last = performance.now();
  let raf = 0;
  const frame = (now: number) => {
    if (!state) return;
    state = springStep(state, now - last);
    last = now;
    if (!state) {
      write(0);
      done();
      return;
    }
    write(state.x);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => {
    state = null;
    cancelAnimationFrame(raf);
  };
}
