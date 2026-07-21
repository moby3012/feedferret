import { describe, it, expect, vi, afterEach } from "vitest";

const fetchTextWithSsrfProtection = vi.fn(async (): Promise<string> => {
  throw new Error("not mocked for this test");
});

vi.mock("../../lib/ssrf", () => ({
  assertSafeFetchUrl: vi.fn(async (u: string) => new URL(u)),
  isTrustedFeedFetchingAllowed: vi.fn(async () => false),
  fetchTextWithSsrfProtection: (...args: unknown[]) => fetchTextWithSsrfProtection(...(args as [])),
}));

import {
  buildWatchFeedUrl,
  createWatch,
  testChangedetectionConnection,
  discoverRssToken,
  type ChangedetectionConfig,
} from "../../lib/changedetection";

const config: ChangedetectionConfig = {
  baseUrl: "http://changedetection.internal:5000",
  apiKey: "test-api-key",
  rssToken: "test-rss-token",
};

describe("buildWatchFeedUrl", () => {
  it("builds the per-watch RSS URL with the RSS access token as a query param", () => {
    expect(buildWatchFeedUrl(config, "abc-123")).toBe(
      "http://changedetection.internal:5000/rss/watch/abc-123?token=test-rss-token",
    );
  });

  it("strips a trailing slash on the base URL", () => {
    const trailing: ChangedetectionConfig = { ...config, baseUrl: "http://changedetection.internal:5000/" };
    expect(buildWatchFeedUrl(trailing, "abc-123")).toBe(
      "http://changedetection.internal:5000/rss/watch/abc-123?token=test-rss-token",
    );
  });

  it("URL-encodes the RSS token", () => {
    const special: ChangedetectionConfig = { ...config, rssToken: "a token/with+special&chars" };
    const url = buildWatchFeedUrl(special, "abc-123");
    expect(url).toContain("token=a%20token%2Fwith%2Bspecial%26chars");
  });
});

describe("createWatch", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("creates a watch and returns its uuid, sending the API key and body", async () => {
    let capturedInit: RequestInit | undefined;
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return { ok: true, json: async () => ({ uuid: "new-watch-uuid" }) };
    }) as unknown as typeof fetch;

    const result = await createWatch(config, { url: "https://example.com/page", includeFilters: [".content"] });
    expect(result).toEqual({ ok: true, uuid: "new-watch-uuid" });
    expect(capturedInit?.method).toBe("POST");
    expect((capturedInit?.headers as Record<string, string>)["x-api-key"]).toBe("test-api-key");
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      url: "https://example.com/page",
      include_filters: [".content"],
    });
  });

  it("returns not-ok when the response has no usable uuid", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
    const result = await createWatch(config, { url: "https://example.com/page" });
    expect(result.ok).toBe(false);
  });

  it("returns not-ok (never throws) on an HTTP error", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 401, text: async () => "Invalid API key" })) as unknown as typeof fetch;
    const result = await createWatch(config, { url: "https://example.com/page" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("401");
  });

  it("returns not-ok (never throws) on a network failure", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await createWatch(config, { url: "https://example.com/page" });
    expect(result.ok).toBe(false);
  });
});

describe("testChangedetectionConnection", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    fetchTextWithSsrfProtection.mockReset();
  });

  it("returns ok with the reported version and the discovered RSS token on success", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ version: "0.50.10" }) })) as unknown as typeof fetch;
    fetchTextWithSsrfProtection.mockResolvedValueOnce(
      '<html><head><link rel="alternate" type="application/rss+xml" href="/rss/all?token=abcdef0123456789"></head></html>',
    );
    const result = await testChangedetectionConnection(config);
    expect(result).toEqual({ ok: true, version: "0.50.10", discoveredRssToken: "abcdef0123456789" });
  });

  it("still reports overall success when RSS-token discovery fails", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ version: "0.50.10" }) })) as unknown as typeof fetch;
    fetchTextWithSsrfProtection.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const result = await testChangedetectionConnection(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.discoveredRssToken).toBeUndefined();
      expect(result.rssTokenDiscoveryError).toContain("ECONNREFUSED");
    }
  });

  it("returns not-ok on an auth failure", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 403, text: async () => "Forbidden" })) as unknown as typeof fetch;
    const result = await testChangedetectionConnection(config);
    expect(result.ok).toBe(false);
  });
});

describe("discoverRssToken", () => {
  afterEach(() => {
    fetchTextWithSsrfProtection.mockReset();
  });

  it("extracts the token from the RSS autodiscovery <link> tag", async () => {
    fetchTextWithSsrfProtection.mockResolvedValueOnce(
      '<html><head><title>changedetection.io</title><link rel="alternate" type="application/rss+xml" title="feed" href="/rss?tag=&token=0123456789abcdef" ></head><body></body></html>',
    );
    const result = await discoverRssToken("http://changedetection.internal:5000");
    expect(result).toEqual({ ok: true, token: "0123456789abcdef" });
  });

  it("prefers the RSS <link> tag's token over an unrelated token= elsewhere on the page", async () => {
    fetchTextWithSsrfProtection.mockResolvedValueOnce(
      '<html><head><link rel="alternate" type="application/rss+xml" href="/rss?token=aaaaaaaaaaaaaaaa"></head>' +
        '<body><a href="/other?token=bbbbbbbbbbbbbbbb">link</a></body></html>',
    );
    const result = await discoverRssToken("http://changedetection.internal:5000");
    expect(result).toEqual({ ok: true, token: "aaaaaaaaaaaaaaaa" });
  });

  it("falls back to a bare token= scan when there's no RSS <link> tag", async () => {
    fetchTextWithSsrfProtection.mockResolvedValueOnce('<html><body>token=fedcba9876543210 somewhere in the page</body></html>');
    const result = await discoverRssToken("http://changedetection.internal:5000");
    expect(result).toEqual({ ok: true, token: "fedcba9876543210" });
  });

  it("returns not-ok with a helpful reason when no token is found", async () => {
    fetchTextWithSsrfProtection.mockResolvedValueOnce("<html><body>no token here</body></html>");
    const result = await discoverRssToken("http://changedetection.internal:5000");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Could not find the RSS token");
  });

  it("returns not-ok (never throws) when the fetch itself fails", async () => {
    fetchTextWithSsrfProtection.mockRejectedValueOnce(new Error("timeout"));
    const result = await discoverRssToken("http://changedetection.internal:5000");
    expect(result).toEqual({ ok: false, reason: "timeout" });
  });
});
