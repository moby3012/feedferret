import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// lib/gestures/coach.ts: the one-time gesture hint is due until dismissed /
// learned, per device (localStorage), and can be shown again from settings.

function fakeWindow() {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  return { store, win: { localStorage, addEventListener: () => {}, removeEventListener: () => {} } };
}

describe("gesture hint store", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("is due on a fresh device, retired for good by completeGestureHint, due again after reset", async () => {
    const { store, win } = fakeWindow();
    vi.stubGlobal("window", win);
    const coach = await import("@/lib/gestures/coach");
    expect(store.get(coach.GESTURE_HINT_KEY)).toBeUndefined();
    coach.completeGestureHint();
    expect(store.get(coach.GESTURE_HINT_KEY)).toBe("done");
    coach.completeGestureHint(); // idempotent
    expect(store.get(coach.GESTURE_HINT_KEY)).toBe("done");
    coach.resetGestureHint();
    expect(store.has(coach.GESTURE_HINT_KEY)).toBe(false);
  });

  it("a device that already learned the gestures keeps it retired", async () => {
    const { store, win } = fakeWindow();
    store.set("ff:gesture-hint", "done");
    vi.stubGlobal("window", win);
    const coach = await import("@/lib/gestures/coach");
    const setItem = vi.spyOn(win.localStorage, "setItem");
    coach.completeGestureHint();
    expect(setItem).not.toHaveBeenCalled();
  });
});
