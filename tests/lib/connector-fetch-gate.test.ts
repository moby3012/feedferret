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

async function optionsFor(feed: Record<string, unknown>) {
  await fetchFeedArticles(feed as never).catch(() => undefined);
  expect(mocks.fetchWith).toHaveBeenCalledTimes(1);
  const [requestUrl, , options] = mocks.fetchWith.mock.calls[0];
  return { requestUrl: String(requestUrl), options: options as import("../../lib/ssrf").SafeFetchTextOptions };
}

describe("feed fetch: a user-chosen proxy never receives the connector secret", () => {
  it.each([
    ["keyless row", "http://rsshub:1200/youtube/channel/UC1"],
    ["legacy keyed row", "http://rsshub:1200/youtube/channel/UC1?key=rsskey"],
  ])("RSSHub %s via proxy: no key, no internal access", async (_label, url) => {
    const { requestUrl, options } = await optionsFor({ url, httpOptions: JSON.stringify({ CURLOPT_PROXY: "http://8.8.8.8:3128" }) });
    expect(requestUrl).toBe("http://rsshub:1200/youtube/channel/UC1");
    expect(requestUrl).not.toContain("rsskey");
    expect(options.allowInternal).toBe(false);
  });

  it("changedetection watch feed via proxy: no token, no internal access", async () => {
    const url = "http://changedetection:5000/rss/watch/0b8f6c2e-1d3a-4a5b-9c7d-112233445566";
    const { requestUrl, options } = await optionsFor({ url, httpOptions: JSON.stringify({ CURLOPT_PROXY: "http://8.8.8.8:3128" }) });
    expect(requestUrl).toBe(url);
    expect(options.allowInternal).toBe(false);
  });
});

describe("feed fetch: trusted connector redirects stay on allowed connector routes", () => {
  const realFetch = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  async function runRedirect(location: string) {
    const { requestUrl, options } = await optionsFor({ url: "http://rsshub:1200/youtube/channel/UC1" });
    expect(options.allowInternal).toBe(true);
    expect(options.redirectGuard).toBeTypeOf("function");
    const { fetchWithSsrfProtection } = await vi.importActual<typeof import("../../lib/ssrf")>("../../lib/ssrf");
    const requested: string[] = [];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      requested.push(url);
      if (requested.length === 1) return new Response(null, { status: 302, headers: { location } });
      return new Response(RSS, { status: 200 });
    }) as typeof fetch;
    const outcome = await fetchWithSsrfProtection(requestUrl, {}, options).then(
      () => "ok",
      (error: Error) => error.message,
    );
    return { outcome, requested };
  }

  it.each([
    "http://rsshub:1200/rsshub/transform/html/http%3A%2F%2Fpostgres%3A5432%2F/item=a",
    "http://postgres:5432/",
    "http://169.254.169.254/latest/meta-data/",
    "https://attacker.example/collect",
  ])("refuses a redirect to %s (no follow-up request, key not re-sent)", async (location) => {
    const { outcome, requested } = await runRedirect(location);
    expect(outcome).toMatch(/Redirect refused/);
    expect(requested).toEqual(["http://rsshub:1200/youtube/channel/UC1?key=rsskey"]);
  });

  it("follows a redirect to another allowed route on the same connector (with the current key)", async () => {
    const { outcome, requested } = await runRedirect("/youtube/channel/UC2");
    expect(outcome).toBe("ok");
    expect(requested).toEqual(["http://rsshub:1200/youtube/channel/UC1?key=rsskey", "http://rsshub:1200/youtube/channel/UC2?key=rsskey"]);
  });

  it("ordinary external feeds get no redirect guard", async () => {
    const { options } = await optionsFor({ url: "https://blog.example/feed.xml" });
    expect(options.redirectGuard).toBeUndefined();
  });
});
