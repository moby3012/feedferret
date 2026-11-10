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

const listeners = new Set<() => void>();
let snapshot: boolean | null = null;

function read(): boolean {
  try {
    return window.localStorage.getItem(GESTURE_HINT_KEY) === "done";
  } catch {
    return false;
  }
}

function write(done: boolean) {
  try {
    if (done) window.localStorage.setItem(GESTURE_HINT_KEY, "done");
    else window.localStorage.removeItem(GESTURE_HINT_KEY);
  } catch {
    /* private mode: this page view only */
  }
  snapshot = done;
  for (const listener of [...listeners]) listener();
}

/** The hint was dismissed or the gestures were used: never show it again on this device. */
export function completeGestureHint() {
  if (snapshot === true || (snapshot === null && read())) return;
  write(true);
}

/** Settings: show the hint again next time a list is shown. */
export function resetGestureHint() {
  write(false);
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== GESTURE_HINT_KEY) return;
    snapshot = read();
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** `true` while the hint is still due on this device; `false` on the server / during hydration. */
export function useGestureHintDue(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !(snapshot ??= read()),
    () => false,
  );
}
