"use client";

import {
  LONG_PRESS_MS,
  SLOP_PX,
  decideAxis,
  inEdgeInset,
  isArmed,
  shouldCommit,
  swipeProgress,
  swipeTravel,
  velocityOf,
  type Sample,
} from "./math";
import { cancelActiveGesture, claimGesture, recentlyScrolled, releaseGesture, startsInPannableContent, type GestureOwner } from "./guards";
import { haptic } from "./haptics";
import { springBack } from "./spring";

// One list-row swipe (spec §5) on Pointer Events. All motion is written to the
// DOM from one rAF loop — transform on `content`, `--swipe-p` + data
// attributes on the row — so a drag causes zero React renders. Visuals are CSS
// (app/styles/list.css) keyed on:
//   data-swipe="leading|trailing"  which side is revealed
//   data-armed                     releasing now commits
//   data-swiping                   finger down + locked (will-change)
//   --swipe-p                      0…1 progress towards the commit distance

export interface SwipeAction {
  id: string;
  commit(): void;
}

export interface LongPressPoint {
  x: number;
  y: number;
  pointerType: string;
}

export interface SwipeRowOptions {
  /** The element that moves (the row's visible content). */
  content: HTMLElement;
  enabled(): boolean;
  dir(): "ltr" | "rtl";
  /** Action for a swipe towards inline-end (→ in LTR); revealed at inline-start. */
  leading(): SwipeAction | null;
  /** Action for a swipe towards inline-start (← in LTR); revealed at inline-end. */
  trailing(): SwipeAction | null;
  /** Long-press (touch / pen, 450 ms) or `contextmenu` (right-click, Android long-press). */
  onLongPress?(point: LongPressPoint): void;
}

type Phase = "idle" | "pending" | "locked" | "settling";

const CLICK_SUPPRESS_MS = 600;

export function createSwipeRow(el: HTMLElement, o: SwipeRowOptions): () => void {
  let phase: Phase = "idle";
  let pointerId = -1;
  let pointerType = "";
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let width = 1;
  let samples: Sample[] = [];
  let raf = 0;
  let armed = false;
  let side: "leading" | "trailing" | null = null;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressFired = false;
  let stopSpring: (() => void) | null = null;
  let offset = 0;

  const owner: GestureOwner = { kind: "swipe", cancel: () => cancel() };

  const clearLongPress = () => {
    if (longPressTimer !== null) clearTimeout(longPressTimer);
    longPressTimer = null;
  };

  const suppressNextClick = () => {
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => el.removeEventListener("click", swallow, { capture: true }), CLICK_SUPPRESS_MS);
  };

  const write = (x: number) => {
    offset = x;
    o.content.style.transform = x === 0 ? "" : `translate3d(${x}px,0,0)`;
  };

  const resetAttrs = () => {
    el.removeAttribute("data-swipe");
    el.removeAttribute("data-armed");
    el.removeAttribute("data-swiping");
    el.style.removeProperty("--swipe-p");
    armed = false;
    side = null;
  };

  /** Raw finger delta along the inline axis (+ = towards inline-end). */
  const inlineDelta = () => {
    const dx = lastX - startX;
    return o.dir() === "rtl" ? -dx : dx;
  };

  const frame = () => {
    raf = 0;
    if (phase !== "locked") return;
    const d = inlineDelta();
    const nextSide = d > 0 ? "leading" : d < 0 ? "trailing" : null;
    const action = nextSide === "leading" ? o.leading() : nextSide === "trailing" ? o.trailing() : null;
    const travel = swipeTravel(d, width, !!action);
    write(o.dir() === "rtl" ? -travel : travel);
    if (nextSide !== side) {
      side = nextSide;
      if (side && action) el.setAttribute("data-swipe", side);
      else el.removeAttribute("data-swipe");
    }
    el.style.setProperty("--swipe-p", action ? swipeProgress(d, width).toFixed(3) : "0");
    const nowArmed = !!action && isArmed(d, width);
    if (nowArmed !== armed) {
      armed = nowArmed;
      if (armed) {
        el.setAttribute("data-armed", "");
        haptic("tick");
      } else {
        el.removeAttribute("data-armed"); // crossing back un-arms silently
      }
    }
  };

  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(frame);
  };

  const settle = (velocityInline: number) => {
    phase = "settling";
    el.removeAttribute("data-swiping");
    const v = o.dir() === "rtl" ? -velocityInline : velocityInline;
    stopSpring = springBack(offset, v, write, () => {
      stopSpring = null;
      resetAttrs();
      if (phase === "settling") phase = "idle";
    });
  };

  const endSequence = () => {
    if (pointerId !== -1 && el.hasPointerCapture?.(pointerId)) el.releasePointerCapture(pointerId);
    pointerId = -1;
    clearLongPress();
    releaseGesture(owner);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  function cancel() {
    const wasLocked = phase === "locked";
    endSequence();
    if (wasLocked) settle(0);
    else phase = "idle";
  }

  const onPointerDown = (e: PointerEvent) => {
    if (pointerId !== -1 && e.pointerId !== pointerId) {
      // Second pointer: the active gesture springs back, nothing commits.
      cancelActiveGesture();
      cancel();
      return;
    }
    if (!e.isPrimary || e.button !== 0) return;
    if (e.pointerType !== "touch" && e.pointerType !== "pen") return; // mouse never swipes
    if (inEdgeInset(e.clientX, window.innerWidth)) return; // the OS back gesture owns the edges
    if (startsInPannableContent(e.target, el)) return;
    stopSpring?.();
    stopSpring = null;
    resetAttrs();
    write(0);
    pointerId = e.pointerId;
    pointerType = e.pointerType;
    startX = lastX = e.clientX;
    startY = e.clientY;
    samples = [{ x: e.clientX, t: e.timeStamp }];
    longPressFired = false;
    // Momentum scroll still running: this touch stops the scroll, it is not a swipe.
    phase = recentlyScrolled() ? "idle" : "pending";
    if (o.onLongPress) {
      const point = { x: e.clientX, y: e.clientY, pointerType: e.pointerType };
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        if (pointerId === -1 || phase === "locked") return;
        longPressFired = true;
        phase = "idle";
        haptic("tick");
        suppressNextClick();
        o.onLongPress?.(point);
      }, LONG_PRESS_MS);
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    lastX = e.clientX;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.hypot(dx, dy) > SLOP_PX) clearLongPress();
    if (phase === "pending") {
      const axis = decideAxis(dx, dy);
      if (axis === null) return;
      if (axis === "y" || !o.enabled() || !claimGesture(owner)) {
        // Vertical: the scroller owns this touch until release.
        phase = "idle";
        return;
      }
      phase = "locked";
      width = Math.max(1, el.getBoundingClientRect().width);
      el.setAttribute("data-swiping", "");
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already gone */
      }
      suppressNextClick();
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
    const d = inlineDelta();
    const vRaw = velocityOf(samples);
    const v = o.dir() === "rtl" ? -vRaw : vRaw;
    const action = d > 0 ? o.leading() : d < 0 ? o.trailing() : null;
    if (action && shouldCommit(d, v, width)) {
      // Fire at release: the optimistic state flips while the row springs home.
      action.commit();
      haptic("success");
    }
    settle(v);
  };

  const onPointerCancel = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    // A native scroll start arrives here: spring back, never commit.
    cancel();
  };

  const onContextMenu = (e: MouseEvent) => {
    if (!o.onLongPress) return;
    e.preventDefault();
    if (longPressFired) return; // Android: our long-press already opened the menu
    clearLongPress();
    const isTouch = pointerType === "touch" && pointerId !== -1;
    if (e.clientX === 0 && e.clientY === 0) {
      // Keyboard (ContextMenu key / Shift+F10): anchor at the row.
      const r = el.getBoundingClientRect();
      o.onLongPress({ x: r.left + Math.min(48, r.width / 2), y: r.top + Math.min(48, r.height / 2), pointerType: "keyboard" });
      return;
    }
    o.onLongPress({ x: e.clientX, y: e.clientY, pointerType: isTouch ? "touch" : "mouse" });
  };

  // After a long-press the finger lift must not become a tap: the browser
  // would synthesize mousedown / click at that point — on whatever the menu
  // now shows there. Cancelling the sequence's touchend suppresses them.
  const onTouchEnd = (e: TouchEvent) => {
    if (longPressFired && e.cancelable) e.preventDefault();
  };

  const onVisibility = () => {
    if (document.visibilityState === "hidden" && phase !== "idle") cancel();
  };

  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointercancel", onPointerCancel);
  el.addEventListener("contextmenu", onContextMenu);
  el.addEventListener("touchend", onTouchEnd, { passive: false });
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerup", onPointerUp);
    el.removeEventListener("pointercancel", onPointerCancel);
    el.removeEventListener("contextmenu", onContextMenu);
    el.removeEventListener("touchend", onTouchEnd);
    document.removeEventListener("visibilitychange", onVisibility);
    stopSpring?.();
    endSequence();
    write(0);
    resetAttrs();
  };
}
