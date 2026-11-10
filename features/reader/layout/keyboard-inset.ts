"use client";

import { useEffect, useSyncExternalStore } from "react";

// On-screen keyboard state for touch devices (spec §4.3 `--keyboard-inset`,
// §4.6: the tab bar slides out while the keyboard is up). Two signals:
//   · a text-entry element has focus on a coarse pointer (deterministic; the
//     keyboard is about to show / is showing), and
//   · visualViewport shrinking (iOS: `interactive-widget` is not honoured, the
//     layout viewport keeps its height) → `--keyboard-inset` on <html>.
// Nothing here runs before mount; paint never depends on it.

const TEXT_TYPES = new Set(["text", "search", "email", "url", "password", "tel", "number", ""]);

function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  if (el instanceof HTMLInputElement) return TEXT_TYPES.has(el.type) && !el.readOnly;
  return el instanceof HTMLElement && el.isContentEditable;
}

const coarse = () => typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

let open = false;
let installed = 0;
const listeners = new Set<() => void>();
let teardown: (() => void) | null = null;

function set(next: boolean) {
  if (next === open) return;
  open = next;
  if (next) document.documentElement.dataset.keyboard = "open";
  else delete document.documentElement.dataset.keyboard;
  listeners.forEach((l) => l());
}

function install() {
  const onFocusIn = (e: FocusEvent) => set(coarse() && isTextEntry(e.target as Element));
  // focusout fires before the next focusin: check where focus landed a frame later.
  const onFocusOut = () => requestAnimationFrame(() => set(coarse() && isTextEntry(document.activeElement)));
  const vv = window.visualViewport;
  const onViewport = () => {
    if (!vv) return;
    const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    // Pinch-zoom also shrinks the visual viewport: only a keyboard-sized bottom inset counts.
    document.documentElement.style.setProperty("--keyboard-inset", `${inset > 120 ? inset : 0}px`);
  };
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  vv?.addEventListener("resize", onViewport);
  return () => {
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
    vv?.removeEventListener("resize", onViewport);
    document.documentElement.style.removeProperty("--keyboard-inset");
    set(false);
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True while a text field has focus on a touch device (the on-screen keyboard is up). */
export function useKeyboardOpen(): boolean {
  useEffect(() => {
    if (installed++ === 0) teardown = install();
    return () => {
      if (--installed === 0) {
        teardown?.();
        teardown = null;
      }
    };
  }, []);
  return useSyncExternalStore(subscribe, () => open, () => false);
}
