"use client";

import { useSyncExternalStore } from "react";

// Per-device gesture preferences (spec §1.6: haptics live in localStorage and
// are read after mount only). Swipe mapping is per device too: gestures are a
// property of the hand + screen, not of the account.
//
//   ff:haptics      "0" = off (default on)
//   ff:swipe-end    action for a swipe towards inline-end (→ in LTR); default "read"
//   ff:swipe-start  action for a swipe towards inline-start (← in LTR); default "later"

export type SwipeActionId = "read" | "later" | "star" | "none";
export const SWIPE_ACTIONS: readonly SwipeActionId[] = ["read", "later", "star", "none"];

export interface GesturePrefs {
  haptics: boolean;
  swipeEnd: SwipeActionId;
  swipeStart: SwipeActionId;
}

export const DEFAULT_GESTURE_PREFS: GesturePrefs = { haptics: true, swipeEnd: "read", swipeStart: "later" };

const KEYS = { haptics: "ff:haptics", swipeEnd: "ff:swipe-end", swipeStart: "ff:swipe-start" } as const;

const listeners = new Set<() => void>();
let snapshot: GesturePrefs | null = null;

function isAction(value: unknown): value is SwipeActionId {
  return typeof value === "string" && (SWIPE_ACTIONS as readonly string[]).includes(value);
}

function read(): GesturePrefs {
  try {
    const ls = window.localStorage;
    const end = ls.getItem(KEYS.swipeEnd);
    const start = ls.getItem(KEYS.swipeStart);
    return {
      haptics: ls.getItem(KEYS.haptics) !== "0",
      swipeEnd: isAction(end) ? end : DEFAULT_GESTURE_PREFS.swipeEnd,
      swipeStart: isAction(start) ? start : DEFAULT_GESTURE_PREFS.swipeStart,
    };
  } catch {
    return DEFAULT_GESTURE_PREFS;
  }
}

/** Current prefs (defaults on the server and before the first client read). */
export function getGesturePrefs(): GesturePrefs {
  if (typeof window === "undefined") return DEFAULT_GESTURE_PREFS;
  snapshot ??= read();
  return snapshot;
}

export function setGesturePref<K extends keyof GesturePrefs>(key: K, value: GesturePrefs[K]) {
  try {
    const raw = key === "haptics" ? (value ? "1" : "0") : String(value);
    window.localStorage.setItem(KEYS[key], raw);
  } catch {
    /* private mode: keep it for this page only */
  }
  snapshot = { ...getGesturePrefs(), [key]: value };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key && !Object.values(KEYS).includes(e.key as (typeof KEYS)[keyof typeof KEYS])) return;
    snapshot = read();
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Gesture prefs as React state; the server snapshot is the defaults (hydration-safe). */
export function useGesturePrefs(): GesturePrefs {
  return useSyncExternalStore(subscribe, getGesturePrefs, () => DEFAULT_GESTURE_PREFS);
}
