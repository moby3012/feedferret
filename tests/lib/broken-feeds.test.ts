import { describe, expect, it } from "vitest";
import {
  brokenKindOf,
  categorizeFeedError,
  compareBrokenFeeds,
  countBrokenFeeds,
  DEFAULT_INACTIVE_FEED_DAYS,
  daysSince,
  failingSinceOf,
  feedHost,
  isBrokenFeed,
  isInactiveFeed,
  isStaleBroken,
  lastItemAtOf,
  normalizeInactiveDays,
} from "../../lib/broken-feeds";

describe("categorizeFeedError", () => {
  it.each([
    ["Error: Fetch failed: 401", "access"],
    ["Error: Fetch failed: 403", "access"],
    ["Error: Fetch failed: 404", "not-found"],
    ["Error: Fetch failed: 410", "not-found"],
    ["Error: Fetch failed: 429", "rate-limited"],
    ["Error: Fetch failed: 500", "server"],
    ["Error: Fetch failed: 503", "server"],
    ["Error: Request failed with status code 502", "server"],
    ["TypeError: fetch failed", "unreachable"],
    ["Error: getaddrinfo ENOTFOUND example.invalid", "unreachable"],
    ["Error: connect ECONNREFUSED 10.0.0.1:443", "unreachable"],
    ["Error: Too many redirects fetching https://example.com/feed", "unreachable"],
    ["Error: Non-whitespace before first tag.", "invalid-feed"],
    ["Error: Feed not recognized as RSS 1 or 2.", "invalid-feed"],
    ["Error: Fetch URL points to a private IP", "unsafe-target"],
    ["Error: something odd", "unknown"],
  ])("%s → %s", (error, expected) => {
    expect(categorizeFeedError(error)).toBe(expected);
  });

  it("maps RSSHub feeds (by URL or by message) to 'rsshub' instead of a generic code", () => {
    expect(categorizeFeedError("Error: Fetch failed: 404", "http://rsshub:1200/twitter/user/x")).toBe("rsshub");
    expect(categorizeFeedError("TypeError: fetch failed", "https://rsshub.example.org/github/issue/a/b")).toBe("rsshub");
    expect(categorizeFeedError("Error: RSSHub route is not configured")).toBe("rsshub");
    // an auth wall on an RSSHub URL is still an access problem
    expect(categorizeFeedError("Error: Fetch failed: 403", "https://rsshub.example.org/x")).toBe("access");
  });

  it("handles empty / missing errors", () => {
    expect(categorizeFeedError(null)).toBe("unknown");
    expect(categorizeFeedError("")).toBe("unknown");
  });

  it("does not read digits from URLs or random text as a status", () => {
    expect(categorizeFeedError("Error: parse failed near item 404 of feed https://example.com/feed/500")).not.toBe("not-found");
  });
});

describe("isBrokenFeed / countBrokenFeeds", () => {
  it("is broken when muted or failing", () => {
    expect(isBrokenFeed({ autoMuted: true, consecutiveFailureCount: 0 })).toBe(true);
    expect(isBrokenFeed({ autoMuted: false, consecutiveFailureCount: 3 })).toBe(true);
    expect(isBrokenFeed({ autoMuted: false, consecutiveFailureCount: 0 })).toBe(false);
    expect(isBrokenFeed({ autoMuted: false, consecutiveFailureCount: 0, lastStatus: "attention", lastError: "HTTP 403: feed_blocked" })).toBe(true);
  });

  it("never counts newsletter feeds", () => {
    expect(isBrokenFeed({ sourceType: "newsletter", autoMuted: true, consecutiveFailureCount: 12 })).toBe(false);
    expect(
      countBrokenFeeds([
        { sourceType: "newsletter", autoMuted: true, consecutiveFailureCount: 10 },
        { sourceType: "rss", autoMuted: false, consecutiveFailureCount: 1 },
        { sourceType: "rss", autoMuted: false, consecutiveFailureCount: 0 },
      ]),
    ).toBe(1);
  });
});

describe("compareBrokenFeeds", () => {
  it("sorts muted first, then by failure count, then by name", () => {
    const rows = [
      { name: "b", autoMuted: false, consecutiveFailureCount: 9 },
      { name: "z-muted", autoMuted: true, consecutiveFailureCount: 10 },
      { name: "a", autoMuted: false, consecutiveFailureCount: 9 },
      { name: "a-muted", autoMuted: true, consecutiveFailureCount: 10 },
      { name: "m", autoMuted: true, consecutiveFailureCount: 30 },
    ];
    expect([...rows].sort(compareBrokenFeeds).map((r) => r.name)).toEqual(["m", "a-muted", "z-muted", "a", "b"]);
  });
});

describe("feedHost", () => {
  it("returns only the host: no credentials, path or query", () => {
    expect(feedHost("https://user:secret@example.com:8443/feed.xml?token=abc")).toBe("example.com:8443");
    expect(feedHost("not a url")).toBe("");
    expect(feedHost(null)).toBe("");
  });
});

describe("failingSinceOf / isStaleBroken", () => {
  const now = new Date("2026-11-11T12:00:00Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

  it("uses failingSince, and falls back to the last attempt for rows from before the column", () => {
    expect(failingSinceOf({ failingSince: daysAgo(40), lastFetchedAt: daysAgo(1), consecutiveFailureCount: 5 })).toEqual(daysAgo(40));
    expect(failingSinceOf({ failingSince: null, lastFetchedAt: daysAgo(2), consecutiveFailureCount: 5 })).toEqual(daysAgo(2));
    expect(failingSinceOf({ failingSince: null, lastFetchedAt: daysAgo(2), consecutiveFailureCount: 0 })).toBeNull();
  });

  it("is stale only after more than 30 days of failing", () => {
    const base = { autoMuted: true, consecutiveFailureCount: 10 };
    expect(isStaleBroken({ ...base, failingSince: daysAgo(31) }, now)).toBe(true);
    expect(isStaleBroken({ ...base, failingSince: daysAgo(30) }, now)).toBe(false);
    expect(isStaleBroken({ ...base, failingSince: daysAgo(5) }, now)).toBe(false);
  });

  it("never treats a hand-muted healthy feed (no failure streak) as stale", () => {
    expect(isStaleBroken({ autoMuted: true, consecutiveFailureCount: 0, failingSince: null, lastFetchedAt: daysAgo(400) }, now)).toBe(false);
  });

  it("never treats a recovered or newsletter feed as stale", () => {
    expect(isStaleBroken({ autoMuted: false, consecutiveFailureCount: 0, failingSince: daysAgo(90) }, now)).toBe(false);
    expect(isStaleBroken({ sourceType: "newsletter", autoMuted: true, consecutiveFailureCount: 10, failingSince: daysAgo(90) }, now)).toBe(false);
  });

  it("an unknown start is never stale (understate rather than delete)", () => {
    expect(isStaleBroken({ autoMuted: true, consecutiveFailureCount: 10, failingSince: null, lastFetchedAt: null }, now)).toBe(false);
  });
});

describe("brokenKindOf", () => {
  const kind = (error: string, url?: string) => brokenKindOf(categorizeFeedError(error, url), error);
  it.each([
    ["Error: Fetch failed: 404", "gone"],
    ["Error: Fetch failed: 410", "gone"],
    ["Error: Fetch failed: 403", "blocked"],
    ["Error: Fetch failed: 429", "blocked"],
    ["Error: Fetch failed: 401", "error"], // wrong / missing credentials is not bot protection
    ["Error: Fetch failed: 407", "error"],
    ["Error: Fetch failed: 500", "error"],
    ["Error: Fetch failed: 503", "error"],
    ["TypeError: fetch failed", "error"],
    ["Error: getaddrinfo ENOTFOUND example.invalid", "error"],
    ["Error: Non-whitespace before first tag.", "error"],
    ["Error: something odd", "error"],
  ])("%s → %s", (error, expected) => {
    expect(kind(error)).toBe(expected);
  });

  it("keeps RSSHub failures out of the blocked / gone buckets", () => {
    expect(kind("Error: Fetch failed: 404", "http://rsshub:1200/twitter/user/x")).toBe("error");
    expect(kind("Error: Fetch failed: 403", "https://rsshub.example.org/x")).toBe("blocked");
  });

  it("is secret-safe: the error text is redacted before the status is read", () => {
    expect(kind("Error: Fetch failed: 403 https://u:pw@h.example/f?token=abc")).toBe("blocked");
  });
});

describe("normalizeInactiveDays", () => {
  it("clamps to the supported range and falls back to the default for garbage", () => {
    expect(normalizeInactiveDays(180)).toBe(180);
    expect(normalizeInactiveDays(2)).toBe(7);
    expect(normalizeInactiveDays(100_000)).toBe(3650);
    expect(normalizeInactiveDays(45.6)).toBe(46);
    expect(normalizeInactiveDays(undefined)).toBe(DEFAULT_INACTIVE_FEED_DAYS);
    expect(normalizeInactiveDays(null)).toBe(7); // Number(null) = 0 → clamped up, never throws
    expect(normalizeInactiveDays("abc")).toBe(DEFAULT_INACTIVE_FEED_DAYS);
    expect(normalizeInactiveDays(NaN)).toBe(DEFAULT_INACTIVE_FEED_DAYS);
  });
});

describe("isInactiveFeed", () => {
  const now = new Date("2026-11-12T12:00:00Z");
  const daysBefore = (n: number) => new Date(now.getTime() - n * 86_400_000);
  const healthy = { sourceType: "rss", autoMuted: false, consecutiveFailureCount: 0, lastFetchedAt: daysBefore(0), createdAt: daysBefore(1000) };

  it("flags a working feed whose newest item is older than the threshold", () => {
    expect(isInactiveFeed(healthy, daysBefore(181), now, 180)).toBe(true);
    expect(isInactiveFeed(healthy, daysBefore(179), now, 180)).toBe(false);
    expect(isInactiveFeed(healthy, daysBefore(180), now, 180)).toBe(false); // exactly the threshold is still active
  });

  it("honours a custom threshold", () => {
    expect(isInactiveFeed(healthy, daysBefore(40), now, 30)).toBe(true);
    expect(isInactiveFeed(healthy, daysBefore(40), now, 90)).toBe(false);
  });

  it("never calls a broken, muted, archived, newsletter or never-fetched feed inactive", () => {
    const old = daysBefore(500);
    expect(isInactiveFeed({ ...healthy, consecutiveFailureCount: 2 }, old, now, 180)).toBe(false);
    expect(isInactiveFeed({ ...healthy, autoMuted: true }, old, now, 180)).toBe(false);
    expect(isInactiveFeed({ ...healthy, archivedAt: daysBefore(3) }, old, now, 180)).toBe(false);
    expect(isInactiveFeed({ ...healthy, sourceType: "newsletter" }, old, now, 180)).toBe(false);
    expect(isInactiveFeed({ ...healthy, lastFetchedAt: null }, old, now, 180)).toBe(false);
  });

  it("falls back to the creation date for a feed that never delivered an item", () => {
    expect(isInactiveFeed(healthy, null, now, 180)).toBe(true); // created 1000 days ago, nothing since
    expect(isInactiveFeed({ ...healthy, createdAt: daysBefore(20) }, null, now, 180)).toBe(false);
    expect(lastItemAtOf(null, healthy)).toEqual(healthy.createdAt);
    expect(lastItemAtOf(daysBefore(5), healthy)).toEqual(daysBefore(5));
  });
});

describe("daysSince", () => {
  it("counts whole days and never goes negative", () => {
    const now = new Date("2026-11-12T12:00:00Z");
    expect(daysSince(new Date("2026-11-01T13:00:00Z"), now)).toBe(10);
    expect(daysSince(new Date("2026-12-01T00:00:00Z"), now)).toBe(0);
  });
});
