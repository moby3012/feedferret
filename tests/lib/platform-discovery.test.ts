import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * discoverFeeds × adapter registry × transport fallback, against a mocked
 * transport (no network). A route can depend on the transport: `plain` is
 * what undici gets, `impit` what the browser-fingerprint client gets.
 */

type Route = string | Error | { plain: string | Error; impit: string | Error };
const mocks = vi.hoisted(() => ({
  routes: new Map<string, unknown>(),
  headers: new Map<string, Record<string, string>>(),
  calls: [] as Array<{ url: string; impersonate: boolean }>,
  rsshub: { config: null as null | { url: string }, routes: [] as Array<{ route: string; title: string }> },
}));

function respond(url: string, options: any = {}) {
  const impersonate = options?.impersonate === true;
  mocks.calls.push({ url, impersonate });
  const route = mocks.routes.get(url) as Route | undefined;
  if (route === undefined) throw new Error("Fetch failed: 404");
  const body = typeof route === "object" && !(route instanceof Error) ? (impersonate ? route.impit : route.plain) : route;
  if (body instanceof Error) throw body;
  if (options?.maxBytes && Buffer.byteLength(body) > options.maxBytes) return Buffer.from(body).subarray(0, options.maxBytes).toString("utf8");
  return body;
}

vi.mock("../../lib/ssrf", async () => {
  const actual = await vi.importActual<any>("../../lib/ssrf");
  return {
    ...actual,
    fetchTextWithSsrfProtection: vi.fn(async (url: string, _init?: unknown, options?: any) => respond(url, options)),
    fetchWithSsrfProtection: vi.fn(async (url: string, _init?: unknown, options?: any) => ({
      notModified: false,
      text: respond(url, options),
      etag: null,
      lastModified: null,
      headers: new Headers(mocks.headers.get(url) ?? {}),
      url,
    })),
    isTrustedFeedFetchingAllowed: vi.fn().mockResolvedValue(false),
  };
});
vi.mock("../../lib/rsshub", () => ({
  radarRoutesFor: () => mocks.rsshub.routes,
  getRsshubConfig: vi.fn(async () => mocks.rsshub.config),
  validateRsshubRoute: vi.fn(async () => ({ ok: true, title: "Timeline" })),
  buildRsshubPublicRouteUrl: vi.fn((config: { url: string }, route: string) => `${config.url}${route}`),
}));

import { discoverFeeds } from "../../lib/feed-discovery";
import { feedSourceLabel } from "../../lib/feed-source-label";

const adapterFixture = (name: string) => readFileSync(path.join(__dirname, "../fixtures/adapters", `${name}.html`), "utf8");
const rss = (title: string, id = title) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${title}</title><link>https://x.example/</link><item><title>One</title><link>https://x.example/${encodeURIComponent(id)}/1</link><guid>${id}-1</guid></item></channel></rss>`;
const refused = (status: number) => new Error(`Fetch failed: ${status}`);

beforeEach(() => {
  mocks.routes.clear();
  mocks.headers.clear();
  mocks.calls.length = 0;
  mocks.rsshub.config = null;
  mocks.rsshub.routes = [];
  vi.stubEnv("FEEDFERRET_DISABLE_IMPIT", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("platform adapters in discovery", () => {
  it("ModDB: the site refuses bots, the rss host serves the mod's news + downloads feeds (labelled ModDB/IndieDB)", async () => {
    mocks.routes.set("https://www.moddb.com/mods/mental-omega", refused(403));
    mocks.routes.set("https://rss.moddb.com/mods/mental-omega/articles/feed/rss.xml", rss("Mental Omega news"));
    mocks.routes.set("https://rss.moddb.com/mods/mental-omega/downloads/feed/rss.xml", rss("Mental Omega downloads"));
    const result = await discoverFeeds("https://www.moddb.com/mods/mental-omega");
    expect(result.feeds.map((f) => [f.url, f.title, f.kind, f.source])).toEqual([
      ["https://rss.moddb.com/mods/mental-omega/articles/feed/rss.xml", "Mental Omega news", "news", "resolver"],
      ["https://rss.moddb.com/mods/mental-omega/downloads/feed/rss.xml", "Mental Omega downloads", "downloads", "resolver"],
    ]);
    expect(result.feeds[0].via).toEqual({ family: "platform", name: "ModDB/IndieDB" });
    // Adapter hit → the bot-walled page itself is never fetched.
    expect(mocks.calls.some((c) => c.url === "https://www.moddb.com/mods/mental-omega")).toBe(false);
  });

  it("a platform adapter whose endpoints all fail verification falls through to page discovery (and its hint)", async () => {
    mocks.routes.set("https://www.nexusmods.com/skyrimspecialedition/rss/newtoday/", refused(403));
    mocks.routes.set("https://www.nexusmods.com/skyrimspecialedition/rss/updatedtoday/", refused(403));
    mocks.routes.set("https://www.nexusmods.com/skyrimspecialedition", refused(403));
    const result = await discoverFeeds("https://www.nexusmods.com/skyrimspecialedition");
    expect(result.feeds).toEqual([]);
    expect(result.hint).toBe("blocked");
  });

  it("existing URL-scheme rules carry a platform label too (Reddit-Feed)", async () => {
    const result = await discoverFeeds("https://www.reddit.com/r/commandandconquer/");
    expect(result.feeds[0]).toMatchObject({ url: "https://www.reddit.com/r/commandandconquer/.rss", via: { family: "platform", name: "Reddit" } });
    expect(feedSourceLabel(result.feeds[0])).toEqual({ key: "feedSource.platform", values: { name: "Reddit" } });
  });
});

describe("software adapters in discovery", () => {
  it("Discourse in a sub-folder without <link rel=alternate> (Blizzard-forum shape) → latest.rss, labelled Discourse forum", async () => {
    mocks.routes.set("https://forums.example.com/en/wow/", adapterFixture("discourse-subfolder"));
    mocks.routes.set("https://forums.example.com/en/wow/latest.rss", rss("Latest WoW topics"));
    const result = await discoverFeeds("https://forums.example.com/en/wow/");
    expect(result.feeds).toHaveLength(1);
    expect(result.feeds[0]).toMatchObject({
      url: "https://forums.example.com/en/wow/latest.rss",
      title: "Latest WoW topics",
      source: "software",
      kind: "latest",
      platform: "discourse",
      via: { family: "forum", name: "Discourse" },
    });
    // The software's feed verified → no blind common-path probing.
    expect(mocks.calls.some((c) => c.url === "https://forums.example.com/feed")).toBe(false);
  });

  it("blue-post tracker page → the group's posts feed first, then the site feed", async () => {
    const page = "https://forums.example.com/en/wow/groups/blizzard-tracker/posts";
    mocks.routes.set(page, adapterFixture("discourse-subfolder"));
    mocks.routes.set(`${page}.rss`, rss("Blizzard tracker"));
    mocks.routes.set("https://forums.example.com/en/wow/latest.rss", rss("Latest WoW topics"));
    const result = await discoverFeeds(page);
    expect(result.feeds.map((f) => f.url)).toEqual([`${page}.rss`, "https://forums.example.com/en/wow/latest.rss"]);
    expect(result.feeds[0].kind).toBe("posts");
  });

  it("phpBB with feeds disabled: wrong guesses are dropped silently, nothing bogus is offered", async () => {
    mocks.routes.set("https://ppm.example.com/", adapterFixture("phpbb"));
    const result = await discoverFeeds("https://ppm.example.com/");
    expect(result.feeds).toEqual([]);
    expect(mocks.calls.map((c) => c.url)).toEqual(expect.arrayContaining(["https://ppm.example.com/app.php/feed", "https://ppm.example.com/feed.php"]));
  });

  it("a <link>-advertised feed that is also the software's endpoint keeps the software label", async () => {
    const html = adapterFixture("discourse-root").replace(
      "</head>",
      '<link rel="alternate" type="application/rss+xml" title="Latest posts" href="https://meta.example.org/latest.rss"></head>',
    );
    mocks.routes.set("https://meta.example.org/", html);
    mocks.routes.set("https://meta.example.org/latest.rss", rss("Meta latest"));
    const result = await discoverFeeds("https://meta.example.org/");
    expect(result.feeds).toHaveLength(1);
    expect(result.feeds[0]).toMatchObject({ source: "html", via: { family: "forum", name: "Discourse" }, title: "Latest posts" });
  });

  it("NodeBB recognised from the X-Powered-By header alone", async () => {
    mocks.routes.set("https://bb.example.org/", "<!doctype html><title>Forum</title><div id=content></div>");
    mocks.headers.set("https://bb.example.org/", { "x-powered-by": "NodeBB" });
    mocks.routes.set("https://bb.example.org/recent.rss", rss("Recent"));
    const result = await discoverFeeds("https://bb.example.org/");
    expect(result.feeds.map((f) => [f.url, f.source])).toEqual([["https://bb.example.org/recent.rss", "software"]]);
  });
});

describe("transport fallback", () => {
  it("homepage refused (403) by the plain client → retried once with the browser-like client, which finds the feed", async () => {
    mocks.routes.set("https://xf.example.com/community/", { plain: refused(403), impit: adapterFixture("xenforo") });
    mocks.routes.set("https://xf.example.com/community/forums/-/index.rss", rss("XF latest"));
    const result = await discoverFeeds("https://xf.example.com/community/");
    expect(result.feeds.map((f) => f.url)).toEqual(["https://xf.example.com/community/forums/-/index.rss"]);
    const pageCalls = mocks.calls.filter((c) => c.url === "https://xf.example.com/community/");
    expect(pageCalls).toEqual([
      { url: "https://xf.example.com/community/", impersonate: false },
      { url: "https://xf.example.com/community/", impersonate: true },
    ]);
  });

  it("402 on the candidate feed (plain) → verified via the other transport", async () => {
    mocks.routes.set(
      "https://news.example.de/",
      '<html><head><link rel="alternate" type="application/rss+xml" title="News" href="/rss/news.rdf"></head></html>',
    );
    mocks.routes.set("https://news.example.de/rss/news.rdf", { plain: refused(402), impit: rss("News") });
    const result = await discoverFeeds("https://news.example.de/");
    expect(result.feeds.map((f) => f.url)).toEqual(["https://news.example.de/rss/news.rdf"]);
  });

  it("an empty 200 body counts as a refusal too", async () => {
    mocks.routes.set("https://empty.example.com/", {
      plain: "   ",
      impit: '<html><head><link rel="alternate" type="application/atom+xml" href="/atom.xml"></head></html>',
    });
    mocks.routes.set("https://empty.example.com/atom.xml", '<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><entry><id>1</id></entry></feed>');
    const result = await discoverFeeds("https://empty.example.com/");
    expect(result.feeds.map((f) => f.url)).toEqual(["https://empty.example.com/atom.xml"]);
  });

  it("both transports refused → the first refusal's hint (blocked), no second retry loop", async () => {
    mocks.routes.set("https://wall.example.com/", { plain: refused(403), impit: refused(429) });
    const result = await discoverFeeds("https://wall.example.com/");
    expect(result.hint).toBe("blocked");
    expect(mocks.calls.filter((c) => c.url === "https://wall.example.com/")).toHaveLength(2);
  });

  it("a 404 is not retried with the other transport", async () => {
    const result = await discoverFeeds("https://gone.example.com/");
    expect(result.feeds).toEqual([]);
    expect(mocks.calls.filter((c) => c.url === "https://gone.example.com/")).toEqual([{ url: "https://gone.example.com/", impersonate: false }]);
  });

  it("no retry when the browser-like client is disabled on this instance", async () => {
    vi.stubEnv("FEEDFERRET_DISABLE_IMPIT", "1");
    mocks.routes.set("https://xf2.example.com/", { plain: refused(403), impit: adapterFixture("xenforo") });
    const result = await discoverFeeds("https://xf2.example.com/");
    expect(result.feeds).toEqual([]);
    expect(mocks.calls.filter((c) => c.url === "https://xf2.example.com/")).toHaveLength(1);
  });
});

describe("RSSHub step", () => {
  it("platform without a native feed and no RSSHub configured → needs-rsshub naming the platform", async () => {
    mocks.rsshub.routes = [{ route: "/twitter/user/EA", title: "Timeline" }];
    mocks.routes.set("https://x.com/EA", refused(403));
    const result = await discoverFeeds("https://x.com/EA");
    expect(result.feeds).toEqual([]);
    expect(result.hint).toBe("needs-rsshub");
    expect(result.hintPlatform).toBe("X/Twitter");
  });

  it("with RSSHub configured the validated route is offered, labelled 'via RSSHub'", async () => {
    mocks.rsshub.routes = [{ route: "/twitter/user/EA", title: "Timeline" }];
    mocks.rsshub.config = { url: "https://rsshub.example.net" };
    mocks.routes.set("https://x.com/EA", refused(403));
    const result = await discoverFeeds("https://x.com/EA");
    expect(result.feeds).toHaveLength(1);
    expect(result.feeds[0]).toMatchObject({ url: "https://rsshub.example.net/twitter/user/EA", source: "radar", via: { family: "rsshub", name: "RSSHub" } });
    expect(feedSourceLabel(result.feeds[0])?.key).toBe("feedSource.rsshub");
  });
});

describe("feedSourceLabel", () => {
  it("maps stages without an adapter onto generic labels", () => {
    expect(feedSourceLabel({ source: "html" })?.key).toBe("feedSource.html");
    expect(feedSourceLabel({ source: "common-path" })?.key).toBe("feedSource.commonPath");
    expect(feedSourceLabel({ source: "curated" })?.key).toBe("feedSource.curated");
    expect(feedSourceLabel({ source: "topic" })).toBeNull();
    expect(feedSourceLabel({ source: "software", via: { family: "forum", name: "phpBB" } })).toEqual({ key: "feedSource.forum", values: { name: "phpBB" } });
  });
});
