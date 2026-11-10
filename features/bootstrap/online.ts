"use client";

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

export function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/** `navigator.onLine` as React state; `true` during SSR / hydration (render never depends on it before mount). */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, isOnline, () => true);
}
