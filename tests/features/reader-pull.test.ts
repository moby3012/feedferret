import { describe, expect, it, vi } from "vitest";
import { createPullToNext, PULL_TRIGGER_PX, PULL_RESISTANCE, type PullDeps } from "../../components/reader/pull-to-next";

type Pt = [number, number];

function setup(over: Partial<PullDeps> = {}) {
  const renders: Array<[number, boolean]> = [];
  const deps: PullDeps = {
    atEnd: () => true,
    startsInPannable: (target) => (target as unknown) === "code",
    enabled: () => true,
    render: (p, a) => renders.push([p, a]),
    onArm: vi.fn(),
    onTrigger: vi.fn(),
    ...over,
  };
  const pull = createPullToNext(deps);
  const ev = (pts: Pt[], target: unknown = "p") => {
    const e = {
      touches: pts.map(([clientX, clientY]) => ({ clientX, clientY })),
      target: target as EventTarget,
      cancelable: true,
      preventDefault: vi.fn(),
    };
    return e;
  };
  return { pull, deps, renders, ev };
}

const ARM_DY = Math.ceil(PULL_TRIGGER_PX / PULL_RESISTANCE) + 4;

describe("pull past the end → next article", () => {
  it("a vertical pull at the end arms, prevents native overscroll and fires on release", () => {
    const { pull, deps, ev } = setup();
    pull.start(ev([[100, 500]]));
    const m1 = ev([[100, 480]]);
    pull.move(m1);
    expect(m1.preventDefault).toHaveBeenCalled();
    pull.move(ev([[100, 500 - ARM_DY]]));
    expect(deps.onArm).toHaveBeenCalledTimes(1);
    pull.end(ev([]));
    expect(deps.onTrigger).toHaveBeenCalledTimes(1);
  });

  it("releasing below the trigger distance does not fire", () => {
    const { pull, deps, ev } = setup();
    pull.start(ev([[100, 500]]));
    pull.move(ev([[100, 470]]));
    pull.end(ev([]));
    expect(deps.onTrigger).not.toHaveBeenCalled();
  });

  it("ignores touches that start in pannable content (pre / code / table / horizontal scroller)", () => {
    const { pull, deps, renders, ev } = setup();
    pull.start(ev([[100, 500]], "code"));
    const m = ev([[100, 500 - ARM_DY]], "code");
    pull.move(m);
    pull.end(ev([]));
    expect(m.preventDefault).not.toHaveBeenCalled();
    expect(renders).toEqual([]);
    expect(deps.onTrigger).not.toHaveBeenCalled();
  });

  it("axis lock: a mostly horizontal start locks the pull out for the whole sequence", () => {
    const { pull, deps, renders, ev } = setup();
    pull.start(ev([[100, 500]]));
    pull.move(ev([[120, 495]])); // decides horizontal
    const m = ev([[120, 500 - ARM_DY]]); // later vertical movement does not take over
    pull.move(m);
    pull.end(ev([]));
    expect(m.preventDefault).not.toHaveBeenCalled();
    expect(renders).toEqual([]);
    expect(deps.onTrigger).not.toHaveBeenCalled();
  });

  it("does nothing inside the slop", () => {
    const { pull, renders, ev } = setup();
    pull.start(ev([[100, 500]]));
    const m = ev([[103, 495]]);
    pull.move(m);
    expect(m.preventDefault).not.toHaveBeenCalled();
    expect(renders).toEqual([]);
  });

  it("a second finger cancels an armed pull; lifting the fingers afterwards never fires", () => {
    const { pull, deps, renders, ev } = setup();
    pull.start(ev([[100, 500]]));
    pull.move(ev([[100, 500 - ARM_DY]]));
    expect(renders.at(-1)).toEqual([expect.any(Number), true]);
    pull.start(ev([[100, 500 - ARM_DY], [200, 300]])); // pinch begins
    expect(renders.at(-1)).toEqual([0, false]);
    pull.move(ev([[100, 500 - ARM_DY - 40], [200, 280]]));
    pull.end(ev([[100, 500 - ARM_DY - 40]])); // one finger up
    const m = ev([[100, 100]]); // remaining finger keeps moving
    pull.move(m);
    pull.end(ev([])); // last finger up
    expect(m.preventDefault).not.toHaveBeenCalled();
    expect(deps.onTrigger).not.toHaveBeenCalled();
  });

  it("starting with two fingers never pulls", () => {
    const { pull, deps, ev } = setup();
    pull.start(ev([[100, 500], [200, 500]]));
    pull.move(ev([[100, 500 - ARM_DY], [200, 500 - ARM_DY]]));
    pull.end(ev([]));
    expect(deps.onTrigger).not.toHaveBeenCalled();
  });

  it("only tracks at the end; touchcancel resets without firing", () => {
    let atEnd = false;
    const { pull, deps, renders, ev } = setup({ atEnd: () => atEnd });
    pull.start(ev([[100, 500]]));
    const m = ev([[100, 400]]);
    pull.move(m);
    expect(m.preventDefault).not.toHaveBeenCalled();
    atEnd = true; // reached the end during this touch: the anchor starts here
    pull.move(ev([[100, 390]]));
    pull.move(ev([[100, 390 - ARM_DY]]));
    expect(renders.at(-1)?.[1]).toBe(true);
    pull.cancel();
    expect(renders.at(-1)).toEqual([0, false]);
    pull.end(ev([]));
    expect(deps.onTrigger).not.toHaveBeenCalled();
  });
});
