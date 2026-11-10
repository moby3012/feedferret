import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchWith: vi.fn(), trusted: vi.fn() }));
vi.mock("dns/promises", () => ({ default: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] } }));
vi.mock("@/lib/db", () => ({ db: { globalSettings: { findUnique: async () => ({ allowInternalFeedUrls: false }) } }, getDatabaseProvider: () => "sqlite" }));
vi.mock("@/lib/connector-hosts", () => ({ isTrustedConnectorUrl: async () => false }));
vi.mock("../../lib/ssrf", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ssrf")>()),
  fetchWithSsrfProtection: mocks.fetchWith,
  isTrustedFeedFetchingAllowed: mocks.trusted,
}));

import { fetchFeedArticles } from "../../lib/feed-fetcher";
import { assertSafeHttpOptionsProxy, proxyFromHttpOptions } from "../../lib/ssrf";

const feed = (proxy: string, extra: Record<string, unknown> = {}) => ({
  url: "https://news.example.com/feed.xml",
  httpOptions: JSON.stringify({ CURLOPT_PROXY: proxy }),
  ...extra,
});

describe("feed fetch: CURLOPT_PROXY is subject to the SSRF guard", () => {
  beforeEach(() => {
    mocks.fetchWith.mockReset();
    mocks.trusted.mockReset().mockResolvedValue(false);
  });

  it.each([
    "http://169.254.169.254:80",
    "http://127.0.0.1:3128",
    "http://localhost:3128",
    "http://10.1.2.3:3128",
    "http://[::1]:3128",
    "http://192.168.1.1:8080",
    "socks5://proxy.example.net:1080",
  ])("refuses %s without making any request", async (proxy) => {
    await expect(fetchFeedArticles(feed(proxy) as never)).rejects.toThrow(/Proxy/);
    expect(mocks.fetchWith).not.toHaveBeenCalled();
  });

  it("lets a public proxy through to the (still guarded) feed request", async () => {
    mocks.fetchWith.mockResolvedValue({ notModified: false, text: "<rss version='2.0'><channel><title>t</title></channel></rss>", contentType: "application/rss+xml", etag: null, lastModified: null });
    await fetchFeedArticles(feed("http://proxy.example.net:3128") as never).catch(() => undefined);
    expect(mocks.fetchWith).toHaveBeenCalledTimes(1);
  });

  it("allows an internal proxy only when the feed or the instance is explicitly allowInternal", async () => {
    mocks.fetchWith.mockResolvedValue({ notModified: false, text: "<rss version='2.0'><channel><title>t</title></channel></rss>", contentType: "application/rss+xml", etag: null, lastModified: null });
    await fetchFeedArticles(feed("http://10.0.0.9:3128", { allowInternal: true }) as never).catch(() => undefined);
    expect(mocks.fetchWith).toHaveBeenCalledTimes(1);

    mocks.fetchWith.mockClear();
    mocks.trusted.mockResolvedValue(true);
    await fetchFeedArticles(feed("http://10.0.0.9:3128") as never).catch(() => undefined);
    expect(mocks.fetchWith).toHaveBeenCalledTimes(1);
  });
});

describe("assertSafeHttpOptionsProxy / proxyFromHttpOptions", () => {
  it("ignores options without a proxy, malformed JSON and empty values", async () => {
    for (const value of [null, undefined, "", "not json", "[]", "{}", JSON.stringify({ CURLOPT_PROXY: "  " }), { CURLOPT_USERAGENT: "x" }]) {
      expect(proxyFromHttpOptions(value)).toBeNull();
      await expect(assertSafeHttpOptionsProxy(value, { allowInternal: false })).resolves.toBeUndefined();
    }
  });

  it("rejects an unsafe proxy unless internal targets are allowed", async () => {
    const opts = JSON.stringify({ CURLOPT_PROXY: "http://172.16.0.4:3128" });
    await expect(assertSafeHttpOptionsProxy(opts, { allowInternal: false })).rejects.toThrow(/Proxy URL points to a private IP/);
    await expect(assertSafeHttpOptionsProxy(opts, { allowInternal: true })).resolves.toBeUndefined();
  });

  it("uses the instance-wide switch by default", async () => {
    await expect(assertSafeHttpOptionsProxy({ CURLOPT_PROXY: "http://127.0.0.1:1" })).rejects.toThrow(/Proxy/);
  });
});
