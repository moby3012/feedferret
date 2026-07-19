import { describe, it, expect } from "vitest";
import { resolveFullTextMode, looksLikeTruncatedFeed } from "../../lib/full-text-mode";

describe("resolveFullTextMode", () => {
  it("returns 'auto' when fullTextMode is explicitly 'auto', regardless of the legacy flag", () => {
    expect(resolveFullTextMode({ fullTextMode: "auto", autoFetchFullText: false })).toBe("auto");
    expect(resolveFullTextMode({ fullTextMode: "auto", autoFetchFullText: true })).toBe("auto");
  });

  it("returns 'selector' when fullTextMode is explicitly 'selector', regardless of the legacy flag", () => {
    expect(resolveFullTextMode({ fullTextMode: "selector", autoFetchFullText: false })).toBe("selector");
    expect(resolveFullTextMode({ fullTextMode: "selector", autoFetchFullText: true })).toBe("selector");
  });

  it("falls back to 'selector' when fullTextMode is 'off' (the default) but the legacy boolean is true", () => {
    // This is the critical back-compat case: every pre-existing feed row gets
    // fullTextMode = "off" by default migration, so it must not silently
    // disable full-text for feeds that already had autoFetchFullText = true.
    expect(resolveFullTextMode({ fullTextMode: "off", autoFetchFullText: true })).toBe("selector");
  });

  it("returns 'off' when fullTextMode is 'off' and the legacy boolean is false", () => {
    expect(resolveFullTextMode({ fullTextMode: "off", autoFetchFullText: false })).toBe("off");
  });

  it("falls back to the legacy boolean when fullTextMode is null/undefined", () => {
    expect(resolveFullTextMode({ fullTextMode: null, autoFetchFullText: true })).toBe("selector");
    expect(resolveFullTextMode({ fullTextMode: undefined, autoFetchFullText: true })).toBe("selector");
    expect(resolveFullTextMode({ fullTextMode: null, autoFetchFullText: false })).toBe("off");
    expect(resolveFullTextMode({ fullTextMode: undefined, autoFetchFullText: false })).toBe("off");
  });

  it("returns 'off' when neither field is set at all", () => {
    expect(resolveFullTextMode({})).toBe("off");
  });

  it("treats an unrecognized fullTextMode value as unset and falls back to the legacy boolean", () => {
    expect(resolveFullTextMode({ fullTextMode: "bogus", autoFetchFullText: true })).toBe("selector");
    expect(resolveFullTextMode({ fullTextMode: "bogus", autoFetchFullText: false })).toBe("off");
  });

  it("treats autoFetchFullText: null the same as false", () => {
    expect(resolveFullTextMode({ fullTextMode: "off", autoFetchFullText: null })).toBe("off");
    expect(resolveFullTextMode({ fullTextMode: undefined, autoFetchFullText: null })).toBe("off");
  });
});

describe("looksLikeTruncatedFeed", () => {
  it("detects a real-world WordPress 'Summary' feed (measured against a live site)", () => {
    // stadt-bremerhaven.de (Caschys Blog): feed teaser ~546 chars, real
    // article body ~2746 chars once fetched — a deliberately truncated feed.
    expect(looksLikeTruncatedFeed(546, 2746)).toBe(true);
  });

  it("does not flag a feed whose existing content was already substantial", () => {
    // Full-text feeds sometimes still improve slightly (extra formatting,
    // a missing paragraph) — that's not the "deliberately truncated" case.
    expect(looksLikeTruncatedFeed(1000, 1400)).toBe(false);
  });

  it("does not flag a marginal improvement even on a short existing teaser", () => {
    expect(looksLikeTruncatedFeed(500, 900)).toBe(false);
  });

  it("does not flag when the new content itself is too short to be a real article", () => {
    expect(looksLikeTruncatedFeed(200, 1100)).toBe(false);
  });

  it("respects the exact thresholds at their boundaries", () => {
    expect(looksLikeTruncatedFeed(799, 1997.5)).toBe(true); // 799 * 2.5 = 1997.5, and >= 1200
    expect(looksLikeTruncatedFeed(800, 2000)).toBe(false); // existing must be < 800, not <=
    expect(looksLikeTruncatedFeed(400, 999)).toBe(false); // below the 1200 floor
    expect(looksLikeTruncatedFeed(480, 1200)).toBe(true); // 480 * 2.5 = 1200, meets both floors
  });
});
