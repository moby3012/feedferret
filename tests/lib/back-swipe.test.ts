// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACK_SHADE_MAX,
  BACK_WRONG_WAY_MAX_PX,
  backCommitDuration,
  backParallaxOffset,
  backReducedOpacity,
  backShadeOpacity,
  backSwipeMayStart,
  backSwipeProgress,
  backSwipeTravel,
  detectBackSwipeEnvironment,
  isBackArmed,
  osOwnsEdgeBack,
  shouldCommitBack,
} from "@/lib/gestures/back-swipe-math";
import { createBackSwipe } from "@/lib/gestures/back-swipe";
import { resetGestureTracking } from "@/lib/gestures/guards";
import { EDGE_INSET_PX } from "@/lib/gestures/math";

// Reader swipe-back: the pure decision rules, then the state machine driven by
// synthetic pointer sequences (jsdom, fake timers).

const W = 390;
const TAB = { ios: true, standalone: false };
const STANDALONE = { ios: true, standalone: true };
const ANDROID = { ios: false, standalone: true };

describe("back swipe decisions", () => {
  it("lets the OS own the edges except in an iOS home-screen app", () => {
    expect(osOwnsEdgeBack(TAB)).toBe(true);
    expect(osOwnsEdgeBack(ANDROID)).toBe(true);
    expect(osOwnsEdgeBack(STANDALONE)).toBe(false);
    expect(backSwipeMayStart(EDGE_INSET_PX - 1, W, TAB)).toBe(false);
    expect(backSwipeMayStart(W - 2, W, ANDROID)).toBe(false);
    expect(backSwipeMayStart(EDGE_INSET_PX + 1, W, TAB)).toBe(true);
    expect(backSwipeMayStart(2, W, STANDALONE)).toBe(true);
  });

  it("detects iOS (incl. iPadOS desktop UA) and standalone", () => {
    expect(detectBackSwipeEnvironment({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", maxTouchPoints: 5, standalone: true }, false)).toEqual(STANDALONE);
    expect(detectBackSwipeEnvironment({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 5 }, true)).toEqual(STANDALONE);
    expect(detectBackSwipeEnvironment({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 0 }, false)).toEqual({ ios: false, standalone: false });
    expect(detectBackSwipeEnvironment({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7)", maxTouchPoints: 5 }, true)).toEqual(ANDROID);
  });

  it("follows the finger 1:1 towards back, capped at the width; the other way barely twitches", () => {
    expect(backSwipeTravel(100, W)).toBe(100);
    expect(backSwipeTravel(W + 50, W)).toBe(W);
    expect(backSwipeTravel(-40, W)).toBeCloseTo(-6);
    expect(backSwipeTravel(-400, W)).toBe(-BACK_WRONG_WAY_MAX_PX);
    expect(backSwipeProgress(W / 2, W)).toBe(0.5);
    expect(backSwipeProgress(-10, W)).toBe(0);
  });

  it("commits past 35 % of the width or on a forward flick, never backwards", () => {
    expect(shouldCommitBack(W * 0.35, 0, W)).toBe(true);
    expect(shouldCommitBack(W * 0.34, 0, W)).toBe(false);
    expect(shouldCommitBack(40, 0.8, W)).toBe(true); // flick
    expect(shouldCommitBack(40, -0.8, W)).toBe(false); // finger reversed at the end
    expect(shouldCommitBack(10, 2, W)).toBe(false); // too short for a flick
    expect(shouldCommitBack(-200, -2, W)).toBe(false);
    expect(shouldCommitBack(0, 0, W)).toBe(false);
    expect(isBackArmed(W * 0.35, W)).toBe(true);
    expect(isBackArmed(-W, W)).toBe(false);
  });

  it("parallax + shade go from start values to 0 as the reader leaves", () => {
    expect(backParallaxOffset(0, W)).toBeCloseTo(-W / 4);
    expect(backParallaxOffset(1, W)).toBeCloseTo(0);
    expect(backShadeOpacity(0)).toBe(BACK_SHADE_MAX);
    expect(backShadeOpacity(1)).toBe(0);
    expect(backReducedOpacity(0, W)).toBe(1);
    expect(backReducedOpacity(W, W)).toBe(0.5);
  });

  it("commit slide takes 120–220 ms", () => {
    expect(backCommitDuration(300, 0)).toBe(220);
    expect(backCommitDuration(50, 3)).toBe(120);
    expect(backCommitDuration(200, 1.5)).toBeGreaterThanOrEqual(120);
  });
});

type PointerInit = { id: number; x: number; y?: number; primary?: boolean; type?: string };
function pointer(target: EventTarget, type: string, p: PointerInit) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    pointerId: { value: p.id },
    isPrimary: { value: p.primary ?? true },
    button: { value: 0 },
    pointerType: { value: p.type ?? "touch" },
    clientX: { value: p.x },
    clientY: { value: p.y ?? 300 },
    timeStamp: { value: performance.now() },
  });
  target.dispatchEvent(e);
}
function drag(target: EventTarget, id: number, from: number, to: number, ms: number, opts: { steps?: number; dy?: number } = {}) {
  const steps = opts.steps ?? 10;
  for (let i = 1; i <= steps; i++) {
    vi.advanceTimersByTime(ms / steps);
    pointer(target, "pointermove", { id, x: from + ((to - from) * i) / steps, y: 300 + ((opts.dy ?? 0) * i) / steps });
  }
}

describe("back swipe sequences", () => {
  let surface: HTMLElement;
  let under: HTMLElement;
  let onCommit: ReturnType<typeof vi.fn<() => void>>;
  let onStart: ReturnType<typeof vi.fn<() => void>>;
  let enabled: boolean;
  let blocked = false;
  let env = TAB;
  let swipe: ReturnType<typeof createBackSwipe>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
    resetGestureTracking();
    Object.defineProperty(window, "innerWidth", { value: W, configurable: true });
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    document.body.innerHTML = `<div id="list"></div><section id="pane"><p id="text">Text</p><pre id="code">code</pre><input id="field"></section>`;
    surface = document.getElementById("pane")!;
    under = document.getElementById("list")!;
    surface.getBoundingClientRect = () => ({ width: W, height: 800, left: 0, top: 0, right: W, bottom: 800, x: 0, y: 0, toJSON() {} }) as DOMRect;
    enabled = true;
    blocked = false;
    env = TAB;
    onCommit = vi.fn();
    onStart = vi.fn();
    swipe = createBackSwipe(surface, { enabled: () => enabled, dir: () => "ltr", under: () => under, onStart, onCommit, blocked: () => blocked, environment: () => env });
  });
  afterEach(() => {
    swipe.destroy();
    vi.useRealTimers();
  });

  const text = () => document.getElementById("text")!;

  it("a long right swipe drags the reader + list and commits after the slide-out", () => {
    pointer(text(), "pointerdown", { id: 1, x: 100 });
    drag(text(), 1, 100, 160, 80);
    vi.advanceTimersByTime(16);
    expect(surface.dataset.backSwipe).toBe("drag");
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(surface.style.transform).toMatch(/translate3d\(\d+(\.\d)?px/);
    expect(under.style.transform).toMatch(/translate3d\(-\d+(\.\d)?px/);
    drag(text(), 1, 160, 300, 300);
    pointer(text(), "pointerup", { id: 1, x: 300 });
    expect(surface.dataset.backSwipe).toBe("commit");
    expect(onCommit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400); // rAF + slide + transitionend fallback
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(surface.dataset.backSwipe).toBe("done");
    expect(surface.style.transform).toBe(`translate3d(${W.toFixed(1)}px,0,0)`);
    swipe.reset();
    expect(surface.style.transform).toBe("");
    expect(under.style.transform).toBe("");
    expect(surface.hasAttribute("data-back-swipe")).toBe(false);
  });

  it("a fast short flick commits", () => {
    pointer(text(), "pointerdown", { id: 1, x: 100 });
    drag(text(), 1, 100, 180, 60, { steps: 4 });
    pointer(text(), "pointerup", { id: 1, x: 180 });
    vi.advanceTimersByTime(400);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("a slow short swipe springs back without committing", () => {
    pointer(text(), "pointerdown", { id: 1, x: 100 });
    drag(text(), 1, 100, 180, 800);
    vi.advanceTimersByTime(200); // let the velocity window expire: finger rests
    pointer(text(), "pointerup", { id: 1, x: 180 });
    vi.advanceTimersByTime(2000);
    expect(onCommit).not.toHaveBeenCalled();
    expect(surface.style.transform).toBe("");
    expect(surface.hasAttribute("data-back-swipe")).toBe(false);
  });

  it("vertical movement never locks", () => {
    pointer(text(), "pointerdown", { id: 1, x: 100 });
    drag(text(), 1, 100, 130, 200, { dy: -200 });
    pointer(text(), "pointerup", { id: 1, x: 130 });
    vi.advanceTimersByTime(500);
    expect(surface.hasAttribute("data-back-swipe")).toBe(false);
    expect(onStart).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("a left swipe does nothing", () => {
    pointer(text(), "pointerdown", { id: 1, x: 300 });
    drag(text(), 1, 300, 50, 100);
    pointer(text(), "pointerup", { id: 1, x: 50 });
    vi.advanceTimersByTime(500);
    expect(onStart).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("ignores starts in pannable content, form fields, by mouse, when disabled", () => {
    for (const id of ["code", "field"]) {
      const el = document.getElementById(id)!;
      pointer(el, "pointerdown", { id: 1, x: 100 });
      drag(el, 1, 100, 350, 100);
      pointer(el, "pointerup", { id: 1, x: 350 });
    }
    pointer(text(), "pointerdown", { id: 2, x: 100, type: "mouse" });
    drag(text(), 2, 100, 350, 100);
    pointer(text(), "pointerup", { id: 2, x: 350, type: "mouse" });
    enabled = false;
    pointer(text(), "pointerdown", { id: 3, x: 100 });
    drag(text(), 3, 100, 350, 100);
    pointer(text(), "pointerup", { id: 3, x: 350 });
    vi.advanceTimersByTime(500);
    expect(onStart).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("edge starts: ignored where the OS owns the edge, handled in an iOS home-screen app", () => {
    pointer(text(), "pointerdown", { id: 1, x: 5 });
    drag(text(), 1, 5, 300, 100);
    pointer(text(), "pointerup", { id: 1, x: 300 });
    vi.advanceTimersByTime(500);
    expect(onCommit).not.toHaveBeenCalled();
    env = STANDALONE;
    pointer(text(), "pointerdown", { id: 2, x: 5 });
    drag(text(), 2, 5, 300, 100);
    pointer(text(), "pointerup", { id: 2, x: 300 });
    vi.advanceTimersByTime(500);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("a second finger cancels the drag (pinch) and springs back", () => {
    pointer(text(), "pointerdown", { id: 1, x: 100 });
    drag(text(), 1, 100, 250, 100);
    expect(surface.dataset.backSwipe).toBe("drag");
    pointer(document.body, "pointerdown", { id: 2, x: 200, primary: false });
    pointer(text(), "pointerup", { id: 1, x: 250 });
    vi.advanceTimersByTime(2000);
    expect(onCommit).not.toHaveBeenCalled();
    expect(surface.hasAttribute("data-back-swipe")).toBe(false);
  });

  it("shades the list underneath (not a pseudo outside the clipped reader)", () => {
    pointer(text(), "pointerdown", { id: 1, x: 100 });
    drag(text(), 1, 100, 160, 80);
    vi.advanceTimersByTime(16);
    expect(under.hasAttribute("data-back-shade")).toBe(true);
    expect(Number(under.style.getPropertyValue("--back-shade"))).toBeGreaterThan(0);
    pointer(text(), "pointercancel", { id: 1, x: 160 });
    vi.advanceTimersByTime(2000);
    expect(under.hasAttribute("data-back-shade")).toBe(false);
  });

  it("an open overlay blocks the start, cancels a running drag, and stops a commit", () => {
    blocked = true;
    pointer(text(), "pointerdown", { id: 1, x: 100 });
    drag(text(), 1, 100, 350, 100);
    pointer(text(), "pointerup", { id: 1, x: 350 });
    vi.advanceTimersByTime(500);
    expect(onStart).not.toHaveBeenCalled();
    expect(surface.hasAttribute("data-back-swipe")).toBe(false);

    blocked = false;
    pointer(text(), "pointerdown", { id: 2, x: 100 });
    drag(text(), 2, 100, 200, 80);
    expect(surface.dataset.backSwipe).toBe("drag");
    blocked = true; // overlay opens mid-gesture
    drag(text(), 2, 200, 350, 80);
    pointer(text(), "pointerup", { id: 2, x: 350 });
    vi.advanceTimersByTime(2000);
    expect(onCommit).not.toHaveBeenCalled();
    expect(surface.style.transform).toBe("");

    blocked = false;
    pointer(text(), "pointerdown", { id: 3, x: 100 });
    drag(text(), 3, 100, 350, 100);
    pointer(text(), "pointerup", { id: 3, x: 350 });
    expect(surface.dataset.backSwipe).toBe("commit");
    blocked = true; // overlay opens during the slide-out
    vi.advanceTimersByTime(500);
    expect(onCommit).not.toHaveBeenCalled();
    expect(surface.style.transform).toBe("");
    expect(surface.hasAttribute("data-back-swipe")).toBe(false);
  });

  it("swallows the release click after a swipe", () => {
    const onClick = vi.fn();
    text().addEventListener("click", onClick);
    pointer(text(), "pointerdown", { id: 1, x: 100 });
    drag(text(), 1, 100, 140, 300);
    vi.advanceTimersByTime(200);
    pointer(text(), "pointerup", { id: 1, x: 140 });
    text().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onClick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    text().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("swipe-back pref", () => {
  beforeEach(() => vi.resetModules());
  it("defaults on and persists off as '0'", async () => {
    localStorage.clear();
    const prefs = await import("@/lib/gestures/prefs");
    expect(prefs.getGesturePrefs().swipeBack).toBe(true);
    prefs.setGesturePref("swipeBack", false);
    expect(localStorage.getItem("ff:swipe-back")).toBe("0");
    expect(prefs.getGesturePrefs().swipeBack).toBe(false);
  });
});
