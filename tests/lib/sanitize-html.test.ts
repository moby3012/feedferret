import { describe, it, expect } from "vitest";
import { getSanitizer, sanitizeTrustedRendererHtml, stripLayoutBreakingStyles } from "../../lib/sanitize-html";

describe("getSanitizer", () => {
  it("forces rel=noopener noreferrer on any link that keeps a target attribute", async () => {
    const DOMPurify = await getSanitizer();
    const clean = DOMPurify.sanitize('<a target="_blank" href="x">y</a>', { ADD_ATTR: ["target", "rel"] });
    expect(clean).toContain('rel="noopener noreferrer"');
  });

  it("strips width/min-width, escaping position values, and color from inline style, end to end", async () => {
    const DOMPurify = await getSanitizer();
    const clean = DOMPurify.sanitize(
      '<div style="width: 1200px; min-width: 800px; position: fixed; top: 0; color: red;">x</div>',
    );
    expect(clean).not.toContain("width");
    expect(clean).not.toContain("position");
    expect(clean).not.toContain("color");
    // Offsets are not on the allowlist either (only KaTeX may use `top`).
    expect(clean).not.toContain("top");
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
    const result = stripLayoutBreakingStyles("  Min-Width : 600px ; COLOR: blue ; FONT-WEIGHT: bold ");
    expect(result).toBe("FONT-WEIGHT: bold");
  });

  it("drops every position value and offsets (allowlist, #263 review)", () => {
    expect(stripLayoutBreakingStyles("position: fixed; top: 0;")).toBe("");
    expect(stripLayoutBreakingStyles("position: sticky; top: 0;")).toBe("");
    expect(stripLayoutBreakingStyles("position: absolute; left: 0;")).toBe("");
    expect(stripLayoutBreakingStyles("position: fixed !important; z-index: 99999")).toBe("");
  });

  it("is case-insensitive for the position value too", () => {
    expect(stripLayoutBreakingStyles("position: Fixed;")).toBe("");
  });

  it("keeps position:relative and top only for KaTeX markup", () => {
    expect(stripLayoutBreakingStyles("position: relative; top: -1em")).toBe("");
    expect(stripLayoutBreakingStyles("position: relative; top: -1em", true)).toBe("position: relative; top: -1em");
    expect(stripLayoutBreakingStyles("position: fixed", true)).toBe("");
  });

  it("preserves unrelated declarations untouched", () => {
    const result = stripLayoutBreakingStyles("font-weight: bold; text-decoration: underline;");
    expect(result).toBe("font-weight: bold; text-decoration: underline");
  });

  it("handles an empty string without throwing", () => {
    expect(stripLayoutBreakingStyles("")).toBe("");
  });

  // Regression: source pages hardcode text/background colors (e.g. dark-gray
  // text tuned for a white page background) that survive sanitization and
  // outrank our prose/dark-mode CSS on specificity, rendering as
  // near-black-on-dark in our reader's dark mode.
  it("drops color, background, and background-color declarations", () => {
    expect(stripLayoutBreakingStyles("color: #333; font-weight: bold;")).toBe("font-weight: bold");
    expect(stripLayoutBreakingStyles("background: white; color: black;")).toBe("");
    expect(stripLayoutBreakingStyles("background-color: #fff;")).toBe("");
  });
});

// ── CSS fetch / escape vectors (security review of #263) ─────────────────────
describe("inline style allowlist", () => {
  it.each([
    "background-image: url(https://attacker.example/open?id=1)",
    "background: url('https://attacker.example/o.gif')",
    "list-style-image: url(https://attacker.example/o.gif)",
    "list-style: square url(https://attacker.example/o.gif)",
    "border-image: url(https://attacker.example/o.gif) 30",
    "font-family: image-set('https://attacker.example/o.gif' 1x)",
    "margin: \\75 rl(https://attacker.example/o.gif)",
    "font-weight: bold !important",
    "font-size: expression(alert(1))",
    "z-index: 2147483647",
    "-moz-binding: url(x.xml#a)",
    "content: 'x'",
    "cursor: url(https://attacker.example/c.cur), auto",
    "margin: /* */ 0",
    "padding: var(--x, url(https://attacker.example/o.gif))",
  ])("drops %s", (decl) => {
    expect(stripLayoutBreakingStyles(decl)).toBe("");
  });

  it("keeps legitimate typography, alignment, spacing and borders", () => {
    const style = "font-weight: bold; font-style: italic; text-align: center; line-height: 1.5; margin: 0 auto; padding: 4px 8px; border: 1px solid rgb(200, 200, 200); max-width: 100%; vertical-align: middle; font-size: calc(1em + 2px)";
    expect(stripLayoutBreakingStyles(style)).toBe(style);
  });

  it("removes <style> elements and background attributes end to end", async () => {
    const DOMPurify = await getSanitizer();
    const clean = DOMPurify.sanitize(
      '<style>body{background:url(https://attacker.example/s.gif)}</style><table background="https://attacker.example/t.gif"><tr><td style="background-image:url(https://attacker.example/i.gif);font-weight:bold">x</td></tr></table><svg><style>*{fill:red}</style></svg>',
    );
    expect(clean).not.toContain("attacker.example");
    expect(clean).not.toContain("<style");
    expect(clean).toContain("font-weight:bold");
  });
});

// ── KaTeX exemption only for our own renderer (re-review of #263) ───────────
describe("KaTeX layout exemption", () => {
  const forged = '<div class="katex" style="position:relative;top:-500px;height:1000px;width:5000px;min-width:4000px"><span class="katex-html" style="top:-9999px;position:relative">x</span></div><img class="katex" width="9000" src="https://example.com/a.png">';

  it("does not trust a forged .katex class in untrusted HTML", async () => {
    const DOMPurify = await getSanitizer();
    const clean = DOMPurify.sanitize(forged);
    expect(clean).not.toMatch(/position|top:|width/);
    expect(clean).toContain("height:1000px"); // plain allowlisted property, clipped by the reader box
  });

  it("keeps KaTeX layout only inside the trusted renderer pass, and resets afterwards", async () => {
    const trusted = await sanitizeTrustedRendererHtml('<span class="katex"><span style="position:relative;top:-0.5em;width:2em">x</span></span>');
    expect(trusted).toContain("position:relative");
    expect(trusted).toContain("top:-0.5em");
    const DOMPurify = await getSanitizer();
    expect(DOMPurify.sanitize(forged)).not.toMatch(/position|top:/);
  });
});
