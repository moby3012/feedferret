import { describe, expect, it } from "vitest";
import {
  COMMIT_RATIO,
  MAX_TRAVEL_RATIO,
  NO_ACTION_MAX_PX,
  PULL_MAX_PX,
  decideAxis,
  inEdgeInset,
  isArmed,
  pullDistance,
  shouldCommit,
  springStep,
  swipeProgress,
  swipeTravel,
  velocityOf,
  type SpringState,
} from "@/lib/gestures/math";

const W = 390;

describe("decideAxis", () => {
  it("stays undecided inside the 10 px slop", () => {
    expect(decideAxis(6, 6)).toBeNull();
    expect(decideAxis(10, 0)).toBeNull();
  });
  it("locks horizontal only when |dx| > 1.5·|dy|", () => {
    expect(decideAxis(16, 10)).toBe("x");
    expect(decideAxis(15, 10)).toBe("y");
    expect(decideAxis(-40, 2)).toBe("x");
  });
  it("a vertical drag with up to 30° drift never locks horizontal", () => {
    for (let deg = 0; deg <= 30; deg += 2) {
      const rad = (deg * Math.PI) / 180;
      for (const len of [11, 20, 60, 200]) {
        const dx = Math.sin(rad) * len;
        const dy = Math.cos(rad) * len;
        expect(decideAxis(dx, dy)).toBe("y");
        expect(decideAxis(-dx, -dy)).toBe("y");
      }
    }
  });
  it("even at the 1.5 ratio boundary (~56° from vertical) it is still vertical", () => {
    const rad = Math.atan(1.5);
    expect(decideAxis(Math.sin(rad) * 50 - 0.01, Math.cos(rad) * 50)).toBe("y");
  });
});

describe("inEdgeInset", () => {
  it("ignores the 24 px bands at both edges", () => {
    expect(inEdgeInset(10, W)).toBe(true);
    expect(inEdgeInset(23.9, W)).toBe(true);
    expect(inEdgeInset(24, W)).toBe(false);
    expect(inEdgeInset(W - 10, W)).toBe(true);
    expect(inEdgeInset(W / 2, W)).toBe(false);
  });
});

describe("swipeTravel", () => {
  it("is 1:1 up to the commit distance", () => {
    expect(swipeTravel(50, W, true)).toBe(50);
    expect(swipeTravel(-W * COMMIT_RATIO, W, true)).toBeCloseTo(-W * COMMIT_RATIO);
  });
  it("rubber-bands past the commit distance and caps at 60 % of the width", () => {
    const commit = W * COMMIT_RATIO;
    expect(swipeTravel(commit + 100, W, true)).toBeCloseTo(commit + 35);
    expect(swipeTravel(5000, W, true)).toBeCloseTo(W * MAX_TRAVEL_RATIO);
    expect(swipeTravel(-5000, W, true)).toBeCloseTo(-W * MAX_TRAVEL_RATIO);
  });
  it("a direction without an action moves ×0.2 and at most 24 px", () => {
    expect(swipeTravel(50, W, false)).toBeCloseTo(10);
    expect(swipeTravel(-1000, W, false)).toBe(-NO_ACTION_MAX_PX);
  });
});

describe("swipeProgress / isArmed", () => {
  it("progress reaches 1 at the commit distance", () => {
    expect(swipeProgress(0, W)).toBe(0);
    expect(swipeProgress((W * COMMIT_RATIO) / 2, W)).toBeCloseTo(0.5);
    expect(swipeProgress(-W, W)).toBe(1);
  });
  it("arms at 35 % of the width", () => {
    expect(isArmed(W * COMMIT_RATIO - 1, W)).toBe(false);
    expect(isArmed(-W * COMMIT_RATIO, W)).toBe(true);
  });
});

describe("velocityOf", () => {
  it("needs two samples", () => {
    expect(velocityOf([])).toBe(0);
    expect(velocityOf([{ x: 0, t: 0 }])).toBe(0);
  });
  it("measures px/ms over the last 100 ms only", () => {
    const samples = [
      { x: 0, t: 0 },
      { x: 10, t: 200 }, // outside the window relative to the last sample
      { x: 20, t: 250 },
      { x: 60, t: 300 },
    ];
    expect(velocityOf(samples)).toBeCloseTo((60 - 10) / 100);
  });
  it("is signed", () => {
    expect(velocityOf([{ x: 100, t: 0 }, { x: 40, t: 60 }])).toBeCloseTo(-1);
  });
});

describe("shouldCommit", () => {
  it("commits by distance (≥35 % of the width)", () => {
    expect(shouldCommit(W * COMMIT_RATIO, 0, W)).toBe(true);
    expect(shouldCommit(-W * COMMIT_RATIO, 0, W)).toBe(true);
    expect(shouldCommit(W * COMMIT_RATIO - 1, 0, W)).toBe(false);
  });
  it("commits a fast flick (≥0.5 px/ms, ≥24 px, same direction)", () => {
    expect(shouldCommit(30, 0.6, W)).toBe(true);
    expect(shouldCommit(-30, -0.6, W)).toBe(true);
    expect(shouldCommit(20, 0.9, W)).toBe(false); // too short
    expect(shouldCommit(30, 0.4, W)).toBe(false); // too slow
    expect(shouldCommit(30, -0.9, W)).toBe(false); // flicked back
  });
  it("never commits a zero delta", () => {
    expect(shouldCommit(0, 5, W)).toBe(false);
  });
});

describe("springStep", () => {
  it("settles at 0 from a released offset without overshooting wildly", () => {
    let s: SpringState | null = { x: 120, v: 0 };
    let frames = 0;
    let minX = Infinity;
    while (s && frames < 300) {
      s = springStep(s, 16);
      if (s) minX = Math.min(minX, s.x);
      frames++;
    }
    expect(s).toBeNull();
    expect(frames).toBeLessThan(120); // < 2 s at 60 fps
    expect(minX).toBeGreaterThan(-12); // c 32 on k 320 is close to critical damping
  });
  it("clamps huge frame gaps", () => {
    const s = springStep({ x: 100, v: 0 }, 5000);
    expect(s).not.toBeNull();
    expect(Number.isFinite(s!.x)).toBe(true);
  });
  it("is at rest below 0.5 px and 0.05 px/ms", () => {
    expect(springStep({ x: 0.1, v: 0 }, 16)).toBeNull();
  });
});

describe("pullDistance", () => {
  it("applies resistance and caps", () => {
    expect(pullDistance(-20)).toBe(0);
    expect(pullDistance(100)).toBeCloseTo(45);
    expect(pullDistance(1000)).toBe(PULL_MAX_PX);
  });
});
