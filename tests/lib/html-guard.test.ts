import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { DEFAULT_HTML_GUARD_LIMITS, guardHtml } from "@/lib/html-guard";

const MiB = 1024 * 1024;

function corpus(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.html?$/.test(name)) files.push(p);
    }
  };
  walk(join(process.cwd(), "tests/fixtures"));
  return files;
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

describe("guardHtml", () => {
  it("passes every page of the fixture corpus through unchanged, with a wide margin", () => {
    const files = corpus();
    expect(files.length).toBeGreaterThan(40);
    for (const file of files) {
      const html = readFileSync(file, "utf8");
      const result = guardHtml(html);
      expect(result.truncatedBy, file).toBeNull();
      expect(result.html).toBe(html);
      // Calibration margin (see DEFAULT_HTML_GUARD_LIMITS): real pages stay far below.
      expect(result.stats.maxDepth, file).toBeLessThan(DEFAULT_HTML_GUARD_LIMITS.maxDepth / 2.5);
      expect(result.stats.elements, file).toBeLessThan(DEFAULT_HTML_GUARD_LIMITS.maxElements / 3);
      expect(result.stats.work, file).toBeLessThan(DEFAULT_HTML_GUARD_LIMITS.maxWork / 4);
    }
  });

  it("cuts 1 MiB of nested <div>s at the depth limit, before the offending tag", () => {
    const { value, ms } = timed(() => guardHtml("<div>".repeat(MiB / 5)));
    expect(value.truncatedBy).toBe("depth");
    expect(value.html).toBe("<div>".repeat(DEFAULT_HTML_GUARD_LIMITS.maxDepth));
    expect(ms).toBeLessThan(200);
    // The cut document is cheap for jsdom (the uncut one overflows its stack).
    const parse = timed(() => new JSDOM(value.html));
    expect(parse.ms).toBeLessThan(1_500);
  });

  it("bounds elements × depth (the real cost driver), not only depth", () => {
    const hostile = "<div>".repeat(100) + "<p>x".repeat(MiB / 4);
    const { value } = timed(() => guardHtml(hostile));
    expect(value.truncatedBy).toBe("work");
    expect(value.stats.work).toBeLessThanOrEqual(DEFAULT_HTML_GUARD_LIMITS.maxWork);
    const parse = timed(() => new JSDOM(value.html));
    expect(parse.ms).toBeLessThan(3_000);
  });

  it("caps the element count of a flat flood and the input size", () => {
    expect(guardHtml("<p>a</p>".repeat(MiB / 8)).truncatedBy).toBe("elements");
    const big = guardHtml("x".repeat(3 * MiB));
    expect(big.truncatedBy).toBe("size");
    expect(big.html.length).toBe(DEFAULT_HTML_GUARD_LIMITS.maxChars);
  });

  it("is linear: unmatched close tags under a deep stack stay cheap", () => {
    const hostile = "<div>".repeat(120) + "</b>".repeat((2 * MiB - 600) / 4);
    const { value, ms } = timed(() => guardHtml(hostile));
    expect(value.truncatedBy).toBeNull();
    expect(ms).toBeLessThan(500);
  });

  it("models implied end tags and void elements (no false depth on sloppy markup)", () => {
    const sloppy = "<ul>" + "<li>item <img src=x><br>".repeat(5_000) + "</ul>" + "<p>para".repeat(5_000) + "<table>" + "<tr><td>a<td>b".repeat(3_000) + "</table>";
    const result = guardHtml(sloppy);
    expect(result.truncatedBy).toBeNull();
    expect(result.stats.maxDepth).toBeLessThan(6);
  });

  it("does not count raw-text content (script / style) as markup", () => {
    const result = guardHtml(`<script>${"<div>".repeat(10_000)}</script><p>ok</p>`);
    expect(result.truncatedBy).toBeNull();
    expect(result.stats.elements).toBe(2);
  });

  it("xml mode: self-closing elements close, deep nesting is cut", () => {
    const flat = `<opml><body>${'<outline text="a"/>'.repeat(5_000)}</body></opml>`;
    expect(guardHtml(flat, { xml: true }).stats.maxDepth).toBe(3);
    // HTML semantics would treat each `<outline/>` as an open element.
    expect(guardHtml(flat).truncatedBy).toBe("depth");
    expect(guardHtml(`<opml>${"<outline>".repeat(2_000)}`, { xml: true }).truncatedBy).toBe("depth");
  });
});
