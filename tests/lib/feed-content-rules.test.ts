import { describe, expect, it } from "vitest";
import { parseFeedContentRules, normalizeFeedContentRules, hasFeedContentRules } from "@/lib/feed-content-rules";
import { evaluateFeedContentRules } from "@/lib/feed-content-rules-core";
import { applyFeedContentRules } from "@/lib/feed-content-rules-client";
import { generateOpml, parseOpml } from "@/lib/opml";
const json = (transforms: unknown[] = [], gates: unknown[] = []) => JSON.stringify({ transforms, gates });
describe("feed content rules", () => {
  it("normalizes empty configurations to null and disables legacy empty JSON at runtime", () => {
    for (const raw of [null, "", "{}", '{"transforms":[]}', '{"gates":[]}', '{"transforms":[],"gates":[]}']) {
      expect(normalizeFeedContentRules(raw)).toBeNull();
      expect(hasFeedContentRules(raw)).toBe(false);
    }
    const active = json([{ type: "strip_selector", css: ".ad" }]);
    expect(normalizeFeedContentRules(active)).toBe(active);
    expect(hasFeedContentRules(active)).toBe(true);
    expect(hasFeedContentRules("invalid")).toBe(true); // worker must report invalid_rules
    expect(() => normalizeFeedContentRules("invalid")).toThrow();
  });
  it("uses default sanitizer output for invalid stored rules, including newly rejected regex", async () => {
    for (const rules of ["invalid JSON", json([], [{ type: "title_include", pattern: "(a|aa)+$" }])]) {
      const out = await evaluateFeedContentRules({ rules, removeSelectors: ".ad", items: [{ title: "T", html: '<p onclick="evil()">Safe</p><div class="ad">Ad</div><script>evil()</script>' }] });
      expect(out[0]).toMatchObject({ html: "<p>Safe</p>", allowed: true, rulesSkipped: "invalid_rules" });
    }
  });
  it("rejects unsafe regex, invalid flags and oversized configs on save", () => {
    for (const pattern of ["(a+)+$", "(", "(a|aa)+$", "(a|a)*$", "(a*)\\1+b", "a.*a.*a.*a.*a.*a.*b", "(.*)(.*)(.*)(.*)(.*)(.*)z", "(?<=a+)b"]) {
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
