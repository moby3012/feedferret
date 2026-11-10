"use client";

import { PULL_TRIGGER_PX, SLOP_PX, pullDistance } from "./math";
import { activeGesture, claimGesture, releaseGesture, type GestureOwner } from "./guards";
import { haptic } from "./haptics";
import { springBack } from "./spring";

// Pull-to-refresh (spec §5). A native pan cannot be cancelled from Pointer
// Events, so this one file uses `touchstart` (passive) + `touchmove`
// (non-passive; `preventDefault` only while the scroller is at the top and the
// finger pulls down). Same arbitration and rAF writer as the row swipe.
// Visuals are CSS on the scroller: `--pull` (px), `data-pull="pulling|armed"`.

export interface PullOptions {
  edge: "top";
  /** Distance after resistance that arms the refresh (default 64). */
  trigger?: number;
  enabled(): boolean;
  onTrigger(): void;
}

export function createPull(scroller: HTMLElement, o: PullOptions): () => void {
  const trigger = o.trigger ?? PULL_TRIGGER_PX;
  let tracking = false;
  let owning = false;
  let startX = 0;
  let startY = 0;
  let distance = 0;
  let armed = false;
  let raf = 0;
  let stopSpring: (() => void) | null = null;

  const owner: GestureOwner = { kind: "pull", cancel: () => reset(true) };

  const write = (px: number) => {
    distance = px;
    if (px <= 0) scroller.style.removeProperty("--pull");
    else scroller.style.setProperty("--pull", `${px.toFixed(1)}px`);
  };

  const frame = () => {
    raf = 0;
    write(distance);
    const nowArmed = distance >= trigger;
    if (nowArmed !== armed) {
      armed = nowArmed;
      scroller.setAttribute("data-pull", armed ? "armed" : "pulling");
      if (armed) haptic("tick");
    }
  };

  function reset(animate: boolean) {
    tracking = false;
    if (owning) releaseGesture(owner);
    owning = false;
    armed = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    const from = distance;
    const done = () => {
      stopSpring = null;
      scroller.removeAttribute("data-pull");
      write(0);
    };
    if (animate && from > 0) stopSpring = springBack(from, 0, write, done);
    else done();
  }

  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 1 || !o.enabled() || scroller.scrollTop > 0) {
      if (owning) reset(true);
      tracking = false;
      return;
    }
    stopSpring?.();
    stopSpring = null;
    tracking = true;
    owning = false;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  };

  const onMove = (e: TouchEvent) => {
    if (!tracking || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (!owning) {
      if (Math.hypot(dx, dy) <= SLOP_PX) return;
      const other = activeGesture();
      // Up, sideways, scrolled, or a row swipe already owns the sequence: not a pull.
      if (dy <= 0 || Math.abs(dx) >= Math.abs(dy) || scroller.scrollTop > 0 || (other && other !== owner) || !claimGesture(owner)) {
        tracking = false;
        return;
      }
      owning = true;
      scroller.setAttribute("data-pull", "pulling");
    }
    if (scroller.scrollTop > 0) {
      reset(true);
      return;
    }
    e.preventDefault();
    distance = pullDistance(dy);
    if (!raf) raf = requestAnimationFrame(frame);
  };

  const onEnd = () => {
    if (!owning) {
      tracking = false;
      return;
    }
    const fire = distance >= trigger;
    reset(true);
    if (fire) {
      haptic("success");
      o.onTrigger();
    }
  };

  scroller.addEventListener("touchstart", onStart, { passive: true });
  scroller.addEventListener("touchmove", onMove, { passive: false });
  // The OS took the touch (scroll start, call, gesture): spring back, never refresh.
  const onCancel = () => {
    if (owning) reset(true);
    tracking = false;
  };

  scroller.addEventListener("touchend", onEnd);
  scroller.addEventListener("touchcancel", onCancel);
  return () => {
    scroller.removeEventListener("touchstart", onStart);
    scroller.removeEventListener("touchmove", onMove);
    scroller.removeEventListener("touchend", onEnd);
    scroller.removeEventListener("touchcancel", onCancel);
    stopSpring?.();
    reset(false);
  };
}
