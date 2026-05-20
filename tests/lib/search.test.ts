import { describe, it, expect, vi } from "vitest";
import { tokenizeSearch, parseDateToken, buildAdvancedSearchWhere } from "../../lib/search";

// Mock the db module so search.ts can be imported without a real DB connection
vi.mock("../../lib/db", () => ({ db: {} }));

const USER = "user-1";

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

// ── buildAdvancedSearchWhere — OR operator ────────────────────────────────────

describe("buildAdvancedSearchWhere OR operator", () => {
  it("returns empty object for empty query", async () => {
    expect(await buildAdvancedSearchWhere(USER, "")).toEqual({});
    expect(await buildAdvancedSearchWhere(USER, "   ")).toEqual({});
    expect(await buildAdvancedSearchWhere(USER)).toEqual({});
  });

  it("AND-joins two bare keywords without OR", async () => {
    const result = await buildAdvancedSearchWhere(USER, "openclaw hermes") as any;
    // Both terms must appear → AND with two OR-expanded free-text conditions
    expect(result).toHaveProperty("AND");
    expect(result.AND).toHaveLength(2);
  });

  it("OR-splits two bare keywords with OR", async () => {
    const result = await buildAdvancedSearchWhere(USER, "openclaw OR hermes") as any;
    // Each group produces a single free-text condition; two groups → { OR: [...] }
    expect(result).toHaveProperty("OR");
    expect(result.OR).toHaveLength(2);
  });

  it("OR is case-insensitive (lowercase 'or' is treated as boolean operator)", async () => {
    const upperResult = await buildAdvancedSearchWhere(USER, "foo OR bar") as any;
    const lowerResult = await buildAdvancedSearchWhere(USER, "foo or bar") as any;
    expect(upperResult).toHaveProperty("OR");
    expect(lowerResult).toHaveProperty("OR");
  });

  it("handles trailing OR by ignoring the empty group", async () => {
    // "openclaw OR" should be identical to just "openclaw"
    const withTrailing = await buildAdvancedSearchWhere(USER, "openclaw OR") as any;
    const withoutOr = await buildAdvancedSearchWhere(USER, "openclaw") as any;
    expect(withTrailing).toEqual(withoutOr);
    // Should not produce an OR wrapper
    expect(withTrailing).not.toHaveProperty("OR");
  });

  it("handles leading OR by ignoring the empty group", async () => {
    // "OR openclaw" should be identical to just "openclaw"
    const withLeading = await buildAdvancedSearchWhere(USER, "OR openclaw") as any;
    const withoutOr = await buildAdvancedSearchWhere(USER, "openclaw") as any;
    expect(withLeading).toEqual(withoutOr);
    expect(withLeading).not.toHaveProperty("OR");
  });

  it("handles only OR token (all groups are empty)", async () => {
    expect(await buildAdvancedSearchWhere(USER, "OR")).toEqual({});
  });

  it("OR-splits field qualifiers across groups", async () => {
    // "feed:tech openclaw OR feed:sports hermes"
    // Group 1 → feed:tech AND openclaw; Group 2 → feed:sports AND hermes
    const result = await buildAdvancedSearchWhere(USER, "feed:tech openclaw OR feed:sports hermes") as any;
    expect(result).toHaveProperty("OR");
    expect(result.OR).toHaveLength(2);

    const [g1, g2] = result.OR;
    // Each group has AND with a feed condition and a free-text condition
    expect(g1).toHaveProperty("AND");
    expect(g2).toHaveProperty("AND");
    expect(g1.AND).toHaveLength(2);
    expect(g2.AND).toHaveLength(2);
  });

  it("three-way OR produces three entries", async () => {
    const result = await buildAdvancedSearchWhere(USER, "alpha OR beta OR gamma") as any;
    expect(result).toHaveProperty("OR");
    expect(result.OR).toHaveLength(3);
  });
});
