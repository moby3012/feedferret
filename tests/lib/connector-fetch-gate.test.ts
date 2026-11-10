// Security wave 3 review (N3 follow-up): the feed fetcher adds the RSSHub key /
// changedetection.io token and the internal-network allowance ONLY for allowed
// connector routes, so a user feed pointing at /rsshub/transform/… (or the
// changedetection all-watches feed) can't use the admin's key as a read-SSRF proxy.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchWith: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { globalSettings: { findUnique: async () => null } }, getDatabaseProvider: () => "sqlite" }));
vi.mock("../../lib/ssrf", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ssrf")>()),
  fetchWithSsrfProtection: mocks.fetchWith,
  isTrustedFeedFetchingAllowed: async () => false,
}));

import { fetchFeedArticles } from "../../lib/feed-fetcher";
import { resetConnectorSecretRulesCache } from "../../lib/connector-secrets";

const RSS = "<rss version='2.0'><channel><title>t</title><item><title>a</title><link>https://example.com/a</link></item></channel></rss>";
const ENV = {
  FEEDFERRET_RSSHUB_URL: "http://rsshub:1200",
  FEEDFERRET_RSSHUB_KEY: "rsskey",
  FEEDFERRET_CHANGEDETECTION_URL: "http://changedetection:5000",
  FEEDFERRET_CHANGEDETECTION_API_KEY: "cdapi",
  FEEDFERRET_CHANGEDETECTION_RSS_TOKEN: "cdtoken",
};

beforeAll(() => Object.assign(process.env, ENV));
afterAll(() => {
  for (const key of Object.keys(ENV)) delete process.env[key];
});
beforeEach(() => {
  resetConnectorSecretRulesCache();
  mocks.fetchWith.mockReset().mockResolvedValue({ notModified: false, text: RSS, contentType: "application/rss+xml", etag: null, lastModified: null });
});

async function requestFor(url: string) {
  await fetchFeedArticles({ url } as never).catch(() => undefined);
  expect(mocks.fetchWith).toHaveBeenCalledTimes(1);
  const [requestUrl, , options] = mocks.fetchWith.mock.calls[0];
  return { requestUrl: String(requestUrl), allowInternal: (options as { allowInternal: boolean }).allowInternal };
}

describe("feed fetch: connector secret + internal access only for allowed routes", () => {
  it("adds the RSSHub key and internal access for a platform route", async () => {
    expect(await requestFor("http://rsshub:1200/youtube/channel/UC1")).toEqual({ requestUrl: "http://rsshub:1200/youtube/channel/UC1?key=rsskey", allowInternal: true });
  });

  it("adds the changedetection token for a single-watch feed", async () => {
    expect(await requestFor("http://changedetection:5000/rss/watch/0b8f6c2e-1d3a-4a5b-9c7d-112233445566")).toEqual({
      requestUrl: "http://changedetection:5000/rss/watch/0b8f6c2e-1d3a-4a5b-9c7d-112233445566?token=cdtoken",
      allowInternal: true,
    });
  });

  it.each([
    "http://rsshub:1200/rsshub/transform/html/http%3A%2F%2Fpostgres%3A5432%2F/item=a",
    "http://rsshub:1200/%72sshub/transform/html/x/y",
    "http://rsshub:1200/api/routes",
    "http://changedetection:5000/rss",
    "http://changedetection:5000/rss/tag/news",
  ])("gives %s neither the secret nor internal access", async (url) => {
    const { requestUrl, allowInternal } = await requestFor(url);
    expect(requestUrl).toBe(url);
    expect(requestUrl).not.toContain("rsskey");
    expect(requestUrl).not.toContain("cdtoken");
    expect(allowInternal).toBe(false);
  });
});
