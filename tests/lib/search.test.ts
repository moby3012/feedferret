import { describe, it, expect, vi, beforeEach } from "vitest";
import { tokenizeSearch, parseDateToken, buildAdvancedSearchWhere, buildFtsMatchQuery } from "../../lib/search";
import { db } from "../../lib/db";

// Mock the db module so search.ts can be imported without a real DB connection.
// getDatabaseProvider mirrors the default (sqlite) so `isPostgres` in lib/search.ts
// resolves the same way it would in a real dev/test environment.
vi.mock("../../lib/db", () => ({
  db: { $queryRawUnsafe: vi.fn() },
  getDatabaseProvider: () => "sqlite",
}));

const USER = "user-1";

// Default every test to "article_fts unavailable" so pre-existing tests that
// don't care about FTS routing deterministically exercise the LIKE fallback
// path (identical to pre-FTS behavior), regardless of test execution order.
// Individual tests below override this with mockResolvedValue(Once) to
// exercise the FTS-hit path instead.
beforeEach(() => {
  (db.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>).mockReset();
  (db.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
    new Error("article_fts not available in this test")
  );
});

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

// ── buildFtsMatchQuery ────────────────────────────────────────────────────────

describe("buildFtsMatchQuery", () => {
  it("wraps a plain term in double quotes", () => {
    expect(buildFtsMatchQuery("hello")).toBe('"hello"');
  });

  it("doubles embedded double quotes (FTS5 escaping rule)", () => {
    expect(buildFtsMatchQuery('say "hi"')).toBe('"say ""hi"""');
  });

  it("preserves a multi-word phrase, including the space, as one literal", () => {
    expect(buildFtsMatchQuery("exact phrase")).toBe('"exact phrase"');
  });

  it("leaves FTS5 syntax characters (colon, hyphen, asterisk) untouched inside the quotes", () => {
    expect(buildFtsMatchQuery("foo:bar")).toBe('"foo:bar"');
    expect(buildFtsMatchQuery("baz-qux")).toBe('"baz-qux"');
    expect(buildFtsMatchQuery("wild*card")).toBe('"wild*card"');
  });

  it("handles a term that is only double quotes", () => {
    expect(buildFtsMatchQuery('""')).toBe('""""""');
  });

  it("handles unicode terms without alteration", () => {
    expect(buildFtsMatchQuery("über café")).toBe('"über café"');
  });
});

// ── buildAdvancedSearchWhere — SQLite FTS routing for free-text terms ─────────

describe("buildAdvancedSearchWhere SQLite FTS routing", () => {
  const queryRawUnsafeMock = db.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>;

  it("routes a >=3 char free-text term through article_fts and ORs it with the link/feed/label LIKE branches", async () => {
    queryRawUnsafeMock.mockResolvedValue([{ id: "article-1" }, { id: "article-2" }]);

    const result = await buildAdvancedSearchWhere(USER, "openclaw") as any;

    expect(queryRawUnsafeMock).toHaveBeenCalledWith(
      expect.stringContaining("article_fts"),
      '"openclaw"'
    );
    expect(result.AND).toHaveLength(1);
    const [condition] = result.AND;
    expect(condition.OR).toEqual([
      { id: { in: ["article-1", "article-2"] } },
      { link: { contains: "openclaw" } },
      { feed: { name: { contains: "openclaw" } } },
      { labels: { some: { label: { name: { contains: "openclaw" }, userId: USER } } } },
    ]);
  });

  it("falls back to the full LIKE-based OR list when the FTS query throws (e.g. article_fts missing)", async () => {
    queryRawUnsafeMock.mockRejectedValue(new Error("no such table: article_fts"));

    const result = await buildAdvancedSearchWhere(USER, "openclaw") as any;

    const [condition] = result.AND;
    expect(condition.OR).toEqual([
      { title: { contains: "openclaw" } },
      { content: { contains: "openclaw" } },
      { excerpt: { contains: "openclaw" } },
      { author: { contains: "openclaw" } },
      { link: { contains: "openclaw" } },
      { feed: { name: { contains: "openclaw" } } },
      { labels: { some: { label: { name: { contains: "openclaw" }, userId: USER } } } },
    ]);
  });

  it("skips FTS and uses the full LIKE-based OR list for terms shorter than 3 characters", async () => {
    const result = await buildAdvancedSearchWhere(USER, "ab") as any;

    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    const [condition] = result.AND;
    expect(condition.OR).toEqual([
      { title: { contains: "ab" } },
      { content: { contains: "ab" } },
      { excerpt: { contains: "ab" } },
      { author: { contains: "ab" } },
      { link: { contains: "ab" } },
      { feed: { name: { contains: "ab" } } },
      { labels: { some: { label: { name: { contains: "ab" }, userId: USER } } } },
    ]);
  });

  it("issues one FTS lookup per free-text term and ANDs the results", async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: "a1" }])
      .mockResolvedValueOnce([{ id: "a2" }]);

    const result = await buildAdvancedSearchWhere(USER, "openclaw hermes") as any;

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
    expect(result.AND).toHaveLength(2);
    expect(result.AND[0].OR[0]).toEqual({ id: { in: ["a1"] } });
    expect(result.AND[1].OR[0]).toEqual({ id: { in: ["a2"] } });
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
