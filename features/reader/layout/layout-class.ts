"use client";

import { useSyncExternalStore } from "react";

// Layout classes (.pm/spec-shell-design.md, "Terms"): compact <768 · medium
// 768–1199 · expanded ≥1200. PAINT never depends on these — placement is CSS
// (app/styles/shell.css). JS reads the class only for BEHAVIOUR (which history
// op, which overlay host) inside handlers/effects, or for post-mount widgets.

export type LayoutClass = "compact" | "medium" | "expanded";

const MEDIUM = "(min-width: 48rem)";
const EXPANDED = "(min-width: 75rem)";

/** Sync read for handlers/effects. SSR → "compact". */
export function getLayoutClass(): LayoutClass {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "compact";
  if (window.matchMedia(EXPANDED).matches) return "expanded";
  if (window.matchMedia(MEDIUM).matches) return "medium";
  return "compact";
}

export function isCompactLayout(): boolean {
  return getLayoutClass() === "compact";
}

/** Touch-first input at this moment (overlays push a history entry only then on wide). */
export function isCoarsePointer(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

/** Fires when the layout class may have changed (any breakpoint crossed). */
export function subscribeLayoutClass(onChange: () => void): () => void {
  return subscribe(onChange);
}

function subscribe(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const lists = [window.matchMedia(MEDIUM), window.matchMedia(EXPANDED)];
  lists.forEach((l) => l.addEventListener("change", onChange));
  return () => lists.forEach((l) => l.removeEventListener("change", onChange));
}

const serverSnapshot = () => null;

/**
 * Layout class for post-mount widgets: `null` during SSR and hydration, so it
 * can never change first paint. Branching first-paint JSX on it is a review
 * blocker (spec §1.2).
 */
export function useLayoutClass(): LayoutClass | null {
  return useSyncExternalStore(subscribe, getLayoutClass, serverSnapshot);
}
