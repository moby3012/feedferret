import { describe, it, expect } from "vitest";
import { parseContentFilterTerms, articleMatchesContentFilter } from "../../lib/feed-content-filter";

describe("parseContentFilterTerms", () => {
  it("splits on newlines, trims, lowercases, and drops empties", () => {
    expect(parseContentFilterTerms("Sport\n  Politics \n\nCRYPTO\n")).toEqual(["sport", "politics", "crypto"]);
  });

  it("de-duplicates case-insensitively", () => {
    expect(parseContentFilterTerms("AI\nai\nAi")).toEqual(["ai"]);
  });

  it("returns an empty list for null/empty input", () => {
    expect(parseContentFilterTerms(null)).toEqual([]);
    expect(parseContentFilterTerms("")).toEqual([]);
    expect(parseContentFilterTerms("   \n  ")).toEqual([]);
  });
});

describe("articleMatchesContentFilter", () => {
  const terms = ["sponsored", "crypto"];

  it("matches on the title (case-insensitive)", () => {
    expect(articleMatchesContentFilter({ title: "SPONSORED: buy now" }, terms)).toBe(true);
  });

  it("matches on the excerpt", () => {
    expect(articleMatchesContentFilter({ title: "News", excerpt: "all about crypto today" }, terms)).toBe(true);
  });

  it("matches a term hidden only in the body, ignoring HTML tags", () => {
    expect(
      articleMatchesContentFilter({ title: "News", excerpt: "", content: "<p>A <b>crypto</b> story</p>" }, terms),
    ).toBe(true);
  });

  it("does not match tag or attribute names", () => {
    // 'crypto' only appears as real text above; a bare tag like <script> must not match a 'script' term.
    expect(articleMatchesContentFilter({ title: "Hello", content: "<script>x()</script>" }, ["script"])).toBe(false);
  });

  it("returns false when nothing matches", () => {
    expect(articleMatchesContentFilter({ title: "Weather", excerpt: "sunny", content: "<p>nice day</p>" }, terms)).toBe(false);
  });

  it("returns false for an empty term list", () => {
    expect(articleMatchesContentFilter({ title: "anything" }, [])).toBe(false);
  });
});
