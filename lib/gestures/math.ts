// Pure gesture math (spec §5). No DOM: unit-tested in tests/lib/gestures-math.test.ts.

/** Movement (px) before any decision is made (axis, long-press cancel). */
export const SLOP_PX = 10;
/** Horizontal wins iff |dx| > AXIS_LOCK_RATIO · |dy| when the slop is first exceeded. */
export const AXIS_LOCK_RATIO = 1.5;
/** Commit distance as a share of the row width. */
export const COMMIT_RATIO = 0.35;
/** Travel cap as a share of the row width. */
export const MAX_TRAVEL_RATIO = 0.6;
/** Resistance past the commit distance. */
export const RUBBER_BAND = 0.35;
/** A direction without an action follows the finger at this rate, up to NO_ACTION_MAX_PX. */
export const NO_ACTION_RATE = 0.2;
export const NO_ACTION_MAX_PX = 24;
/** Flick: |v| ≥ FLICK_VELOCITY px/ms and |dx| ≥ FLICK_MIN_PX in the same direction commits. */
export const FLICK_VELOCITY = 0.5;
export const FLICK_MIN_PX = 24;
/** Velocity is measured over the samples of the last VELOCITY_WINDOW_MS. */
export const VELOCITY_WINDOW_MS = 100;
/** Long-press: hold time and movement tolerance. */
export const LONG_PRESS_MS = 450;
/** No swipe starts within this long after the scroller's last `scroll` (momentum). */
export const SCROLL_GUARD_MS = 100;
/** Width of the screen-edge band owned by the OS back gesture. */
export const EDGE_INSET_PX = 24;

export type Axis = "x" | "y" | null;

/**
 * Axis decision for a movement of (dx, dy) from the start point: `null` while
 * still inside the slop, `"x"` when horizontal clearly dominates (a 30° drift
 * off vertical — |dx|/|dy| ≈ 0.58 — always resolves to `"y"`).
 */
export function decideAxis(dx: number, dy: number, slop = SLOP_PX, ratio = AXIS_LOCK_RATIO): Axis {
  if (Math.hypot(dx, dy) <= slop) return null;
  return Math.abs(dx) > ratio * Math.abs(dy) ? "x" : "y";
}

/** True when a pointer starting at `clientX` lies in the OS back-gesture band of either edge. */
export function inEdgeInset(clientX: number, viewportWidth: number, inset = EDGE_INSET_PX): boolean {
  return clientX < inset || clientX > viewportWidth - inset;
}

/**
 * Visual offset for a raw finger delta: 1:1 up to the commit distance, then
 * rubber band, capped at 60 % of the row width. A direction without an action
 * barely moves (×0.2, ≤24 px) so the row still feels alive.
 */
export function swipeTravel(dx: number, width: number, hasAction: boolean): number {
  const sign = Math.sign(dx);
  const abs = Math.abs(dx);
  if (!hasAction) return sign * Math.min(abs * NO_ACTION_RATE, NO_ACTION_MAX_PX);
  const commit = width * COMMIT_RATIO;
  const max = width * MAX_TRAVEL_RATIO;
  const out = abs <= commit ? abs : commit + (abs - commit) * RUBBER_BAND;
  return sign * Math.min(out, max);
}

/** Progress towards the commit distance, 0…1 (drives the reveal tint / icon). */
export function swipeProgress(dx: number, width: number): number {
  const commit = width * COMMIT_RATIO;
  if (commit <= 0) return 0;
  return Math.min(1, Math.abs(dx) / commit);
}

export interface Sample {
  x: number;
  t: number;
}

/**
 * px/ms over the samples of the last `windowMs` (needs ≥2 samples in the
 * window, else 0). Positive = towards +x.
 */
export function velocityOf(samples: readonly Sample[], windowMs = VELOCITY_WINDOW_MS): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > windowMs) break;
    first = samples[i];
  }
  const dt = last.t - first.t;
  if (first === last || dt <= 0) return 0;
  return (last.x - first.x) / dt;
}

/** Release decision: distance past 35 % of the width, or a flick in the same direction. */
export function shouldCommit(dx: number, velocity: number, width: number): boolean {
  if (dx === 0) return false;
  if (Math.abs(dx) >= width * COMMIT_RATIO) return true;
  return Math.abs(velocity) >= FLICK_VELOCITY && Math.abs(dx) >= FLICK_MIN_PX && Math.sign(velocity) === Math.sign(dx);
}

/** Armed = releasing now would commit by distance alone (drives the haptic tick + solid fill). */
export function isArmed(dx: number, width: number): boolean {
  return Math.abs(dx) >= width * COMMIT_RATIO;
}

// ---------------------------------------------------------------- spring

export const SPRING = { stiffness: 320, damping: 32, mass: 1 } as const;
const REST_X = 0.5; // px
const REST_V = 0.05; // px/ms

export interface SpringState {
  x: number;
  /** px/ms */
  v: number;
}

/**
 * One semi-implicit Euler step of a damped spring towards 0 (k 320, c 32,
 * m 1). `dtMs` is clamped to 32 ms so a dropped frame cannot explode it.
 * Returns `null` once at rest (<0.5 px and <0.05 px/ms).
 */
export function springStep(s: SpringState, dtMs: number, spring = SPRING): SpringState | null {
  const dt = Math.min(Math.max(dtMs, 0), 32) / 1000; // s
  const v = s.v * 1000; // px/s
  const a = (-spring.stiffness * s.x - spring.damping * v) / spring.mass;
  const nv = v + a * dt;
  const nx = s.x + nv * dt;
  const next = { x: nx, v: nv / 1000 };
  if (Math.abs(next.x) < REST_X && Math.abs(next.v) < REST_V) return null;
  return next;
}

// ---------------------------------------------------------------- pull

export const PULL_RESISTANCE = 0.45;
export const PULL_TRIGGER_PX = 64;
export const PULL_MAX_PX = 96;

/** Pull distance after resistance, capped. */
export function pullDistance(dy: number): number {
  if (dy <= 0) return 0;
  return Math.min(PULL_MAX_PX, dy * PULL_RESISTANCE);
}
