"use client";

import { PULL_TRIGGER_PX, SLOP_PX, pullDistance } from "./math";
import { activeGesture, claimGesture, initGestureTracking, releaseGesture, startsInPannableContent, type GestureOwner } from "./guards";
import { haptic } from "./haptics";
import { springBack } from "./spring";

// Pull past an edge of a scroller (spec §5): pull-to-refresh at the top of the
// list, pull past the end of an article → next article (reader). A native pan
// cannot be cancelled from Pointer Events, so this one file uses `touchstart`
// (passive) + `touchmove` (non-passive; `preventDefault` only while the
// scroller is at the edge and the finger pulls away from it). Same
// arbitration and rAF writer as the row swipe: a touch that starts in content
// that pans on its own (pre / code / table / horizontal scroller) never pulls,
// the axis is decided once past the slop, a second finger cancels.
// Default visuals are CSS on the scroller: `--pull` (px),
// `data-pull="pulling|armed"`; `render` replaces them.

export type PullState = "idle" | "pulling" | "armed";

export interface PullOptions {
  edge: "top" | "bottom";
  /** Distance after resistance that arms the pull (default 64). */
  trigger?: number;
  enabled(): boolean;
  onTrigger(): void;
  /** Custom visuals (rAF-batched; also during the spring back). Default: `--pull` / `data-pull` on the scroller. */
  render?(px: number, state: PullState): void;
}

/** Slack for sub-pixel scroll ends (zoom, fractional heights). */
const EDGE_SLACK_PX = 2;

export function createPull(scroller: HTMLElement, o: PullOptions): () => void {
  const trigger = o.trigger ?? PULL_TRIGGER_PX;
  // A second finger anywhere in the document cancels the owned pull (guards.ts).
  initGestureTracking();
  let tracking = false;
  let owning = false;
  let startX = 0;
  let startY = 0;
  let distance = 0;
  let armed = false;
  let raf = 0;
  let stopSpring: (() => void) | null = null;

  const owner: GestureOwner = { kind: "pull", cancel: () => reset(true) };
  let state: PullState = "idle";

  const atEdge = () =>
    o.edge === "top" ? scroller.scrollTop <= 0 : scroller.scrollTop >= Math.max(0, scroller.scrollHeight - scroller.clientHeight) - EDGE_SLACK_PX;
  /** Finger travel away from the edge (positive = pulling). */
  const travel = (dy: number) => (o.edge === "top" ? dy : -dy);

  const paint = () => {
    if (o.render) return o.render(distance, state);
    if (distance <= 0) scroller.style.removeProperty("--pull");
    else scroller.style.setProperty("--pull", `${distance.toFixed(1)}px`);
    if (state === "idle") scroller.removeAttribute("data-pull");
    else scroller.setAttribute("data-pull", state);
  };
  const write = (px: number) => {
    distance = px;
    paint();
  };

  const frame = () => {
    raf = 0;
    write(distance);
    const nowArmed = distance >= trigger;
    if (nowArmed !== armed) {
      armed = nowArmed;
      state = armed ? "armed" : "pulling";
      paint();
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
      state = "idle";
      write(0);
    };
    if (animate && from > 0) stopSpring = springBack(from, 0, write, done);
    else done();
  }

  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 1 || !o.enabled() || !atEdge() || startsInPannableContent(e.target, scroller)) {
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
      // Towards the edge, sideways, scrolled, or a row swipe already owns the sequence: not a pull.
      if (travel(dy) <= 0 || Math.abs(dx) >= Math.abs(dy) || !atEdge() || (other && other !== owner) || !claimGesture(owner)) {
        tracking = false;
        return;
      }
      owning = true;
      state = "pulling";
      paint();
    }
    if (!atEdge()) {
      reset(true);
      return;
    }
    if (e.cancelable) e.preventDefault();
    distance = pullDistance(travel(dy));
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
