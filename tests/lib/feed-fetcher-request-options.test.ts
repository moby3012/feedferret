// #280 security review P3: the header deny-list and the redirect cap are enforced by the
// fetcher itself, so they hold for options from the feed dialog, REST and MCP too —
// not only for imported OPML.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ calls: [] as Array<{ init: RequestInit; options: Record<string, unknown> }> }));
vi.mock("@/lib/db", () => ({ db: {}, getDatabaseProvider: () => "sqlite" }));
vi.mock("@/lib/ssrf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ssrf")>();
  return {
    ...actual,
    isTrustedFeedFetchingAllowed: async () => false,
    assertSafeProxyUrl: async () => undefined,
    fetchWithSsrfProtection: vi.fn(async (_url: string, init: RequestInit, options: Record<string, unknown>) => {
      state.calls.push({ init, options });
      return { notModified: false, text: '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title></channel></rss>', etag: null, lastModified: null, headers: new Headers() };
    }),
  };
});
vi.mock("@/lib/connector-secrets", () => ({
  getConnectorSecretRules: async () => [],
  resolveConnectorRequestWith: (_rules: unknown, url: string) => ({ url, trusted: false }),
  stripConnectorSecretsWith: (_rules: unknown, url: string) => url,
}));

import { fetchFeedArticles } from "../../lib/feed-fetcher";

const fetchWith = async (httpOptions: Record<string, unknown>) => {
  state.calls = [];
  await fetchFeedArticles({ url: "https://feeds.example.com/rss", sourceType: "rss", httpOptions: JSON.stringify(httpOptions) });
  return state.calls[0];
};

beforeEach(() => {
  state.calls = [];
});

describe("feed request options", () => {
  it("never sends Host, framing or hop-by-hop headers, whatever the stored options say", async () => {
    const { init } = await fetchWith({
      CURLOPT_HTTPHEADER: "Host: 169.254.169.254\nTransfer-Encoding: chunked\ncontent-length: 5\nConnection: close\nX-Ok: 1\nAccept-Language: de",
    });
    const headers = init.headers as Record<string, string>;
    const names = Object.keys(headers).map((name) => name.toLowerCase());
    for (const blocked of ["host", "transfer-encoding", "content-length", "connection"]) expect(names).not.toContain(blocked);
    expect(headers["X-Ok"]).toBe("1");
    expect(headers["Accept-Language"]).toBe("de");
  });

  it.each([
    [5000, 20],
    [-3, 0],
    [7, 7],
    [undefined, 10],
  ])("caps CURLOPT_MAXREDIRS=%s at %s", async (given, expected) => {
    const { options } = await fetchWith(given === undefined ? {} : { CURLOPT_MAXREDIRS: given });
    expect(options.maxRedirects).toBe(expected);
  });
});
