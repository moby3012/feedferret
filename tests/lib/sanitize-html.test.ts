import { describe, it, expect } from "vitest";
import { getSanitizer, stripLayoutBreakingStyles } from "../../lib/sanitize-html";

describe("getSanitizer", () => {
  it("forces rel=noopener noreferrer on any link that keeps a target attribute", async () => {
    const DOMPurify = await getSanitizer();
    const clean = DOMPurify.sanitize('<a target="_blank" href="x">y</a>', { ADD_ATTR: ["target", "rel"] });
    expect(clean).toContain('rel="noopener noreferrer"');
  });

  it("strips width/min-width and escaping position values from inline style, end to end", async () => {
    const DOMPurify = await getSanitizer();
    const clean = DOMPurify.sanitize(
      '<div style="width: 1200px; min-width: 800px; position: fixed; top: 0; color: red;">x</div>',
    );
    expect(clean).not.toContain("width");
    expect(clean).not.toContain("position");
    // Unrelated declarations (and the now-inert top offset) survive.
    expect(clean).toContain("color");
  });

  it("removes width/min-width HTML attributes on img (not just the style attribute)", async () => {
    const DOMPurify = await getSanitizer();
    const clean = DOMPurify.sanitize('<img src="x.jpg" width="1200" min-width="200">');
    expect(clean).not.toMatch(/\bwidth=/);
    expect(clean).not.toMatch(/\bmin-width=/);
  });
});

// ── stripLayoutBreakingStyles (pure) ──────────────────────────────────────────
//
// Regression: a browser-rendered page (M7-T2 sidecar) carried a fixed/sticky
// positioned image element whose viewport-relative offset broke the reader's
// layout — a plain `overflow: hidden` ancestor does not clip position:fixed
// or position:sticky descendants, since those position relative to the
// viewport, not any ancestor.
describe("stripLayoutBreakingStyles", () => {
  it("drops width and min-width declarations, keeping max-width", () => {
    const result = stripLayoutBreakingStyles("width: 1200px; min-width: 600px; max-width: 100%;");
    expect(result).toBe("max-width: 100%");
  });

  it("is robust to whitespace and casing", () => {
    const result = stripLayoutBreakingStyles("  Min-Width : 600px ; COLOR: blue ");
    expect(result).toBe("COLOR: blue");
  });

  it("drops position:fixed, position:sticky, and position:absolute", () => {
    expect(stripLayoutBreakingStyles("position: fixed; top: 0;")).toBe("top: 0");
    expect(stripLayoutBreakingStyles("position: sticky; top: 0;")).toBe("top: 0");
    expect(stripLayoutBreakingStyles("position: absolute; left: 0;")).toBe("left: 0");
  });

  it("is case-insensitive for the position value too", () => {
    expect(stripLayoutBreakingStyles("position: Fixed;")).toBe("");
  });

  it("keeps position:relative and position:static (they don't escape normal flow)", () => {
    expect(stripLayoutBreakingStyles("position: relative;")).toBe("position: relative");
    expect(stripLayoutBreakingStyles("position: static;")).toBe("position: static");
  });

  it("preserves unrelated declarations untouched", () => {
    const result = stripLayoutBreakingStyles("color: red; font-weight: bold;");
    expect(result).toBe("color: red; font-weight: bold");
  });

  it("handles an empty string without throwing", () => {
    expect(stripLayoutBreakingStyles("")).toBe("");
  });
});
