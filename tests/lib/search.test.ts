import { describe, it, expect } from "vitest";
import { tokenizeSearch, parseDateToken } from "../../lib/search";

// ── tokenizeSearch ────────────────────────────────────────────────────────────

describe("tokenizeSearch", () => {
  it("splits bare keywords on whitespace", () => {
    expect(tokenizeSearch("foo bar baz")).toEqual(["foo", "bar", "baz"]);
  });

  it("keeps a double-quoted phrase as one token", () => {
    expect(tokenizeSearch('"exact phrase"')).toEqual(["exact phrase"]);
  });

  it("keeps a single-quoted phrase as one token", () => {
    expect(tokenizeSearch("'exact phrase'")).toEqual(["exact phrase"]);
  });

  it("mixes quoted and bare tokens", () => {
    expect(tokenizeSearch('hello "world news" today')).toEqual([
      "hello",
      "world news",
      "today",
    ]);
  });

  it("handles field:value tokens intact", () => {
    expect(tokenizeSearch("is:unread feed:example")).toEqual([
      "is:unread",
      "feed:example",
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(tokenizeSearch("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(tokenizeSearch("   ")).toEqual([]);
  });

  it("handles unicode keywords without truncation", () => {
    const result = tokenizeSearch("über café");
    expect(result).toEqual(["über", "café"]);
  });

  it("handles negation prefix", () => {
    expect(tokenizeSearch("-politics -sport")).toEqual(["-politics", "-sport"]);
  });

  it("handles #tag tokens", () => {
    expect(tokenizeSearch("#tech #news")).toEqual(["#tech", "#news"]);
  });
});

// ── parseDateToken ────────────────────────────────────────────────────────────

describe("parseDateToken", () => {
  it("parses Nd relative days", () => {
    const before = Date.now();
    const result = parseDateToken("7d");
    expect(result).toBeInstanceOf(Date);
    const diff = Date.now() - result!.getTime();
    // Should be approximately 7 days ago (±5 seconds tolerance)
    expect(diff).toBeGreaterThanOrEqual(7 * 24 * 3600 * 1000 - 5000);
    expect(diff).toBeLessThanOrEqual(7 * 24 * 3600 * 1000 + 5000);
    void before;
  });

  it("parses Nw relative weeks", () => {
    const result = parseDateToken("2w");
    expect(result).toBeInstanceOf(Date);
    const diff = Date.now() - result!.getTime();
    expect(diff).toBeGreaterThanOrEqual(14 * 24 * 3600 * 1000 - 5000);
    expect(diff).toBeLessThanOrEqual(14 * 24 * 3600 * 1000 + 5000);
  });

  it("parses Nm relative months", () => {
    const result = parseDateToken("1m");
    expect(result).toBeInstanceOf(Date);
    // Roughly 28–31 days ago
    const diff = Date.now() - result!.getTime();
    expect(diff).toBeGreaterThan(27 * 24 * 3600 * 1000);
    expect(diff).toBeLessThan(32 * 24 * 3600 * 1000);
  });

  it("parses Ny relative years", () => {
    const result = parseDateToken("1y");
    expect(result).toBeInstanceOf(Date);
    const diff = Date.now() - result!.getTime();
    expect(diff).toBeGreaterThan(364 * 24 * 3600 * 1000);
    expect(diff).toBeLessThan(367 * 24 * 3600 * 1000);
  });

  it("parses an ISO date string", () => {
    const result = parseDateToken("2024-01-15");
    expect(result).toBeInstanceOf(Date);
    expect(result!.getUTCFullYear()).toBe(2024);
    expect(result!.getUTCMonth()).toBe(0); // January
    expect(result!.getUTCDate()).toBe(15);
  });

  it("returns null for a malformed date", () => {
    expect(parseDateToken("not-a-date")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseDateToken("")).toBeNull();
  });

  it("is case-insensitive for unit letters", () => {
    const lower = parseDateToken("3D");
    expect(lower).toBeInstanceOf(Date);
  });
});
