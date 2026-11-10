"use client";

import { SCROLL_GUARD_MS } from "./math";

export { startsInPannableContent, startsAtSystemEdge, SYSTEM_EDGE_PX } from "@/lib/gesture-guards";

// Shared arbitration state of the gesture module (spec §5 "Ownership"): one
// owner per pointer sequence, module-wide. A second pointer cancels the active
// gesture; a lock on one axis excludes the other gesture for that sequence.

export interface GestureOwner {
  kind: "swipe" | "pull";
  cancel(): void;
}

let active: GestureOwner | null = null;

export function activeGesture(): GestureOwner | null {
  return active;
}

/** Claims the sequence. Returns false when another gesture already owns it. */
export function claimGesture(owner: GestureOwner): boolean {
  if (active && active !== owner) return false;
  active = owner;
  return true;
}

export function releaseGesture(owner: GestureOwner) {
  if (active === owner) active = null;
}

/** Cancels whatever gesture is running (second pointer, visibility change). */
export function cancelActiveGesture() {
  const current = active;
  active = null;
  current?.cancel();
}

// --- pointer tracking: every pointer down anywhere in the document, so a
// second finger cancels the running gesture even when it lands outside the
// row (or the scroller) that owns the first one.

const pointersDown = new Set<number>();
/** Sequences that started but have not claimed yet (pending swipe, tracking pull). */
const watchers = new Set<() => void>();
let pointerListening = false;

function ensurePointerListener() {
  if (pointerListening || typeof document === "undefined") return;
  pointerListening = true;
  const down = (e: PointerEvent) => {
    // A primary pointer starts a new sequence: forget pointers whose up we missed.
    if (e.isPrimary) pointersDown.clear();
    pointersDown.add(e.pointerId);
    if (pointersDown.size > 1) {
      cancelActiveGesture();
      for (const cancel of [...watchers]) cancel();
    }
  };
  const up = (e: PointerEvent) => {
    pointersDown.delete(e.pointerId);
  };
  // Capture on the document: runs before any row handler, sees captured pointers too.
  document.addEventListener("pointerdown", down, { capture: true, passive: true });
  document.addEventListener("pointerup", up, { capture: true, passive: true });
  document.addEventListener("pointercancel", up, { capture: true, passive: true });
}

/** Number of pointers currently down in the document. */
export function pointersDownCount(): number {
  ensurePointerListener();
  return pointersDown.size;
}

/**
 * Registers a started (not yet claimed) sequence: a second pointer anywhere
 * calls `cancel`. Returns the unregister function.
 */
export function watchSequence(cancel: () => void): () => void {
  ensurePointerListener();
  watchers.add(cancel);
  return () => {
    watchers.delete(cancel);
  };
}

/** Installs the document listeners early (gesture module setup). */
export function initGestureTracking() {
  ensurePointerListener();
  ensureScrollListener();
}

/** Test hook: forget all tracked pointers and watchers. */
export function resetGestureTracking() {
  pointersDown.clear();
  watchers.clear();
  active = null;
}

// --- scroll guard: no swipe starts within 100 ms of the last scroll (momentum)

let lastScrollAt = -Infinity;
let scrollListening = false;

function ensureScrollListener() {
  if (scrollListening || typeof document === "undefined") return;
  scrollListening = true;
  // Capture: `scroll` does not bubble, but capturing at the document sees every scroller.
  document.addEventListener("scroll", () => (lastScrollAt = performance.now()), { capture: true, passive: true });
}

/** True while a scroller moved within the last SCROLL_GUARD_MS (momentum scroll still running). */
export function recentlyScrolled(now = performance.now()): boolean {
  ensureScrollListener();
  return now - lastScrollAt < SCROLL_GUARD_MS;
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Inline direction of the document (rows mirror in RTL). */
export function documentDir(): "ltr" | "rtl" {
  return typeof document !== "undefined" && document.documentElement.dir === "rtl" ? "rtl" : "ltr";
}
