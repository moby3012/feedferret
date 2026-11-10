"use client";

import { useSyncExternalStore } from "react";

// First-use gesture hint (owner decision 2026-11-10, audit B-04): touch rows
// have no action buttons, so the first list a touch device shows explains the
// gestures once — an animated swipe nudge on the first row plus a hint chip.
// Per device (localStorage); gone for good once dismissed or once a swipe /
// long-press was used. Settings → Lesen → Gesten can show it again.
//
//   ff:gesture-hint   "done" = dismissed / learned

export const GESTURE_HINT_KEY = "ff:gesture-hint";
//   ff:feeds-hint     the same for the Feeds screen ("long-press a feed for its actions")
export const FEEDS_HINT_KEY = "ff:feeds-hint";

/** One per-device "seen" flag in localStorage with a React subscription. */
function createHintFlag(key: string) {
  const listeners = new Set<() => void>();
  let snapshot: boolean | null = null;
  const read = (): boolean => {
    try {
      return window.localStorage.getItem(key) === "done";
    } catch {
      return false;
    }
  };
  const write = (done: boolean) => {
    try {
      if (done) window.localStorage.setItem(key, "done");
      else window.localStorage.removeItem(key);
    } catch {
      /* private mode: this page view only */
    }
    snapshot = done;
    for (const listener of [...listeners]) listener();
  };
  const subscribe = (onChange: () => void) => {
    listeners.add(onChange);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key) return;
      snapshot = read();
      onChange();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(onChange);
      window.removeEventListener("storage", onStorage);
    };
  };
  return {
    complete() {
      if (snapshot === true || (snapshot === null && read())) return;
      write(true);
    },
    reset: () => write(false),
    /** `true` while still due on this device; `false` on the server / during hydration. */
    useDue: (): boolean =>
      useSyncExternalStore(
        subscribe,
        () => !(snapshot ??= read()),
        () => false,
      ),
  };
}

const gestureHint = createHintFlag(GESTURE_HINT_KEY);
const feedsHint = createHintFlag(FEEDS_HINT_KEY);

/** The hint was dismissed or the gestures were used: never show it again on this device. */
export function completeGestureHint() {
  gestureHint.complete();
}

/** Settings: show the hint again next time a list is shown. */
export function resetGestureHint() {
  try {
    // Asked for explicitly: the nudge may play again too.
    window.sessionStorage.removeItem(GESTURE_NUDGE_KEY);
  } catch {
    /* ignore */
  }
  gestureHint.reset();
}

/** `true` while the hint is still due on this device; `false` on the server / during hydration. */
export function useGestureHintDue(): boolean {
  return gestureHint.useDue();
}

/** Feeds screen tip ("long-press a feed: actions") dismissed, or a feed menu was opened by a gesture. */
export function completeFeedsHint() {
  feedsHint.complete();
}

/** Settings → Gesten & Hilfe: show the Feeds screen tip again. */
export function resetFeedsHint() {
  feedsHint.reset();
}

export function useFeedsHintDue(): boolean {
  return feedsHint.useDue();
}

// The nudge (first row slides open once) plays at most once per browser
// session, even when the hint stays due across lists / reloads.
export const GESTURE_NUDGE_KEY = "ff:gesture-nudged";

/** Claims this session's one nudge: `true` the first time, `false` after (or when the claim cannot be stored). */
export function claimGestureNudge(): boolean {
  try {
    if (window.sessionStorage.getItem(GESTURE_NUDGE_KEY) === "1") return false;
    window.sessionStorage.setItem(GESTURE_NUDGE_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Rows without action buttons: a touch-first device with no hover-capable
 * input. A tablet / Chromebook with a mouse or trackpad attached keeps the
 * buttons (a mouse never swipes — lib/gestures/swipe-row.ts). Mirrors the
 * media query in app/styles/list.css.
 */
export const TOUCH_ROWS_QUERY = "(pointer: coarse) and (any-hover: none)";

function subscribeTouchRows(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const list = window.matchMedia(TOUCH_ROWS_QUERY);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}
const isTouchRows = () => typeof window.matchMedia === "function" && window.matchMedia(TOUCH_ROWS_QUERY).matches;

/** Rows are touch-only (no buttons, gestures only); `false` on the server and during hydration. */
export function useTouchRows(): boolean {
  return useSyncExternalStore(subscribeTouchRows, isTouchRows, () => false);
}
