// Pure decision logic of the reader's interactive swipe-back (no DOM):
// unit-tested in tests/lib/back-swipe-math.test.ts. The DOM side lives in
// lib/gestures/back-swipe.ts; constants are shared with the list rows
// (lib/gestures/math.ts) so both gestures feel the same.

import { COMMIT_RATIO, FLICK_MIN_PX, FLICK_VELOCITY, inEdgeInset } from "./math";

/** How far the list underneath lags behind (share of the width) at the start of the drag. */
export const BACK_PARALLAX_RATIO = 0.25;
/** Opacity of the shade (var(--scrim)) over the list at the start of the drag; fades to 0 at full travel. */
export const BACK_SHADE_MAX = 0.4;
/** A swipe towards inline-start barely moves the reader (it has no action). */
export const BACK_WRONG_WAY_MAX_PX = 12;
export const BACK_WRONG_WAY_RATE = 0.15;

export interface BackSwipeEnvironment {
  /** iOS / iPadOS (WebKit on a touch device). */
  ios: boolean;
  /** Installed web app (`display-mode: standalone` / `navigator.standalone`). */
  standalone: boolean;
}

/**
 * Whether the OS (browser) owns a back gesture from the screen edges here:
 * iOS Safari in a tab and Android both do; an iOS home-screen web app has no
 * reliable system back swipe (.pm/research-native-pwa.md §1.2), so there the
 * reader handles edge starts too.
 */
export function osOwnsEdgeBack(env: BackSwipeEnvironment): boolean {
  return !(env.ios && env.standalone);
}

/** Start-point rule: everywhere, except in the OS back-gesture band where the OS owns it. */
export function backSwipeMayStart(clientX: number, viewportWidth: number, env: BackSwipeEnvironment): boolean {
  if (!osOwnsEdgeBack(env)) return true;
  return !inEdgeInset(clientX, viewportWidth);
}

/**
 * Reader offset for a finger delta along the inline axis (+ = towards
 * inline-end, i.e. "back"): 1:1 and never past the width; the other way it
 * only twitches (≤12 px) — a left swipe does nothing.
 */
export function backSwipeTravel(d: number, width: number): number {
  if (d >= 0) return Math.min(d, Math.max(0, width));
  return -Math.min(-d * BACK_WRONG_WAY_RATE, BACK_WRONG_WAY_MAX_PX);
}

/** 0…1 share of the width the reader has moved (drives parallax + shade). */
export function backSwipeProgress(travel: number, width: number): number {
  if (width <= 0 || travel <= 0) return 0;
  return Math.min(1, travel / width);
}

/** Release decision: past 35 % of the width, or a forward flick. Never for a wrong-way or zero drag. */
export function shouldCommitBack(d: number, velocity: number, width: number): boolean {
  if (d <= 0) return false;
  if (d >= width * COMMIT_RATIO) return true;
  return velocity >= FLICK_VELOCITY && d >= FLICK_MIN_PX;
}

/** Armed = releasing now commits by distance alone (haptic tick). */
export function isBackArmed(d: number, width: number): boolean {
  return d > 0 && d >= width * COMMIT_RATIO;
}

/** Offset of the list underneath (negative = towards inline-start) for a progress 0…1. */
export function backParallaxOffset(progress: number, width: number): number {
  return -BACK_PARALLAX_RATIO * width * (1 - Math.min(1, Math.max(0, progress)));
}

/** Shade opacity over the list for a progress 0…1. */
export function backShadeOpacity(progress: number): number {
  return BACK_SHADE_MAX * (1 - Math.min(1, Math.max(0, progress)));
}

/** Reduced motion: the reader does not move; it fades towards this opacity at the commit distance. */
export function backReducedOpacity(d: number, width: number): number {
  if (d <= 0 || width <= 0) return 1;
  return 1 - 0.5 * Math.min(1, d / (width * COMMIT_RATIO));
}

/** Duration (ms) of the commit slide for the remaining distance at the release velocity (px/ms), 120…220 ms. */
export function backCommitDuration(remaining: number, velocity: number): number {
  const v = Math.max(velocity, 1.2); // a slow release still finishes briskly
  return Math.round(Math.min(220, Math.max(120, remaining / v)));
}

/** UA sniff for the environment (kept here so the rule above stays testable). */
export function detectBackSwipeEnvironment(nav: { userAgent: string; maxTouchPoints: number; standalone?: boolean }, standaloneQuery: boolean): BackSwipeEnvironment {
  const ios = /iP(hone|ad|od)/.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1);
  return { ios, standalone: standaloneQuery || nav.standalone === true };
}
