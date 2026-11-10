import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
const tokens = read("app/styles/tokens.css");
const motion = read("app/styles/motion.css");
const globals = read("app/globals.css");

function px(v: string): number {
  return v.endsWith("rem") ? parseFloat(v) * 16 : parseFloat(v);
}

describe("tokens.css", () => {
  it("globals.css pulls in the token + motion files", () => {
    expect(globals).toMatch(/@import '\.\/styles\/tokens\.css'/);
    expect(globals).toMatch(/@import '\.\/styles\/motion\.css'/);
  });

  it("defines every colour role for light and dark", () => {
    const light = tokens.slice(tokens.indexOf(":root {"), tokens.indexOf(".dark {"));
    const dark = tokens.slice(tokens.indexOf(".dark {"), tokens.indexOf("/* Derived roles"));
    for (const role of ["--surface-base", "--surface-raised", "--surface-sunken", "--text-primary", "--text-secondary", "--divider", "--success", "--warning", "--scrim", "--scrim-reader"]) {
      expect(light, `${role} light`).toContain(`${role}:`);
      expect(dark, `${role} dark`).toContain(`${role}:`);
    }
    for (const role of ["--unread", "--accent-subtle"]) {
      expect(light).toContain(`${role}:`);
      expect(dark).toContain(`${role}:`);
    }
  });

  it("derives accent-dependent roles from --brand (user accent keeps working)", () => {
    expect(tokens).toMatch(/--accent-subtle:\s*color-mix\(in oklab, var\(--brand\)/);
    expect(tokens).toMatch(/\.dark \{[\s\S]*--unread:\s*var\(--brand\)/);
    expect(tokens).toMatch(/--unread:\s*var\(--primary\)/);
    // the applier-driven brand variables are only *declared* here, never re-pinned
    expect(tokens.match(/--brand:/g)?.length).toBe(1);
  });

  it("radius scale is monotonic and never inverted", () => {
    const get = (n: string) => px(new RegExp(`--radius-${n}:\\s*([\\d.]+(?:px|rem))`).exec(tokens)![1]);
    const legacy = ["sm", "md", "lg", "xl", "2xl", "3xl", "4xl"].map(get);
    for (let i = 1; i < legacy.length; i++) expect(legacy[i]).toBeGreaterThanOrEqual(legacy[i - 1]);
    const roles = ["chip", "control", "row", "panel", "sheet"].map(get);
    for (let i = 1; i < roles.length; i++) expect(roles[i]).toBeGreaterThan(roles[i - 1]);
    expect([get("2xl"), get("3xl")]).toEqual([20, 28]);
  });

  it("type scale never goes below 11px", () => {
    const sizes = [...tokens.matchAll(/--text-[\w-]+:\s*([\d.]+rem)/g)].map((m) => px(m[1]));
    expect(sizes.length).toBeGreaterThanOrEqual(9);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(11);
  });

  it("z-scale and blur levels exist exactly as specified", () => {
    for (const [k, v] of Object.entries({ sticky: 10, bar: 30, reader: 40, overlay: 50, toast: 60, skip: 100 })) {
      expect(tokens).toContain(`--z-${k}: ${v};`);
    }
    expect(tokens).toContain("--blur-bar: 20px;");
    expect(tokens).toContain("--blur-overlay: 28px;");
    expect(tokens).toMatch(/--hit-min: 44px/);
    for (const s of ["t", "r", "b", "l"]) expect(tokens).toContain(`--safe-${s}: env(safe-area-inset-`);
  });

  it("opaque fallbacks for reduced-transparency and missing backdrop-filter", () => {
    expect(tokens).toContain("prefers-reduced-transparency: reduce");
    expect(tokens).toContain("@supports not (backdrop-filter: blur(1px))");
  });
});

describe("motion", () => {
  it("duration tokens cap at 320ms", () => {
    const ds = [...motion.matchAll(/--dur-[\w]+:\s*(\d+)ms/g)].map((m) => Number(m[1]));
    expect(ds).toEqual([80, 140, 220, 320]);
    expect(Math.max(...ds)).toBe(320);
  });

  it("no animation/transition in CSS runs longer than 320ms (infinite loaders excepted)", () => {
    for (const [file, css] of [["globals", globals], ["motion", motion], ["tokens", tokens]] as const) {
      for (const m of css.matchAll(/(?:animation|transition)(?:-duration)?:\s*([^;]+);/g)) {
        if (/infinite/.test(m[1])) continue;
        for (const t of m[1].matchAll(/(?<![\w.-])(\d*\.?\d+)(ms|s)(?![\w-])/g)) {
          const ms = t[2] === "s" ? parseFloat(t[1]) * 1000 : parseFloat(t[1]);
          // delays are stagger offsets of the (to-be-deleted) .animation-delay-* helpers
          if (/animation-delay/.test(m[0])) continue;
          expect(ms, `${file}: ${m[0]}`).toBeLessThanOrEqual(320);
        }
      }
    }
  });

  it("reduced motion collapses enter/exit animations and spinners", () => {
    const block = motion.slice(motion.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toContain("animation-duration: 1ms !important");
    expect(block).toContain(".animate-in");
    expect(block).toContain(".animate-spin");
    expect(block).toContain("transition-duration: 1ms !important");
  });

  it("html no longer opts into smooth scrolling", () => {
    expect(globals).not.toMatch(/scroll-behavior:\s*smooth/);
  });
});
