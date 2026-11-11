"use client";

import { useEffect, useSyncExternalStore } from "react";

// On-screen keyboard state for touch devices (spec §4.3 `--keyboard-inset`,
// §4.6: the tab bar slides out while the keyboard is up). Two signals:
//   · a text-entry element has focus on a coarse pointer (deterministic; the
//     keyboard is about to show / is showing), and
//   · the visual viewport's height. It shrinks while the keyboard is up and
//     recovers when it goes away. The keyboard can be dismissed WITHOUT a blur
//     (Android Back, iOS "Done"/swipe-down): focus stays in the field, so focus
//     alone would keep the tab bar hidden forever. A recovery after a seen
//     shrink therefore counts as "dismissed"; a new shrink (tapping the still
//     focused field) re-opens. iOS ignores `interactive-widget`, so the bottom
//     inset is also published as `--keyboard-inset` on <html>.
// Nothing here runs before mount; paint never depends on it.

const TEXT_TYPES = new Set(["text", "search", "email", "url", "password", "tel", "number", ""]);
/** Smaller height changes are browser chrome (URL bar) or zoom, not a keyboard. */
export const KEYBOARD_MIN_PX = 120;

function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  if (el instanceof HTMLInputElement) return TEXT_TYPES.has(el.type) && !el.readOnly;
  return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * Pure keyboard state machine (unit-tested). `focus` reports whether a text
 * field now has focus; `viewport` reports the visual viewport's size in layout
 * pixels. Both return whether the keyboard counts as open.
 */
export function createKeyboardState(minPx = KEYBOARD_MIN_PX) {
  let focused = false;
  let dismissed = false;
  let shrinkSeen = false;
  let baseline = 0;
  let width = -1;
  let height = 0;
  const shrunk = () => baseline - height > minPx;
  const isOpen = () => focused && !dismissed;
  return {
    isOpen,
    focus(textEntry: boolean): boolean {
      focused = textEntry;
      dismissed = false;
      // Moving focus between fields while the keyboard stays up: it is already shrunk.
      shrinkSeen = textEntry && shrunk();
      return isOpen();
    },
    /**
     * The deferred re-check after a `focusout` (focus lands a frame later). Only
     * a CHANGE of the focus state counts: when the frame arrives late, after the
     * keyboard was dismissed with focus staying in the field, re-applying
     * `focus(true)` would wipe `dismissed` and hide the tab bar again.
     */
    settle(textEntry: boolean): boolean {
      return textEntry === focused ? isOpen() : this.focus(textEntry);
    },
    viewport(h: number, w: number): boolean {
      height = h;
      if (w !== width) {
        // Rotation / window resize: a new reference height. A keyboard that is up
        // across the change is not seen as a shrink — focus still hides the bar.
        width = w;
        baseline = h;
      } else if (h > baseline) {
        baseline = h;
      }
      if (shrunk()) {
        shrinkSeen = true;
        dismissed = false;
      } else if (shrinkSeen) {
        shrinkSeen = false;
        if (focused) dismissed = true;
      }
      return isOpen();
    },
  };
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
  const state = createKeyboardState();
  const vv = window.visualViewport;
  const onFocusIn = (e: FocusEvent) => set(state.focus(coarse() && isTextEntry(e.target as Element)));
  // focusout fires before the next focusin: check where focus landed a frame later.
  const onFocusOut = () => requestAnimationFrame(() => set(state.settle(coarse() && isTextEntry(document.activeElement))));
  const onViewport = () => {
    // Layout pixels: pinch-zoom divides vv.height by the scale; undo that.
    const h = vv ? vv.height * vv.scale : window.innerHeight;
    const w = vv ? Math.round(vv.width * vv.scale) : window.innerWidth;
    set(state.viewport(h, w));
    if (!vv) return;
    const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    // Pinch-zoom also shrinks the visual viewport: only a keyboard-sized bottom inset counts.
    document.documentElement.style.setProperty("--keyboard-inset", `${inset > KEYBOARD_MIN_PX ? inset : 0}px`);
  };
  onViewport();
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  // With `interactive-widget=resizes-content` (Android) the layout viewport resizes too; vv covers both.
  const target: EventTarget = vv ?? window;
  target.addEventListener("resize", onViewport);
  return () => {
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
    target.removeEventListener("resize", onViewport);
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

/** True while the on-screen keyboard is up on a touch device (text field focused and not dismissed). */
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
