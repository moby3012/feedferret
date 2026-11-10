// Tracked pull past the end of the article → next article: the touch state
// machine, free of the DOM so it can be unit-tested (the hook in
// use-reader-scroll.ts wires it to the scroller's touch events).
//
// Arbitration (spec §5 "Ownership", same rules as the list gestures):
//  * a touch that starts in content the reader pans itself (pre / code /
//    table / a horizontal scroller, lib/gesture-guards) never pulls;
//  * axis lock: the first SLOP_PX of movement decide — mostly horizontal
//    locks the sequence out (text selection, a pannable figure), mostly
//    vertical lets the pull track;
//  * a second finger cancels the pull for the rest of the sequence (pinch
//    zoom) — lifting fingers afterwards never fires.
//
// TODO(gestures): fold into the shared `createPull` (lib/gestures/pull.ts,
// list PR #235) once it is on main and supports a bottom edge — one owner
// per pointer sequence across list and reader, same haptics.

export const PULL_RESISTANCE = 0.45;
export const PULL_TRIGGER_PX = 64;
export const PULL_MAX_PX = 96;
export const SLOP_PX = 8;

export interface TouchPoint {
  clientX: number;
  clientY: number;
}

export interface PullTouchEvent {
  touches: ArrayLike<TouchPoint>;
  target: EventTarget | null;
  cancelable: boolean;
  preventDefault(): void;
}

export interface PullDeps {
  /** The scroller is at (or within slack of) its end. */
  atEnd(): boolean;
  /** The touch starts in content that pans on its own. */
  startsInPannable(target: EventTarget | null): boolean;
  enabled(): boolean;
  /** pull = distance after resistance (px), armed = release would fire. */
  render(pull: number, armed: boolean): void;
  onArm(): void;
  onTrigger(): void;
}

type Phase =
  | "idle" // no sequence / ignored sequence
  | "pending" // single touch, axis not decided yet
  | "vertical" // locked vertical: tracks the pull while at the end
  | "out"; // locked out for the rest of the sequence (horizontal / pannable / second finger)

export function createPullToNext(d: PullDeps) {
  let phase: Phase = "idle";
  let startX = 0;
  let startY = 0;
  let anchorY: number | null = null;
  let pull = 0;
  let armed = false;

  const clear = () => {
    anchorY = null;
    if (pull > 0 || armed) {
      pull = 0;
      armed = false;
      d.render(0, false);
    }
  };

  const lockOut = () => {
    phase = "out";
    clear();
  };

  return {
    start(e: PullTouchEvent) {
      if (e.touches.length !== 1) {
        // Second finger (or more): nothing of this sequence may pull.
        lockOut();
        return;
      }
      clear();
      if (!d.enabled() || d.startsInPannable(e.target)) {
        phase = "out";
        return;
      }
      phase = "pending";
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      anchorY = d.atEnd() ? startY : null;
    },

    move(e: PullTouchEvent) {
      if (phase === "idle" || phase === "out") return;
      if (e.touches.length !== 1 || !d.enabled()) {
        lockOut();
        return;
      }
      const { clientX: x, clientY: y } = e.touches[0];
      if (phase === "pending") {
        const dx = Math.abs(x - startX);
        const dy = Math.abs(y - startY);
        if (Math.max(dx, dy) < SLOP_PX) return;
        if (dx > dy) {
          lockOut();
          return;
        }
        phase = "vertical";
      }
      if (!d.atEnd()) {
        if (pull > 0) clear();
        anchorY = null;
        return;
      }
      if (anchorY === null) anchorY = y; // reached the end during this touch
      const raw = anchorY - y; // finger moving up past the end
      if (raw <= 0) {
        anchorY = y;
        if (pull > 0) clear();
        return;
      }
      if (e.cancelable) e.preventDefault();
      pull = Math.min(PULL_MAX_PX, raw * PULL_RESISTANCE);
      const nowArmed = pull >= PULL_TRIGGER_PX;
      if (nowArmed && !armed) d.onArm();
      armed = nowArmed;
      d.render(pull, armed);
    },

    /** `touchend`: fires only when the last finger of an untainted sequence lifts armed. */
    end(e: { touches: ArrayLike<TouchPoint> }) {
      if (e.touches.length > 0) {
        // One of several fingers lifted: the sequence was multi-touch → stays out.
        lockOut();
        return;
      }
      const fire = phase === "vertical" && armed;
      phase = "idle";
      clear();
      if (fire) d.onTrigger();
    },

    cancel() {
      phase = "idle";
      clear();
    },
  };
}
