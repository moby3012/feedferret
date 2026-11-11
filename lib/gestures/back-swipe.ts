"use client";

import { decideAxis, velocityOf, type Sample } from "./math";
import {
  backCommitDuration,
  backParallaxOffset,
  backReducedOpacity,
  backShadeOpacity,
  backSwipeMayStart,
  backSwipeProgress,
  backSwipeTravel,
  detectBackSwipeEnvironment,
  isBackArmed,
  shouldCommitBack,
  type BackSwipeEnvironment,
} from "./back-swipe-math";
import {
  claimGesture,
  initGestureTracking,
  pointersDownCount,
  prefersReducedMotion,
  recentlyScrolled,
  releaseGesture,
  startsInPannableContent,
  watchSequence,
  type GestureOwner,
} from "./guards";
import { haptic } from "./haptics";
import { springBack } from "./spring";

// Reader swipe-back (Reeder-style, interactive) on Pointer Events: a swipe
// towards inline-end that starts anywhere in the reader drags the reader
// layer with the finger, the list underneath follows with a parallax lag
// under a fading shade; release past 35 % of the width (or a flick) slides it
// out and calls `onCommit` (nav.up() — the same history op as the back
// chevron), otherwise it springs home. Same arbitration as the list rows
// (lib/gestures/swipe-row.ts): slop + axis lock, one owner per sequence, a
// second finger cancels, no start during momentum scroll, never from content
// that pans on its own. All writes are inline styles from one rAF loop: zero
// React renders during the drag. Visual hooks (app/styles/shell.css):
//   data-back-swipe="drag|settle|commit|done"  on the surface
//   data-back-shade + --back-shade             on the list underneath: shade opacity

export interface BackSwipeOptions {
  /** Pref on + the reader currently covers the list (compact / portrait tablet). */
  enabled(): boolean;
  dir(): "ltr" | "rtl";
  /** The list pane underneath (parallax); null = no parallax. */
  under(): HTMLElement | null;
  /** First lock of a sequence (the coach mark is learned). */
  onStart?(): void;
  /** The reader has slid out: go back. Visual state stays until `reset()`. */
  onCommit(): void;
  /**
   * An overlay (sheet, menu, dialog) is open: no swipe starts, a running one
   * springs back, and a release never commits — Back would close the overlay,
   * not the article.
   */
  blocked?(): boolean;
  /** Test seam; default: UA + display-mode. */
  environment?(): BackSwipeEnvironment;
}

/** Interactive controls / media keep their own touch handling. */
const OWN_GESTURE_SELECTOR = "input, textarea, select, [contenteditable=''], [contenteditable='true'], iframe, video, audio, embed, object, [role='slider'], .katex-display, [data-gallery]";

type Phase = "idle" | "pending" | "locked" | "settling" | "committing" | "committed";

function defaultEnvironment(): BackSwipeEnvironment {
  let standalone = false;
  try {
    standalone = window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    /* ignore */
  }
  return detectBackSwipeEnvironment(navigator as Navigator & { standalone?: boolean }, standalone);
}

function hasTextSelection(): boolean {
  const sel = typeof window.getSelection === "function" ? window.getSelection() : null;
  return !!sel && !sel.isCollapsed && sel.toString().length > 0;
}

export function createBackSwipe(surface: HTMLElement, o: BackSwipeOptions): { destroy(): void; reset(): void } {
  let phase: Phase = "idle";
  let pointerId = -1;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let width = 1;
  let samples: Sample[] = [];
  let raf = 0;
  let armed = false;
  let reduced = false;
  let travel = 0;
  let under: HTMLElement | null = null;
  let stopSpring: (() => void) | null = null;
  let commitTimer: ReturnType<typeof setTimeout> | null = null;
  let clickGuardUntil = 0;
  let unwatch: (() => void) | null = null;
  const owner: GestureOwner = { kind: "back", cancel: () => cancel() };
  initGestureTracking();

  const sign = () => (o.dir() === "rtl" ? -1 : 1);
  /** Finger delta along the inline axis (+ = towards inline-end = back). */
  const inlineDelta = () => (lastX - startX) * sign();

  const write = (x: number) => {
    travel = x;
    if (reduced) {
      surface.style.opacity = String(backReducedOpacity(x, width));
      return;
    }
    surface.style.transform = x === 0 ? "translate3d(0,0,0)" : `translate3d(${(x * sign()).toFixed(1)}px,0,0)`;
    const p = backSwipeProgress(x, width);
    if (under) {
      under.style.transform = `translate3d(${(backParallaxOffset(p, width) * sign()).toFixed(1)}px,0,0)`;
      under.style.setProperty("--back-shade", backShadeOpacity(p).toFixed(3));
    }
  };

  const clearStyles = () => {
    surface.style.removeProperty("transform");
    surface.style.removeProperty("transition");
    surface.style.removeProperty("opacity");
    surface.removeAttribute("data-back-swipe");
    if (under) {
      under.style.removeProperty("transform");
      under.style.removeProperty("transition");
      under.style.removeProperty("--back-shade");
      under.removeAttribute("data-back-shade");
    }
    under = null;
    travel = 0;
    armed = false;
  };

  const isBlocked = () => o.blocked?.() ?? false;

  const frame = () => {
    raf = 0;
    if (phase !== "locked") return;
    if (isBlocked()) {
      cancel(); // an overlay opened mid-gesture
      return;
    }
    const d = inlineDelta();
    write(reduced ? Math.max(0, d) : backSwipeTravel(d, width));
    const nowArmed = isBackArmed(d, width);
    if (nowArmed !== armed) {
      armed = nowArmed;
      if (armed) haptic("tick");
    }
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(frame);
  };

  const endSequence = () => {
    if (pointerId !== -1 && surface.hasPointerCapture?.(pointerId)) surface.releasePointerCapture(pointerId);
    pointerId = -1;
    unwatch?.();
    unwatch = null;
    releaseGesture(owner);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  const settle = (v: number) => {
    phase = "settling";
    surface.setAttribute("data-back-swipe", "settle");
    if (reduced) {
      clearStyles();
      phase = "idle";
      return;
    }
    stopSpring = springBack(travel, v, write, () => {
      stopSpring = null;
      clearStyles();
      if (phase === "settling") phase = "idle";
    });
  };

  const commit = (v: number) => {
    phase = "committing";
    surface.setAttribute("data-back-swipe", "commit");
    const finish = () => {
      if (commitTimer !== null) clearTimeout(commitTimer);
      commitTimer = null;
      surface.removeEventListener("transitionend", onEnd);
      if (phase !== "committing") return;
      if (isBlocked()) {
        // An overlay opened during the slide-out: Back would only close it.
        clearStyles();
        phase = "idle";
        return;
      }
      phase = "committed";
      surface.setAttribute("data-back-swipe", "done");
      o.onCommit();
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target === surface) finish();
    };
    const ms = reduced ? 120 : backCommitDuration(width - travel, v);
    // Next frame: the transition must start from the current (inline) value.
    requestAnimationFrame(() => {
      if (phase !== "committing") return;
      surface.addEventListener("transitionend", onEnd);
      if (reduced) {
        surface.style.transition = `opacity ${ms}ms linear`;
        surface.style.opacity = "0";
      } else {
        const ease = "cubic-bezier(0.2, 0.8, 0.2, 1)";
        surface.style.transition = `transform ${ms}ms ${ease}`;
        surface.style.transform = `translate3d(${(width * sign()).toFixed(1)}px,0,0)`;
        if (under) {
          under.style.setProperty("--back-shade", "0");
          under.style.transition = `transform ${ms}ms ${ease}`;
          under.style.transform = "translate3d(0,0,0)";
        }
      }
      commitTimer = setTimeout(finish, ms + 80); // transitionend can be skipped (hidden tab)
    });
  };

  function cancel() {
    const wasLocked = phase === "locked";
    endSequence();
    if (wasLocked) settle(0);
    else if (phase === "pending") phase = "idle";
  }

  const onPointerDown = (e: PointerEvent) => {
    if (phase === "committing" || phase === "committed") return;
    if (pointerId !== -1 && e.pointerId !== pointerId) {
      cancel();
      return;
    }
    if (!e.isPrimary || e.button !== 0 || pointersDownCount() > 1) return;
    if (e.pointerType !== "touch" && e.pointerType !== "pen") return; // mouse / trackpad never swipes
    if (!o.enabled() || isBlocked()) return;
    if (!backSwipeMayStart(e.clientX, window.innerWidth, (o.environment ?? defaultEnvironment)())) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest(OWN_GESTURE_SELECTOR) || startsInPannableContent(target, surface)) return;
    if (hasTextSelection()) return; // dragging a selection handle
    stopSpring?.();
    stopSpring = null;
    if (phase === "settling") clearStyles();
    pointerId = e.pointerId;
    startX = lastX = e.clientX;
    startY = e.clientY;
    samples = [{ x: e.clientX, t: e.timeStamp }];
    phase = recentlyScrolled() ? "idle" : "pending";
    unwatch = watchSequence(owner.cancel);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    lastX = e.clientX;
    if (phase === "pending") {
      const dx = e.clientX - startX;
      const axis = decideAxis(dx, e.clientY - startY);
      if (axis === null) return;
      // Vertical (the scroller owns it), towards inline-start (nothing to do), a selection being made.
      if (axis === "y" || dx * sign() <= 0 || hasTextSelection() || !o.enabled() || isBlocked() || !claimGesture(owner)) {
        phase = "idle";
        endSequence();
        return;
      }
      phase = "locked";
      reduced = prefersReducedMotion();
      width = Math.max(1, surface.getBoundingClientRect().width);
      under = reduced ? null : o.under();
      surface.setAttribute("data-back-swipe", "drag");
      surface.style.transition = "none";
      if (under) {
        under.style.transition = "none";
        under.setAttribute("data-back-shade", "");
      }
      try {
        surface.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already gone */
      }
      // The reader starts moving from where the axis locked: no jump by the slop.
      startX = e.clientX;
      o.onStart?.();
    }
    if (phase !== "locked") return;
    samples.push({ x: e.clientX, t: e.timeStamp });
    if (samples.length > 12) samples.shift();
    schedule();
  };

  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    lastX = e.clientX;
    const wasLocked = phase === "locked";
    if (wasLocked) samples.push({ x: e.clientX, t: e.timeStamp });
    endSequence();
    if (!wasLocked) {
      phase = "idle";
      return;
    }
    clickGuardUntil = performance.now() + 400;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    frame(); // paint the release position (cancels when an overlay opened)
    if (phase !== "locked") return;
    const d = inlineDelta();
    const v = velocityOf(samples) * sign();
    if (o.enabled() && !isBlocked() && shouldCommitBack(d, v, width)) {
      haptic("success");
      commit(v);
    } else {
      settle(v);
    }
  };

  const onPointerCancel = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    cancel();
  };

  // The release of a swipe is never a tap on whatever link sits under the finger.
  const onClick = (e: MouseEvent) => {
    if (performance.now() > clickGuardUntil) return;
    clickGuardUntil = 0;
    e.preventDefault();
    e.stopPropagation();
  };

  const onVisibility = () => {
    if (document.visibilityState === "hidden" && (phase === "pending" || phase === "locked")) cancel();
  };

  surface.addEventListener("pointerdown", onPointerDown);
  surface.addEventListener("pointermove", onPointerMove);
  surface.addEventListener("pointerup", onPointerUp);
  surface.addEventListener("pointercancel", onPointerCancel);
  surface.addEventListener("click", onClick, { capture: true });
  document.addEventListener("visibilitychange", onVisibility);

  const reset = () => {
    stopSpring?.();
    stopSpring = null;
    if (commitTimer !== null) clearTimeout(commitTimer);
    commitTimer = null;
    endSequence();
    phase = "idle";
    clearStyles();
  };

  return {
    reset,
    destroy() {
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerup", onPointerUp);
      surface.removeEventListener("pointercancel", onPointerCancel);
      surface.removeEventListener("click", onClick, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
      reset();
    },
  };
}
