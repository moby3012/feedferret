import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchText: vi.fn(),
  fetchWithSsrf: vi.fn(),
  getRsshubConfig: vi.fn(),
  validateRsshubRoute: vi.fn(),
}));

vi.mock("../../lib/ssrf", async () => {
  const actual = await vi.importActual<any>("../../lib/ssrf");
  return {
    ...actual,
    fetchTextWithSsrfProtection: mocks.fetchText,
    fetchWithSsrfProtection: mocks.fetchWithSsrf,
    isTrustedFeedFetchingAllowed: vi.fn().mockResolvedValue(false),
  };
});

vi.mock("../../lib/rsshub", async () => {
  return {
    radarRoutesFor: (s: string) => {
      if (s.includes("twitter.com") || s.includes("x.com")) {
        return [{ title: "User Timeline", route: "/twitter/user/sample" }];
      }
      return [];
    },
    getRsshubConfig: mocks.getRsshubConfig,
    validateRsshubRoute: mocks.validateRsshubRoute,
    buildRsshubRouteUrl: (c: { baseUrl: string }, r: string) => `${c.baseUrl}${r}`,
    buildRsshubPublicRouteUrl: (c: { baseUrl: string }, r: string) => `${c.baseUrl}${r}`,
  };
});

import { discoverFeeds } from "../../lib/feed-discovery";

describe("capability hints in feed discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRsshubConfig.mockResolvedValue(null);
  });

  it("returns hint: needs-rsshub when a radar route matches but RSSHub is unconfigured", async () => {
    const res = await discoverFeeds("https://x.com/jack");
    expect(res.feeds.length).toBe(0);
    expect(res.hint).toBe("needs-rsshub");
  });

  it("returns hint: rate-limited when response is HTTP 429", async () => {
    mocks.fetchText.mockRejectedValue(new Error("Fetch failed: 429"));
    mocks.fetchWithSsrf.mockRejectedValue(new Error("Fetch failed: 429"));

    const res = await discoverFeeds("https://api.example.com/blog");
    expect(res.feeds.length).toBe(0);
    expect(res.hint).toBe("rate-limited");
  });

  it("returns hint: blocked when response is HTTP 403 or 401", async () => {
    mocks.fetchText.mockRejectedValue(new Error("Fetch failed: 403"));
    mocks.fetchWithSsrf.mockRejectedValue(new Error("Fetch failed: 403"));

    const res403 = await discoverFeeds("https://paywall.example.com/news");
    expect(res403.feeds.length).toBe(0);
    expect(res403.hint).toBe("blocked");

    mocks.fetchText.mockRejectedValue(new Error("Fetch failed: 401"));
    mocks.fetchWithSsrf.mockRejectedValue(new Error("Fetch failed: 401"));

    const res401 = await discoverFeeds("https://auth.example.com/feed");
    expect(res401.feeds.length).toBe(0);
    expect(res401.hint).toBe("blocked");
  });

  it("ignores status-looking digits that are not an HTTP failure status", async () => {
    mocks.fetchText.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:4013"));
    mocks.fetchWithSsrf.mockRejectedValue(new Error("Fetch hostname resolves to a private IP (port 4290)"));
    const res = await discoverFeeds("https://down.example.com/");
    expect(res.hint).toBeUndefined();
  });
});
