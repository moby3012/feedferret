"use client";

import { getGesturePrefs } from "./prefs";

// Haptic feedback (spec §5). The visual pop is the guaranteed feedback; this
// is best effort on top:
// - Android / Chromium: `navigator.vibrate`.
// - iOS ≥ 18 Safari has no vibrate, but toggling an `<input type="checkbox"
//   switch>` through its label plays the system "selection" haptic. That only
//   works inside a user activation (pointerup / click), so on iOS it is used
//   for `success` / `warn` (fired at release) and never for `tick` (fired
//   mid-drag, outside an activation, where it would be silently dropped).
// Off when the user disabled haptics or prefers reduced motion.

export type HapticKind = "tick" | "success" | "warn";

const PATTERN: Record<HapticKind, number | number[]> = { tick: 8, success: [10, 40, 10], warn: 30 };

let iosLabel: HTMLLabelElement | null = null;

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** WebKit exposes the `switch` IDL attribute (Safari ≥ 17.4); haptics on toggle arrived with iOS 18. */
function iosSwitchSupported(): boolean {
  return typeof HTMLInputElement !== "undefined" && "switch" in HTMLInputElement.prototype && /iP(hone|ad|od)|Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 0;
}

function iosSwitchLabel(): HTMLLabelElement {
  if (iosLabel?.isConnected) return iosLabel;
  const label = document.createElement("label");
  label.setAttribute("aria-hidden", "true");
  label.style.cssText = "position:fixed;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);opacity:0;pointer-events:none;left:0;top:0";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("switch", "");
  input.tabIndex = -1;
  label.appendChild(input);
  document.body.appendChild(label);
  iosLabel = label;
  return label;
}

export function haptic(kind: HapticKind): void {
  if (typeof window === "undefined") return;
  if (!getGesturePrefs().haptics || reducedMotion()) return;
  try {
    if (typeof navigator.vibrate === "function") {
      navigator.vibrate(PATTERN[kind]);
      return;
    }
    if (kind !== "tick" && iosSwitchSupported()) {
      const focused = document.activeElement as HTMLElement | null;
      iosSwitchLabel().click();
      // The label click must not steal focus from the row the user acted on.
      if (focused && document.activeElement !== focused) focused.focus({ preventScroll: true });
    }
  } catch {
    /* feedback is optional */
  }
}
