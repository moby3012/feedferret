// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSwipeRow, CLICK_SUPPRESS_MS } from "@/lib/gestures/swipe-row";
import { createPull } from "@/lib/gestures/pull";
import { resetGestureTracking } from "@/lib/gestures/guards";
import { LONG_PRESS_MS } from "@/lib/gestures/math";

// Gesture state machines driven by synthetic pointer / touch sequences
// (jsdom, fake timers): release-click suppression, central multi-pointer
// cancellation and pull-to-refresh cancel semantics.

type PointerInit = { id: number; x: number; y?: number; primary?: boolean; type?: string };

function pointer(target: EventTarget, type: string, p: PointerInit) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    pointerId: { value: p.id },
    isPrimary: { value: p.primary ?? true },
    button: { value: 0 },
    pointerType: { value: p.type ?? "touch" },
    clientX: { value: p.x },
    clientY: { value: p.y ?? 100 },
    timeStamp: { value: performance.now() },
  });
  target.dispatchEvent(e);
  return e;
}

function click(target: EventTarget) {
  const e = new MouseEvent("click", { bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

function touch(target: EventTarget, type: string, points: Array<{ x: number; y: number }>) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "touches", { value: points.map((p) => ({ clientX: p.x, clientY: p.y })) });
  target.dispatchEvent(e);
  return e;
}

/** Moves pointer `id` from `from` to `to` in `steps` moves spread over `ms`. */
function drag(target: EventTarget, id: number, from: number, to: number, ms: number, steps = 10) {
  for (let i = 1; i <= steps; i++) {
    vi.advanceTimersByTime(ms / steps);
    pointer(target, "pointermove", { id, x: from + ((to - from) * i) / steps });
  }
}

describe("swipe row sequences", () => {
  let row: HTMLElement;
  let content: HTMLElement;
  let other: HTMLElement;
  let commit: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
  let onLongPress: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
  let onClick: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
  let dispose: () => void;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
    resetGestureTracking();
    document.body.innerHTML = "";
    row = document.createElement("div");
    content = document.createElement("div");
    row.appendChild(content);
    other = document.createElement("div");
    document.body.append(row, other);
    row.getBoundingClientRect = () => ({ width: 300, height: 72, top: 0, left: 0, right: 300, bottom: 72, x: 0, y: 0, toJSON() {} }) as DOMRect;
    commit = vi.fn();
    onLongPress = vi.fn();
    onClick = vi.fn();
    row.addEventListener("click", onClick);
    dispose = createSwipeRow(row, {
      content,
      enabled: () => true,
      dir: () => "ltr",
      leading: () => ({ id: "read", commit }),
      trailing: () => ({ id: "later", commit }),
      onLongPress,
    });
  });

  afterEach(() => {
    dispose();
    vi.useRealTimers();
  });

  it("swallows the release click of a long swipe (> 600 ms between axis lock and release)", () => {
    pointer(content, "pointerdown", { id: 1, x: 100 });
    drag(content, 1, 100, 260, 1500, 20);
    expect(row.hasAttribute("data-swiping")).toBe(true);
    pointer(content, "pointerup", { id: 1, x: 260 });
    expect(commit).toHaveBeenCalledTimes(1);
    const e = click(content);
    expect(e.defaultPrevented).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("drops the guard after the sequence: a later click or a new tap goes through", () => {
    pointer(content, "pointerdown", { id: 1, x: 100 });
    drag(content, 1, 100, 140, 100, 4);
    pointer(content, "pointerup", { id: 1, x: 140 });
    vi.advanceTimersByTime(CLICK_SUPPRESS_MS + 10);
    click(content);
    expect(onClick).toHaveBeenCalledTimes(1);

    // A real tap right after a swipe (well within the window) is never eaten.
    pointer(content, "pointerdown", { id: 2, x: 100 });
    drag(content, 2, 100, 160, 100, 4);
    pointer(content, "pointerup", { id: 2, x: 160 });
    vi.advanceTimersByTime(50);
    pointer(content, "pointerdown", { id: 3, x: 100 });
    pointer(content, "pointerup", { id: 3, x: 100 });
    click(content);
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("a second pointer ANYWHERE cancels a locked swipe: nothing commits at release", () => {
    pointer(content, "pointerdown", { id: 1, x: 100 });
    drag(content, 1, 100, 200, 200);
    expect(row.hasAttribute("data-swiping")).toBe(true);
    pointer(other, "pointerdown", { id: 2, x: 600, primary: false });
    drag(content, 1, 200, 280, 100);
    pointer(content, "pointerup", { id: 1, x: 280 });
    pointer(other, "pointerup", { id: 2, x: 600, primary: false });
    expect(commit).not.toHaveBeenCalled();
  });

  it("a second pointer elsewhere while still pending: the sequence never locks", () => {
    pointer(content, "pointerdown", { id: 1, x: 100 });
    pointer(other, "pointerdown", { id: 2, x: 600, primary: false });
    drag(content, 1, 100, 260, 200);
    expect(row.hasAttribute("data-swiping")).toBe(false);
    pointer(content, "pointerup", { id: 1, x: 260 });
    pointer(other, "pointerup", { id: 2, x: 600, primary: false });
    expect(commit).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("no swipe starts while another pointer is already down; after both lift swipes work again", () => {
    pointer(other, "pointerdown", { id: 5, x: 600 });
    pointer(content, "pointerdown", { id: 6, x: 100, primary: false });
    drag(content, 6, 100, 260, 200);
    pointer(content, "pointerup", { id: 6, x: 260, primary: false });
    pointer(other, "pointerup", { id: 5, x: 600 });
    expect(commit).not.toHaveBeenCalled();

    pointer(content, "pointerdown", { id: 7, x: 100 });
    drag(content, 7, 100, 260, 200);
    pointer(content, "pointerup", { id: 7, x: 260 });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("long-press: menu opens; the lift click is swallowed however long the finger stays", () => {
    pointer(content, "pointerdown", { id: 1, x: 100 });
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    pointer(content, "pointerup", { id: 1, x: 100 });
    const e = click(content);
    expect(e.defaultPrevented).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("pointercancel (native scroll took over) springs back without committing", () => {
    pointer(content, "pointerdown", { id: 1, x: 100 });
    drag(content, 1, 100, 260, 200);
    pointer(content, "pointercancel", { id: 1, x: 260 });
    expect(commit).not.toHaveBeenCalled();
  });
});

describe("pull-to-refresh sequences", () => {
  let scroller: HTMLElement;
  let onTrigger: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
  let dispose: () => void;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
    resetGestureTracking();
    document.body.innerHTML = "";
    scroller = document.createElement("div");
    document.body.append(scroller);
    onTrigger = vi.fn();
    dispose = createPull(scroller, { edge: "top", enabled: () => true, onTrigger });
  });

  afterEach(() => {
    dispose();
    vi.useRealTimers();
  });

  const pullTo = (dy: number) => {
    touch(scroller, "touchstart", [{ x: 100, y: 100 }]);
    for (let y = 120; y <= 100 + dy; y += 20) touch(scroller, "touchmove", [{ x: 100, y }]);
    vi.advanceTimersByTime(20);
  };

  it("touchend past the trigger refreshes", () => {
    pullTo(300);
    expect(scroller.getAttribute("data-pull")).toBe("armed");
    touch(scroller, "touchend", []);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it("touchcancel past the trigger only resets — never refreshes", () => {
    pullTo(300);
    expect(scroller.getAttribute("data-pull")).toBe("armed");
    touch(scroller, "touchcancel", []);
    expect(onTrigger).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(scroller.hasAttribute("data-pull")).toBe(false);
    // The next touch starts clean: a short pull and release does nothing.
    touch(scroller, "touchstart", [{ x: 100, y: 100 }]);
    touch(scroller, "touchend", []);
    expect(onTrigger).not.toHaveBeenCalled();
  });
});

describe("pull past the end (reader → next article)", () => {
  let scroller: HTMLElement;
  let code: HTMLElement;
  let para: HTMLElement;
  let onTrigger: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
  let renders: Array<[number, string]>;
  let dispose: () => void;
  let scrollTop = 1000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
    resetGestureTracking();
    document.body.innerHTML = "";
    scroller = document.createElement("div");
    scrollTop = 1000; // at the end: scrollHeight 1600 − clientHeight 600
    Object.defineProperties(scroller, {
      scrollTop: { get: () => scrollTop, configurable: true },
      scrollHeight: { value: 1600, configurable: true },
      clientHeight: { value: 600, configurable: true },
    });
    para = document.createElement("p");
    code = document.createElement("pre");
    scroller.append(para, code);
    document.body.append(scroller);
    onTrigger = vi.fn();
    renders = [];
    dispose = createPull(scroller, { edge: "bottom", enabled: () => true, onTrigger, render: (px, state) => renders.push([px, state]) });
  });

  afterEach(() => {
    dispose();
    vi.useRealTimers();
  });

  /** Finger moves from y=500 upwards by `dy` (optionally sideways first). */
  const pullUp = (target: EventTarget, dy: number, dx = 0) => {
    touch(target, "touchstart", [{ x: 100, y: 500 }]);
    if (dx) touch(target, "touchmove", [{ x: 100 + dx, y: 500 }]);
    for (let d = 20; d <= dy; d += 20) touch(target, "touchmove", [{ x: 100 + dx, y: 500 - d }]);
    vi.advanceTimersByTime(20);
  };
  const lastState = () => renders.at(-1)?.[1] ?? "idle";

  it("an upward pull at the end arms, prevents native overscroll and fires once on release", () => {
    touch(para, "touchstart", [{ x: 100, y: 500 }]);
    touch(para, "touchmove", [{ x: 100, y: 480 }]);
    const move = touch(para, "touchmove", [{ x: 100, y: 200 }]);
    expect(move.defaultPrevented).toBe(true);
    vi.advanceTimersByTime(20);
    expect(lastState()).toBe("armed");
    touch(para, "touchend", []);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it("a short pull springs back without firing; a downward drag is native scrolling", () => {
    pullUp(para, 60);
    expect(lastState()).toBe("pulling");
    touch(para, "touchend", []);
    vi.advanceTimersByTime(2000);
    expect(lastState()).toBe("idle");
    touch(para, "touchstart", [{ x: 100, y: 500 }]);
    const down = touch(para, "touchmove", [{ x: 100, y: 600 }]);
    expect(down.defaultPrevented).toBe(false);
    touch(para, "touchend", []);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("never starts away from the end", () => {
    scrollTop = 400;
    pullUp(para, 300);
    touch(para, "touchend", []);
    expect(renders).toEqual([]);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("ignores touches that start in pannable content (pre / code / table)", () => {
    pullUp(code, 300);
    touch(code, "touchend", []);
    expect(renders).toEqual([]);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("axis lock: sideways first keeps the whole sequence out", () => {
    pullUp(para, 300, 30);
    touch(para, "touchend", []);
    expect(renders).toEqual([]);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("a second finger cancels an armed pull; lifting the fingers afterwards never fires", () => {
    pullUp(para, 300);
    expect(lastState()).toBe("armed");
    pointer(document, "pointerdown", { id: 1, x: 100, y: 200 });
    pointer(document, "pointerdown", { id: 2, x: 200, y: 300, primary: false });
    touch(para, "touchstart", [{ x: 100, y: 200 }, { x: 200, y: 300 }]);
    touch(para, "touchmove", [{ x: 100, y: 150 }, { x: 200, y: 250 }]);
    touch(para, "touchend", [{ x: 100, y: 150 }]);
    touch(para, "touchmove", [{ x: 100, y: 100 }]);
    touch(para, "touchend", []);
    vi.advanceTimersByTime(2000);
    expect(lastState()).toBe("idle");
    expect(onTrigger).not.toHaveBeenCalled();
  });
});
