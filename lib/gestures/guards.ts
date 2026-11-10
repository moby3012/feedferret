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
