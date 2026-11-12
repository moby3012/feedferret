import { describe, expect, it } from "vitest";
import { parseFeedContentRules } from "@/lib/feed-content-rules";
import { evaluateFeedContentRules } from "@/lib/feed-content-rules-core";
import { applyFeedContentRules } from "@/lib/feed-content-rules-client";
import { generateOpml, parseOpml } from "@/lib/opml";
const json = (transforms: unknown[] = [], gates: unknown[] = []) => JSON.stringify({ transforms, gates });
describe("feed content rules", () => {
  it("rejects unsafe regex, invalid flags and oversized configs on save", () => {
    for (const pattern of ["(a+)+$", "("]) {
      expect(() => parseFeedContentRules(json([{ type: "replace_regex", pattern, replacement: "" }]))).toThrow();
    }
    expect(() => parseFeedContentRules(json([], [{ type: "title_include", pattern: "x", flags: "ii" }]))).toThrow();
    expect(() => parseFeedContentRules("x".repeat(33000))).toThrow();
  });
  it("preserves order, reuses CSS removal, removes markers and sanitizes replacement HTML", async () => {
    const rules = json([
      { type: "strip_selector", css: ".ad" },
      { type: "replace_regex", pattern: "old", replacement: "new", flags: "g" },
      { type: "strip_text_before", marker: "START" },
      { type: "strip_text_after", marker: "END" },
    ]);
    const [out] = await evaluateFeedContentRules({ rules, items: [{ title: "test", html: '<aside class="ad">old</aside>START<p>old</p>END<footer>old</footer>' }] });
    expect(out.html).toBe("<p>new</p>");
    expect(out.allowed).toBe(true);
  });
  it("gates original visible text before transforms; missing numeric captures fail closed", async () => {
    const rules = json([{ type: "strip_text_after", marker: "Score:" }], [
      { type: "title_include", pattern: "news", flags: "i" },
      { type: "title_exclude", pattern: "sponsor", flags: "i" },
      { type: "numeric_min", pattern: "(\\d+) points", minimum: 100 },
    ]);
    const out = await evaluateFeedContentRules({ rules, items: [
      { title: "News", html: "Body Score:100 points" },
      { title: "News", html: "99 points" },
      { title: "Sponsor news", html: "100 points" },
      { title: "News", html: "<img alt='999 points'>Body" },
    ] });
    expect(out.map(x => x.allowed)).toEqual([true, false, false, false]);
    expect(out[0].html).toBe("Body ");
  });
  it("runs the same evaluator through a bounded worker", async () => {
    const [out] = await applyFeedContentRules([{ title: "News", html: "<p>old</p>" }], json([{ type: "replace_regex", pattern: "old", replacement: "new" }]));
    expect(out.html).toBe("<p>new</p>");
  });
  it("round trips custom rules alongside existing FreshRSS CSS/read filters", async () => {
    const contentRules = json([{ type: "strip_text_after", marker: "Footer" }]);
    const xml = generateOpml([{ name: "Synthetic", url: "https://example.com/feed", contentRules, fullTextRemoveSelectors: ".ad", filtersActionRead: "sponsor" }]);
    const [outline] = await parseOpml(xml);
    expect(outline.extensions?.contentRules).toBe(contentRules);
    expect(outline.extensions?.cssContentFilter).toBe(".ad");
    expect(outline.extensions?.filtersActionRead).toBe("sponsor");
  });
});
