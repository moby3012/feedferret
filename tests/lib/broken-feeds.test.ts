import { describe, expect, it } from "vitest";
import {
  categorizeFeedError,
  compareBrokenFeeds,
  countBrokenFeeds,
  failingSinceOf,
  feedHost,
  isBrokenFeed,
  isStaleBroken,
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
