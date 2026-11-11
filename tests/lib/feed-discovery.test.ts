import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchText: vi.fn(),
  getRsshubConfig: vi.fn(),
  validateRsshubRoute: vi.fn(),
}));

vi.mock("../../lib/ssrf", async () => {
  const actual = await vi.importActual<any>("../../lib/ssrf");
  return {
    ...actual,
    fetchTextWithSsrfProtection: mocks.fetchText,
    fetchWithSsrfProtection: vi.fn(async (url: string, init?: any, options?: any) => {
      const text = await mocks.fetchText(url, init, options);
      return { notModified: false, text, etag: null, lastModified: null, headers: new Headers() };
    }),
    isTrustedFeedFetchingAllowed: vi.fn().mockResolvedValue(false),
  };
});
vi.mock("../../lib/rsshub", async () => {
  const { matchRadarRules } = await import("../../lib/rsshub-radar-rules");
  return {
    radarRoutesFor: (s: string) => (/^https?:\/\/\S+$/i.test(s.trim()) ? matchRadarRules(s.trim()) : []),
    getRsshubConfig: mocks.getRsshubConfig,
    validateRsshubRoute: mocks.validateRsshubRoute,
    buildRsshubRouteUrl: (c: { baseUrl: string; apiKey?: string | null }, route: string) =>
      `${c.baseUrl.replace(/\/+$/, "")}${route}${c.apiKey ? `?key=${c.apiKey}` : ""}`,
    buildRsshubPublicRouteUrl: (c: { baseUrl: string }, route: string) => `${c.baseUrl.replace(/\/+$/, "")}${route}`,
  };
});

import { COMMON_FEED_PATHS, discoverFeeds, discoverFeedsAtUrl } from "../../lib/feed-discovery";

const RSS = '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title></channel></rss>';
const ATOM = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title></feed>';
const JSONFEED = '{"version":"https://jsonfeed.org/version/1.1","items":[]}';
const CHANNEL = "UCBJycsmduvYEL83R_U4JriQ";

/** Route mocked network responses by exact URL; anything else is a 404. */
function serve(routes: Record<string, string>) {
  mocks.fetchText.mockImplementation(async (url: string) => {
    if (url in routes) return routes[url];
    throw new Error("Fetch failed: 404");
  });
}
const fetched = () => mocks.fetchText.mock.calls.map((c) => c[0] as string);

beforeEach(() => {
  mocks.fetchText.mockReset();
  mocks.getRsshubConfig.mockReset().mockResolvedValue(null);
  mocks.validateRsshubRoute.mockReset();
});

describe("discoverFeeds — topic phrases", () => {
  it("returns locale-aware search feeds without touching the network", async () => {
    const r = await discoverFeeds("Rust async runtimes", { locale: "de" });
    expect(r.mode).toBe("topic");
    expect(r.feeds.map((f) => f.platform)).toEqual(["google-news", "bing-news", "hackernews", "arxiv"]);
    expect(r.feeds[0]).toMatchObject({ source: "topic", type: "rss" });
    expect(r.feeds[0].url).toContain("hl=de&gl=DE");
    expect(mocks.fetchText).not.toHaveBeenCalled();
  });

  it("empty input → empty result", async () => {
    expect(await discoverFeeds("  ")).toEqual({ mode: "empty", feeds: [] });
  });
});

describe("discoverFeeds — platform rules run before scraping", () => {
  it("GitHub repo resolves with zero network calls", async () => {
    const r = await discoverFeeds("https://github.com/vercel/next.js");
    expect(r.mode).toBe("url");
    expect(r.feeds.map((f) => f.kind)).toEqual(["releases", "commits", "tags"]);
    expect(r.feeds.every((f) => f.source === "resolver" && f.type === "atom")).toBe(true);
    expect(mocks.fetchText).not.toHaveBeenCalled();
  });

  it("YouTube @handle: one SSRF-protected channel-page fetch, no HTML scraping", async () => {
    serve({ "https://www.youtube.com/@MKBHD": `<link rel="canonical" href="https://www.youtube.com/channel/${CHANNEL}">` });
    const r = await discoverFeeds("@MKBHD");
    expect(r.feeds).toEqual([
      expect.objectContaining({ url: `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`, source: "resolver", platform: "youtube" }),
    ]);
    expect(fetched()).toEqual(["https://www.youtube.com/@MKBHD"]);
    // the lookup is routed through the SSRF helper with a size cap
    expect(mocks.fetchText.mock.calls[0][2]).toMatchObject({ maxBytes: expect.any(Number), timeoutMs: expect.any(Number) });
  });

  it("falls back to HTML discovery when the platform lookup fails", async () => {
    // The handle page has no channel markup (e.g. a consent wall), so the
    // lookup yields nothing — but it still advertises a feed for the scraper.
    serve({
      "https://www.youtube.com/@gone": '<html><link rel="alternate" type="application/rss+xml" href="/rss-alt.xml"></html>',
      "https://www.youtube.com/rss-alt.xml": RSS,
    });
    const r = await discoverFeeds("https://www.youtube.com/@gone");
    expect(r.feeds.map((f) => f.url)).toContain("https://www.youtube.com/rss-alt.xml");
    expect(r.feeds[0].source).toBe("html");
  });

  it("verifies guessed candidates (Mastodon) and drops the ones that are not feeds", async () => {
    serve({ "https://mastodon.social/@Gargron.rss": RSS });
    const ok = await discoverFeeds("@Gargron@mastodon.social");
    expect(ok.feeds.map((f) => f.url)).toEqual(["https://mastodon.social/@Gargron.rss"]);

    serve({});
    const bad = await discoverFeeds("https://example.org/@someone");
    expect(bad.feeds.map((f) => f.url)).not.toContain("https://example.org/@someone.rss");
  });

  it("Apple Podcasts: iTunes lookup → publisher feedUrl", async () => {
    serve({
      "https://itunes.apple.com/lookup?id=1200361736&entity=podcast&country=us": JSON.stringify({ results: [{ collectionName: "The Daily", feedUrl: "https://feeds.example.com/daily" }] }),
    });
    const r = await discoverFeeds("https://podcasts.apple.com/us/podcast/the-daily/id1200361736");
    expect(r.feeds.map((f) => f.url)).toEqual(["https://feeds.example.com/daily"]);
  });
});

describe("discoverFeeds — HTML discovery and common feed paths", () => {
  it("probes the new common paths relative to the site root", async () => {
    serve({ "https://blog.example.com/post/1": "<html></html>" });
    await discoverFeeds("https://blog.example.com/post/1");
    const probed = new Set(fetched());
    for (const p of ["/index.xml", "/feed.json", "/atom.xml", "/rss.xml", "/feed/", "/rss/", "/?feed=rss2"]) {
      expect(probed.has(`https://blog.example.com${p}`), p).toBe(true);
    }
    expect(COMMON_FEED_PATHS).toEqual(expect.arrayContaining(["/index.xml", "/feed.json", "/rss/", "/?feed=rss2"]));
  });

  it("finds Hugo, JSON Feed, WordPress and Ghost feeds and labels their type/source", async () => {
    serve({
      "https://s.example.com/": "<html></html>",
      "https://s.example.com/index.xml": RSS,
      "https://s.example.com/feed.json": JSONFEED,
      "https://s.example.com/?feed=rss2": RSS,
      "https://s.example.com/rss/": ATOM,
    });
    const r = await discoverFeeds("https://s.example.com/");
    const byUrl = Object.fromEntries(r.feeds.map((f) => [f.url, f]));
    expect(byUrl["https://s.example.com/index.xml"]).toMatchObject({ type: "rss", source: "common-path" });
    expect(byUrl["https://s.example.com/feed.json"]).toMatchObject({ type: "json", source: "common-path" });
    expect(byUrl["https://s.example.com/?feed=rss2"]).toBeDefined();
    expect(byUrl["https://s.example.com/rss/"]).toMatchObject({ type: "atom" });
  });

  it("advertised <link rel=alternate> feeds come first", async () => {
    serve({
      "https://s.example.com/": '<link rel="alternate" type="application/atom+xml" title="Main" href="/custom.atom">',
      "https://s.example.com/custom.atom": ATOM,
      "https://s.example.com/feed.xml": RSS,
    });
    const r = await discoverFeeds("https://s.example.com/");
    expect(r.feeds[0]).toMatchObject({ url: "https://s.example.com/custom.atom", title: "Main", source: "html" });
  });

  it("still probes common paths when the page itself can't be fetched", async () => {
    serve({ "https://down.example.com/feed": RSS });
    const r = await discoverFeeds("https://down.example.com/");
    expect(r.feeds.map((f) => f.url)).toEqual(["https://down.example.com/feed"]);
  });

  it("scheme-less input is understood", async () => {
    serve({ "https://noscheme.example.com/feed.xml": RSS });
    expect((await discoverFeeds("noscheme.example.com")).feeds.map((f) => f.url)).toContain("https://noscheme.example.com/feed.xml");
  });
});

describe("discoverFeeds — RSSHub radar stage", () => {
  const config = { baseUrl: "http://rsshub.internal:1200", apiKey: null };

  it("adds validated RSSHub routes only when an instance is configured", async () => {
    mocks.getRsshubConfig.mockResolvedValue(config);
    mocks.validateRsshubRoute.mockImplementation(async (_c: unknown, route: string) =>
      route.startsWith("/github/issue/") ? { ok: true, title: "Issues", itemCount: 3, sampleTitles: [] } : { ok: false, reason: "nope" },
    );
    const r = await discoverFeeds("https://github.com/vercel/next.js");
    const radar = r.feeds.filter((f) => f.source === "radar");
    expect(radar).toEqual([
      expect.objectContaining({ url: "http://rsshub.internal:1200/github/issue/vercel/next.js", platform: "rsshub", kind: "rsshub" }),
    ]);
    expect(r.feeds.slice(0, 3).map((f) => f.source)).toEqual(["resolver", "resolver", "resolver"]);
  });

  it("never returns the RSSHub access key in discovery results", async () => {
    mocks.getRsshubConfig.mockResolvedValue({ ...config, apiKey: "s3cret-admin-key" });
    mocks.validateRsshubRoute.mockResolvedValue({ ok: true, title: "Issues", itemCount: 3, sampleTitles: [] });
    const r = await discoverFeeds("https://github.com/vercel/next.js");
    const radar = r.feeds.filter((f) => f.source === "radar");
    expect(radar.length).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain("s3cret-admin-key");
  });

  it("is skipped (and free) without an RSSHub instance", async () => {
    const r = await discoverFeeds("https://github.com/vercel/next.js");
    expect(r.feeds.some((f) => f.source === "radar")).toBe(false);
    expect(mocks.validateRsshubRoute).not.toHaveBeenCalled();
  });

  it("does not consult RSSHub at all for URLs no rule matches", async () => {
    mocks.getRsshubConfig.mockResolvedValue(config);
    serve({});
    await discoverFeeds("https://nothing-known.example.com/");
    expect(mocks.getRsshubConfig).not.toHaveBeenCalled();
  });

  it("a failing RSSHub never breaks discovery", async () => {
    mocks.getRsshubConfig.mockRejectedValue(new Error("db down"));
    const r = await discoverFeeds("https://github.com/vercel/next.js");
    expect(r.feeds.map((f) => f.kind)).toEqual(["releases", "commits", "tags"]);
  });
});

describe("discoverFeedsAtUrl (back-compat)", () => {
  it("returns just the feed list", async () => {
    const feeds = await discoverFeedsAtUrl("https://github.com/o/r");
    expect(Array.isArray(feeds)).toBe(true);
    expect(feeds[0].url).toBe("https://github.com/o/r/releases.atom");
  });
});
