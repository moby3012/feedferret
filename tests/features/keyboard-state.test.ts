import { describe, expect, it } from "vitest";
import { createKeyboardState } from "../../features/reader/layout/keyboard-inset";

const W = 390;

function booted() {
  const kb = createKeyboardState(120);
  kb.viewport(800, W);
  return kb;
}

describe("keyboard state", () => {
  it("opens on text focus and closes on blur", () => {
    const kb = booted();
    expect(kb.focus(true)).toBe(true);
    expect(kb.viewport(460, W)).toBe(true);
    expect(kb.focus(false)).toBe(false);
  });

  it("stays open while the keyboard is still animating in (no shrink seen yet)", () => {
    const kb = booted();
    kb.focus(true);
    expect(kb.viewport(790, W)).toBe(true);
  });

  it("closes when the keyboard is dismissed without a blur (Android Back)", () => {
    const kb = booted();
    kb.focus(true);
    kb.viewport(460, W);
    expect(kb.viewport(800, W)).toBe(false);
    expect(kb.isOpen()).toBe(false);
  });

  it("re-opens when the still-focused field brings the keyboard back", () => {
    const kb = booted();
    kb.focus(true);
    kb.viewport(460, W);
    kb.viewport(800, W);
    expect(kb.viewport(460, W)).toBe(true);
  });

  it("re-opens on a new focus after a dismissal", () => {
    const kb = booted();
    kb.focus(true);
    kb.viewport(460, W);
    kb.viewport(800, W);
    expect(kb.focus(true)).toBe(true);
  });

  it("moving focus between fields with the keyboard up keeps it open, and a later dismissal still closes", () => {
    const kb = booted();
    kb.focus(true);
    kb.viewport(460, W);
    kb.focus(false); // focusout → next frame: the second field already has focus
    expect(kb.focus(true)).toBe(true);
    expect(kb.viewport(800, W)).toBe(false);
  });

  it("a late post-focusout re-check does not re-open a keyboard dismissed without a blur", () => {
    const kb = booted();
    kb.focus(true); // focusin on the field
    kb.viewport(460, W);
    kb.viewport(800, W); // Android Back: dismissed, focus stays
    expect(kb.isOpen()).toBe(false);
    // the rAF queued by the previous element's focusout finally runs; the field still has focus
    expect(kb.settle(true)).toBe(false);
    expect(kb.isOpen()).toBe(false);
  });

  it("the post-focusout re-check still applies real focus changes", () => {
    const kb = booted();
    kb.focus(true);
    expect(kb.settle(false)).toBe(false); // focus left to a non-text element
    expect(kb.settle(true)).toBe(true); // …or landed in a field we had not seen
  });

  it("ignores URL-bar sized changes", () => {
    const kb = booted();
    kb.focus(true);
    kb.viewport(460, W);
    expect(kb.viewport(400, W)).toBe(true);
    expect(kb.viewport(520, W)).toBe(true);
  });

  it("a viewport shrink without focus never opens it", () => {
    const kb = booted();
    expect(kb.viewport(460, W)).toBe(false);
    expect(kb.viewport(800, W)).toBe(false);
  });

  it("rotation resets the reference height", () => {
    const kb = booted();
    kb.viewport(390, 800); // landscape
    kb.focus(true);
    kb.viewport(200, 800);
    expect(kb.viewport(390, 800)).toBe(false);
  });
});
