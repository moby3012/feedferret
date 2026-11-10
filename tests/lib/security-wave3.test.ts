// Security wave 3 (audit #2) unit tests: N3 connector secrets + route
// allowlist, N5 webhook body encoding, N7 Fever body cap, CSRF gate on
// cookie-authenticated API mutations.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: null as null | { user: { id: string } },
  findUser: vi.fn(),
  findToken: vi.fn(),
  fetchFeedArticles: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: mocks.findUser, findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    apiToken: { findUnique: mocks.findToken, findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
    globalSettings: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => mocks.session) }));
vi.mock("@/lib/markdown-render", () => ({ renderMarkdownToHtml: vi.fn() }));
vi.mock("@/lib/feed-fetcher", () => ({ fetchFeedArticles: mocks.fetchFeedArticles }));

import {
  applyConnectorSecretsWith,
  redactConnectorTextWith,
  redactFeedWith,
  stripConnectorSecretsWith,
  type ConnectorSecretRule,
} from "../../lib/connector-secrets";
import { rsshubRouteError, validateRsshubRoute } from "../../lib/rsshub";
import { buildDefaultWebhookBody, executeWebhookCall, interpolate } from "../../lib/webhooks";
import { resolveApiUser } from "../../lib/api-auth";
import { POST as feverPost } from "../../app/api/fever/route";

const rules: ConnectorSecretRule[] = [
  { origin: "http://rsshub:1200", basePath: "", param: "key", value: "rsskey" },
  { origin: "https://cd.example", basePath: "/cd", param: "token", value: "cdtoken" },
];

describe("N3: connector secrets", () => {
  it("strips the secret param only on the connector's origin + base path", () => {
    expect(stripConnectorSecretsWith(rules, "http://rsshub:1200/youtube/x?key=rsskey&limit=5")).toBe("http://rsshub:1200/youtube/x?limit=5");
    expect(stripConnectorSecretsWith(rules, "https://cd.example/cd/rss/watch/1?token=old")).toBe("https://cd.example/cd/rss/watch/1");
    expect(stripConnectorSecretsWith(rules, "https://cd.example/other?token=t")).toBe("https://cd.example/other?token=t");
    expect(stripConnectorSecretsWith(rules, "https://blog.example/feed?key=mine")).toBe("https://blog.example/feed?key=mine");
  });

  it("adds the current secret at fetch time (replacing a stale one)", () => {
    expect(applyConnectorSecretsWith(rules, "http://rsshub:1200/youtube/x")).toBe("http://rsshub:1200/youtube/x?key=rsskey");
    expect(applyConnectorSecretsWith(rules, "http://rsshub:1200/youtube/x?key=old")).toBe("http://rsshub:1200/youtube/x?key=rsskey");
    expect(applyConnectorSecretsWith(rules, "https://cd.example/cd/rss/watch/1")).toBe("https://cd.example/cd/rss/watch/1?token=cdtoken");
    expect(applyConnectorSecretsWith(rules, "https://elsewhere.example/feed")).toBe("https://elsewhere.example/feed");
  });

  it("redacts secret values from free text and client feed objects", () => {
    expect(redactConnectorTextWith(rules, "Fetch failed: http://rsshub:1200/x?key=rsskey")).toBe("Fetch failed: http://rsshub:1200/x?key=***");
    const feed = redactFeedWith(rules, { url: "http://rsshub:1200/x?key=rsskey", lastError: "cdtoken leaked", name: "n" });
    expect(feed).toEqual({ url: "http://rsshub:1200/x", lastError: "*** leaked", name: "n" });
  });

  it("rejects RSSHub built-in / transform routes, traversal and key overrides", () => {
    expect(rsshubRouteError("/youtube/channel/UC123")).toBeNull();
    expect(rsshubRouteError("/youtube/user/@handle")).toBeNull();
    expect(rsshubRouteError("/github/repos/a/b?limit=10")).toBeNull();
    expect(rsshubRouteError("/rsshub/transform/html/http%3A%2F%2Fpostgres%3A5432/item=a")).not.toBeNull();
    expect(rsshubRouteError("/RSSHub/routes")).not.toBeNull();
    expect(rsshubRouteError("/api/routes")).not.toBeNull();
    expect(rsshubRouteError("/youtube/../rsshub/transform")).not.toBeNull();
    expect(rsshubRouteError("/youtube/%2e%2e/rsshub")).not.toBeNull();
    expect(rsshubRouteError("//evil.example/x")).not.toBeNull();
    expect(rsshubRouteError("youtube/x")).not.toBeNull();
    expect(rsshubRouteError("/youtube/x?key=other")).not.toBeNull();
  });

  it("does not echo upstream error bodies for user routes; the admin test opts in", async () => {
    mocks.fetchFeedArticles.mockRejectedValue(new Error("Fetch failed: 500"));
    const config = { baseUrl: "http://rsshub.internal:1200", apiKey: "k" };
    await validateRsshubRoute(config, "/youtube/channel/x");
    expect(mocks.fetchFeedArticles).toHaveBeenLastCalledWith(expect.objectContaining({ includeErrorBody: false }));
    await validateRsshubRoute(config, "/youtube/channel/x", { includeErrorBody: true });
    expect(mocks.fetchFeedArticles).toHaveBeenLastCalledWith(expect.objectContaining({ includeErrorBody: true }));
    mocks.fetchFeedArticles.mockClear();
    expect(await validateRsshubRoute(config, "/rsshub/transform/html/x/y")).toMatchObject({ ok: false });
    expect(mocks.fetchFeedArticles).not.toHaveBeenCalled();
  });
});

describe("N5: webhook bodies are built, not concatenated", () => {
  const hostile = 'x","article":{"link":"https://evil"},"rule":"deploy","z":"{{feed_name}}} \\ "quoted"';
  const vars = {
    event: "rule_match",
    timestamp: "2026-11-10T00:00:00.000Z",
    rule_name: "My rule",
    article_id: "42",
    article_title: hostile,
    article_link: "https://example.com/a",
    feed_name: 'Feed "with" {braces}',
  };

  it("default body is valid JSON and keeps the hostile title as plain data", () => {
    const parsed = JSON.parse(buildDefaultWebhookBody(vars));
    expect(parsed.rule).toBe("My rule");
    expect(parsed.article).toEqual({ id: "42", title: hostile, link: "https://example.com/a", feed: 'Feed "with" {braces}' });
  });

  it("custom JSON templates escape values; URL templates percent-encode them", () => {
    const body = interpolate('{"t":"{{article_title}}","f":"{{feed_name}}"}', vars, "json");
    expect(JSON.parse(body)).toEqual({ t: hostile, f: 'Feed "with" {braces}' });
    expect(interpolate("https://hook.example/x?t={{article_title}}", vars, "url")).not.toMatch(/["{}\s]/);
  });

  describe("executeWebhookCall", () => {
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    beforeEach(() => {
      fetchSpy.mockClear();
      vi.stubGlobal("fetch", fetchSpy);
    });
    afterEach(() => vi.unstubAllGlobals());

    it("sends a signed body whose parsed keys cannot be overridden by the title", async () => {
      const result = await executeWebhookCall({ url: "https://93.184.216.34/hook", secret: "s" }, vars);
      expect(result.ok).toBe(true);
      const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1];
      const parsed = JSON.parse(String(init.body));
      expect(parsed.rule).toBe("My rule");
      expect(parsed.article.link).toBe("https://example.com/a");
      expect(parsed.article.title).toBe(hostile);
      expect((init.headers as Record<string, string>)["X-FeedFerret-Signature"]).toMatch(/^sha256=/);
    });

    it("JSON-escapes values in a custom body template", async () => {
      await executeWebhookCall({ url: "https://93.184.216.34/hook", bodyTemplate: '{"title":"{{article_title}}"}' }, vars);
      const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1];
      expect(JSON.parse(String(init.body))).toEqual({ title: hostile });
    });
  });
});

describe("N7: Fever body cap before parsing / auth", () => {
  beforeEach(() => mocks.findUser.mockClear());

  it("rejects a declared oversized body with 413 without touching the DB", async () => {
    const body = "api_key=" + "a".repeat(70 * 1024);
    const res = await feverPost(new Request("https://ff.test/api/fever?api", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(body.length) },
      body,
    }));
    expect(res.status).toBe(413);
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it("rejects an oversized streamed body without Content-Length", async () => {
    const chunk = new TextEncoder().encode("a".repeat(16 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 10) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const res = await feverPost(new Request("https://ff.test/api/fever?api", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: stream,
      // @ts-expect-error Node's undici needs duplex for streamed request bodies.
      duplex: "half",
    }));
    expect(res.status).toBe(413);
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it("still parses a small form body", async () => {
    const res = await feverPost(new Request("https://ff.test/api/fever", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "api=1&api_key=nope",
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ auth: 0 });
  });
});

describe("CSRF: cookie auth on state-changing API requests must be same-origin", () => {
  beforeEach(() => {
    mocks.session = { user: { id: "u1" } };
    mocks.findUser.mockResolvedValue({ id: "u1", email: "u@test", name: null, role: "USER", isActive: true });
    mocks.findToken.mockResolvedValue(null);
  });

  const req = (method: string, headers: Record<string, string>) => new Request("https://ff.test/api/v1/feeds", { method, headers });

  it("accepts cookie auth for safe methods even cross-site", async () => {
    expect(await resolveApiUser(req("GET", { "sec-fetch-site": "cross-site" }))).toMatchObject({ id: "u1" });
  });

  it("accepts cookie auth for same-origin mutations and non-browser clients", async () => {
    expect(await resolveApiUser(req("POST", { "sec-fetch-site": "same-origin" }))).toMatchObject({ id: "u1" });
    expect(await resolveApiUser(req("POST", {}))).toMatchObject({ id: "u1" });
  });

  it("ignores the session cookie on cross-site mutations", async () => {
    expect(await resolveApiUser(req("POST", { "sec-fetch-site": "cross-site" }))).toBeNull();
    expect(await resolveApiUser(req("DELETE", { origin: "https://evil.example", host: "ff.test" }))).toBeNull();
  });
});
