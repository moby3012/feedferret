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
