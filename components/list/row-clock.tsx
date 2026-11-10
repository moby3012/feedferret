"use client";

import { createContext, createElement, useContext, useSyncExternalStore, type ReactNode } from "react";

// "Now" for the rows' relative times ("5 Min."). The server renders the rows
// (cold-start bootstrap), so the first client render must use the SAME now as
// the server or the text differs and hydration fails (React #418). The
// request time comes down as a prop; hydration renders with it, then the
// shared minute clock takes over (one interval for all rows, only while rows
// are mounted).

const ServerNow = createContext<number | null>(null);

export function RowClockProvider({ now, children }: { now: number; children: ReactNode }) {
  return createElement(ServerNow.Provider, { value: now }, children);
}

const TICK_MS = 60_000;
let current = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    timer = setInterval(() => {
      current = Date.now();
      listeners.forEach((l) => l());
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot() {
  // Cached: stable between the calls of one render, refreshed once a minute.
  const t = Date.now();
  if (t - current >= TICK_MS) current = t;
  return current;
}

/** Current time for row labels: the server's request time while hydrating, then a minute clock. */
export function useRowNow(): Date {
  const serverNow = useContext(ServerNow);
  const now = useSyncExternalStore(subscribe, getSnapshot, () => serverNow ?? getSnapshot());
  return new Date(now);
}
