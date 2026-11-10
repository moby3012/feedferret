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
  connectorFeedUrlErrorWith,
  connectorUrlMigrationEnabled,
  getConnectorSecretRules,
  redactConnectorTextWith,
  redactFeedWith,
  resetConnectorSecretRulesCache,
  resolveConnectorRequestWith,
  scrubConnectorSecretsFromArticleLinks,
  stripConnectorSecretsWith,
  type ConnectorSecretRule,
} from "../../lib/connector-secrets";
import { db as mockedDb } from "@/lib/db";
import { rsshubRouteError, validateRsshubRoute } from "../../lib/rsshub";
import { buildDefaultWebhookBody, executeWebhookCall, interpolate } from "../../lib/webhooks";
import { resolveApiUser } from "../../lib/api-auth";
import { POST as feverPost } from "../../app/api/fever/route";

const rules: ConnectorSecretRule[] = [
  { kind: "rsshub", origin: "http://rsshub:1200", basePath: "", param: "key", value: "rsskey" },
  { kind: "changedetection", origin: "https://cd.example", basePath: "/cd", param: "token", value: "cdtoken" },
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

  it("adds the secret and internal trust ONLY for allowed connector routes (no read-SSRF via the connector)", () => {
    // Allowed: platform route / single watch feed (legacy keyed rows too).
    expect(resolveConnectorRequestWith(rules, "http://rsshub:1200/youtube/channel/UC1?limit=5")).toEqual({ url: "http://rsshub:1200/youtube/channel/UC1?limit=5&key=rsskey", trusted: true });
    expect(resolveConnectorRequestWith(rules, "http://rsshub:1200/youtube/x?key=rsskey")).toEqual({ url: "http://rsshub:1200/youtube/x?key=rsskey", trusted: true });
    expect(resolveConnectorRequestWith(rules, "https://cd.example/cd/rss/watch/0b8f6c2e-1d3a-4a5b-9c7d-112233445566")).toEqual({
      url: "https://cd.example/cd/rss/watch/0b8f6c2e-1d3a-4a5b-9c7d-112233445566?token=cdtoken",
      trusted: true,
    });
    // Refused: RSSHub built-ins / transform / api, encoded tricks, changedetection all-watches or tag feeds.
    for (const url of [
      "http://rsshub:1200/rsshub/transform/html/http%3A%2F%2Fpostgres%3A5432%2F/item=a",
      "http://rsshub:1200/RSSHub/routes",
      "http://rsshub:1200/api/routes",
      "http://rsshub:1200/%72sshub/transform/html/x/y",
      "http://rsshub:1200/youtube/..%2Frsshub%2Ftransform",
      "http://rsshub:1200/",
      "https://cd.example/cd/rss",
      "https://cd.example/cd/rss/tag/news",
      "https://cd.example/cd/rss/watch/1?tag=x",
      "https://cd.example/cd/api/v1/watch",
    ]) {
      expect(resolveConnectorRequestWith(rules, url), url).toEqual({ url, trusted: false });
      expect(applyConnectorSecretsWith(rules, url), url).toBe(url);
      expect(connectorFeedUrlErrorWith(rules, url), url).not.toBeNull();
    }
    // Not a connector URL at all: untouched, not trusted, no create-time error.
    expect(resolveConnectorRequestWith(rules, "https://blog.example/rsshub/transform")).toEqual({ url: "https://blog.example/rsshub/transform", trusted: false });
    expect(connectorFeedUrlErrorWith(rules, "https://blog.example/rsshub/transform")).toBeNull();
    expect(connectorFeedUrlErrorWith(rules, "http://rsshub:1200/github/issue/a/b?key=rsskey")).toBeNull();
  });

  it("does not memoize connector rules from a failed config read", async () => {
    const findUnique = mockedDb.globalSettings.findUnique as unknown as ReturnType<typeof vi.fn>;
    resetConnectorSecretRulesCache();
    findUnique.mockRejectedValueOnce(new Error("db down")).mockRejectedValueOnce(new Error("db down"));
    expect(await getConnectorSecretRules()).toEqual([]);
    findUnique.mockResolvedValue({ rsshubEnabled: true, rsshubBaseUrl: "http://rsshub:1200", rsshubApiKey: null });
    expect(await getConnectorSecretRules()).toEqual([{ kind: "rsshub", origin: "http://rsshub:1200", basePath: "", param: "key", value: null }]);
    // A successful read is memoized.
    findUnique.mockResolvedValue(null);
    expect((await getConnectorSecretRules()).length).toBe(1);
    resetConnectorSecretRulesCache();
    expect(await getConnectorSecretRules()).toEqual([]);
    findUnique.mockReset().mockResolvedValue(null);
  });

  it("stored URL / article link migration is opt-in (FEEDFERRET_MIGRATE_CONNECTOR_URLS)", () => {
    expect(connectorUrlMigrationEnabled({})).toBe(false);
    expect(connectorUrlMigrationEnabled({ FEEDFERRET_MIGRATE_CONNECTOR_URLS: "0" })).toBe(false);
    expect(connectorUrlMigrationEnabled({ FEEDFERRET_MIGRATE_CONNECTOR_URLS: "1" })).toBe(true);
    expect(connectorUrlMigrationEnabled({ FEEDFERRET_MIGRATE_CONNECTOR_URLS: "true" })).toBe(true);
  });

  it("article link cleanup strips the secret, keeps updatedAt and is idempotent", async () => {
    const updatedAt = new Date("2026-01-01T00:00:00Z");
    const rows = [
      { id: "a1", link: "http://rsshub:1200/youtube/x?key=rsskey#item-1", updatedAt },
      { id: "a2", link: "http://rsshub:1200/youtube/x#item-2", updatedAt },
    ];
    const update = vi.fn(async ({ where, data }: { where: { id: string }; data: { link: string } }) => {
      const row = rows.find((r) => r.id === where.id)!;
      row.link = data.link;
    });
    const fakeDb = {
      article: {
        findMany: vi.fn(async ({ where }: { where: { link: { contains: string }; id?: { gt: string } } }) =>
          rows.filter((r) => r.link.includes(where.link.contains) && (!where.id || r.id > where.id.gt)),
        ),
        update,
      },
    };
    expect(await scrubConnectorSecretsFromArticleLinks(fakeDb, rules)).toEqual({ scanned: 1, scrubbed: 1 });
    expect(rows[0].link).toBe("http://rsshub:1200/youtube/x#item-1");
    expect(update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { link: "http://rsshub:1200/youtube/x#item-1", updatedAt } });
    expect(await scrubConnectorSecretsFromArticleLinks(fakeDb, rules)).toEqual({ scanned: 0, scrubbed: 0 });
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

  it("rejects percent-encoded bypasses of the route allowlist", () => {
    expect(rsshubRouteError("/%72sshub/transform/html/x/y")).not.toBeNull();
    expect(rsshubRouteError("/%52SSHUB/routes")).not.toBeNull();
    expect(rsshubRouteError("/%61pi/routes")).not.toBeNull();
    expect(rsshubRouteError("/youtube%2f..%2frsshub/transform")).not.toBeNull();
    expect(rsshubRouteError("/youtube/a%2Fb")).not.toBeNull();
    expect(rsshubRouteError("/youtube/%2E%2E/rsshub")).not.toBeNull();
    expect(rsshubRouteError("/youtube/%zz")).not.toBeNull();
    expect(rsshubRouteError("/youtube/x%00")).not.toBeNull();
    // Encoded characters in later segments are fine (handles, non-ASCII names).
    expect(rsshubRouteError("/youtube/user/%40handle")).toBeNull();
    expect(rsshubRouteError("/bilibili/user/video/%E4%B8%AD")).toBeNull();
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
