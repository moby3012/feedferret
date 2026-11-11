import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * discoverFeeds × adapter registry × transport fallback, against a mocked
 * transport (no network). A route can depend on the transport: `plain` is
 * what undici gets, `impit` what the browser-fingerprint client gets.
 */

/** "hang" = never answers until the request's abort signal fires. */
type Body = string | Error | "hang";
type Route = Body | { plain: Body; impit: Body };
const mocks = vi.hoisted(() => ({
  routes: new Map<string, unknown>(),
  headers: new Map<string, Record<string, string>>(),
  calls: [] as Array<{ url: string; impersonate: boolean }>,
  rsshub: { config: null as null | { url: string }, routes: [] as Array<{ route: string; title: string }> },
}));

async function respond(url: string, options: any = {}, signal?: AbortSignal | null) {
  const impersonate = options?.impersonate === true;
  mocks.calls.push({ url, impersonate });
  const route = mocks.routes.get(url) as Route | undefined;
  if (route === undefined) throw new Error("Fetch failed: 404");
  const body = typeof route === "object" && !(route instanceof Error) ? (impersonate ? route.impit : route.plain) : route;
  if (body === "hang") {
    return new Promise<string>((_, reject) => {
      if (signal?.aborted) return reject(new Error("aborted"));
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }
  if (body instanceof Error) throw body;
  if (options?.maxBytes && Buffer.byteLength(body) > options.maxBytes) return Buffer.from(body).subarray(0, options.maxBytes).toString("utf8");
  return body;
}

vi.mock("../../lib/ssrf", async () => {
  const actual = await vi.importActual<any>("../../lib/ssrf");
  return {
    ...actual,
    fetchTextWithSsrfProtection: vi.fn(async (url: string, init?: RequestInit, options?: any) => respond(url, options, init?.signal)),
    fetchWithSsrfProtection: vi.fn(async (url: string, init?: RequestInit, options?: any) => ({
      notModified: false,
      text: await respond(url, options, init?.signal),
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
import { hostBackoffRemainingMs, resetHostBackoff } from "../../lib/host-backoff";
import { HttpStatusError } from "../../lib/ssrf";
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
  resetHostBackoff();
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

  it("an empty 200 body on a candidate feed (bot wall) → verified via the other transport", async () => {
    mocks.routes.set(
      "https://wall2.example.com/",
      '<html><head><link rel="alternate" type="application/rss+xml" title="Wall" href="/feed.xml"></head></html>',
    );
    mocks.routes.set("https://wall2.example.com/feed.xml", { plain: "  \n ", impit: rss("Wall feed") });
    const result = await discoverFeeds("https://wall2.example.com/");
    expect(result.feeds.map((f) => f.url)).toEqual(["https://wall2.example.com/feed.xml"]);
    expect(mocks.calls.filter((c) => c.url === "https://wall2.example.com/feed.xml")).toEqual([
      { url: "https://wall2.example.com/feed.xml", impersonate: false },
      { url: "https://wall2.example.com/feed.xml", impersonate: true },
    ]);
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

describe("rate limits (429 / Retry-After)", () => {
  it("429 is never retried on the other transport; the host gets no further probe in this run", async () => {
    mocks.routes.set("https://busy.example.com/", { plain: refused(429), impit: adapterFixture("xenforo") });
    const result = await discoverFeeds("https://busy.example.com/");
    expect(result.feeds).toEqual([]);
    expect(result.hint).toBe("rate-limited");
    // One request in total: no impit retry, no common-path / software probes of that host.
    expect(mocks.calls.filter((c) => new URL(c.url).hostname === "busy.example.com")).toEqual([
      { url: "https://busy.example.com/", impersonate: false },
    ]);
  });

  it("a candidate answering 429 blocks its host for the remaining candidates (both transports)", async () => {
    const links = ["/a.xml", "/b.xml", "/c.xml"].map((h) => `<link rel="alternate" type="application/rss+xml" href="${h}">`).join("");
    mocks.routes.set("https://feeds.example.com/", `<html><head>${links}</head></html>`);
    mocks.routes.set("https://feeds.example.com/a.xml", refused(429));
    mocks.routes.set("https://feeds.example.com/b.xml", refused(429));
    mocks.routes.set("https://feeds.example.com/c.xml", refused(429));
    const result = await discoverFeeds("https://feeds.example.com/", { limits: { deadlineMs: 5_000, maxRequests: 30 } });
    expect(result.feeds).toEqual([]);
    const feedCalls = mocks.calls.filter((c) => c.url.endsWith(".xml"));
    // Batch of three goes out in parallel; nothing after the 429s, no impit retries, no common paths.
    expect(feedCalls.every((c) => c.impersonate === false)).toBe(true);
    expect(mocks.calls.some((c) => c.url === "https://feeds.example.com/feed")).toBe(false);
  });

  it("the Retry-After window also holds for the next discovery run (no request at all)", async () => {
    mocks.routes.set("https://slow.example.com/", refused(429));
    await discoverFeeds("https://slow.example.com/");
    mocks.calls.length = 0;
    mocks.routes.set("https://slow.example.com/", adapterFixture("xenforo"));
    const again = await discoverFeeds("https://slow.example.com/");
    expect(again.hint).toBe("rate-limited");
    expect(mocks.calls).toEqual([]);
  });

  it("any refusal carrying a Retry-After (HttpStatusError shape) is not retried and blocks the host", async () => {
    const err = new HttpStatusError(403, "Fetch failed: 403", 120_000);
    mocks.routes.set("https://ra.example.com/", { plain: err, impit: adapterFixture("xenforo") });
    await discoverFeeds("https://ra.example.com/");
    expect(mocks.calls.filter((c) => c.url === "https://ra.example.com/")).toHaveLength(1);
    // Recorded in the shared per-host backoff (lib/host-backoff.ts) with the server's window.
    expect(hostBackoffRemainingMs("https://ra.example.com/x")).toBeGreaterThan(110_000);
  });

  it("a 429 with Retry-After lands in the shared host backoff, which full-text fetches honour too", async () => {
    mocks.routes.set("https://shared.example.com/", { plain: new HttpStatusError(429, "Fetch failed: 429", 30_000), impit: adapterFixture("xenforo") });
    const result = await discoverFeeds("https://shared.example.com/");
    expect(result.hint).toBe("rate-limited");
    const remaining = hostBackoffRemainingMs("https://shared.example.com/article");
    expect(remaining).toBeGreaterThan(0);
  });

  it("a full-text 403/network backoff (not a rate limit) does not block an interactive discovery", async () => {
    const { recordHostFailure } = await import("../../lib/host-backoff");
    recordHostFailure("https://ft.example.com/a", new HttpStatusError(403, "Fetch failed: 403"));
    mocks.routes.set("https://ft.example.com/", '<html><head><link rel="alternate" type="application/rss+xml" href="/f.xml"></head></html>');
    mocks.routes.set("https://ft.example.com/f.xml", rss("FT"));
    const result = await discoverFeeds("https://ft.example.com/");
    expect(result.feeds.map((f) => f.url)).toEqual(["https://ft.example.com/f.xml"]);
  });
});

describe("run budget", () => {
  it("deadline: in-flight requests are aborted and verified feeds come back as a partial result", async () => {
    const links = ['<link rel="alternate" type="application/rss+xml" title="Fast" href="/fast.xml">', '<link rel="alternate" type="application/rss+xml" title="Slow" href="/slow.xml">'].join("");
    mocks.routes.set("https://tarpit.example.com/", `<html><head>${links}</head></html>`);
    mocks.routes.set("https://tarpit.example.com/fast.xml", rss("Fast"));
    mocks.routes.set("https://tarpit.example.com/slow.xml", "hang");
    const started = Date.now();
    const result = await discoverFeeds("https://tarpit.example.com/", { limits: { deadlineMs: 300, maxRequests: 30 } });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.feeds.map((f) => f.url)).toEqual(["https://tarpit.example.com/fast.xml"]);
    expect(result.partial).toBe("deadline");
  });

  it("request budget: no more requests than the budget across stages (incl. retries)", async () => {
    const anchors = Array.from({ length: 25 }, (_, i) => `<a href="/feeds/${i}.rss">RSS ${i}</a>`).join("");
    mocks.routes.set("https://many.example.com/", `<html><body>${anchors}</body></html>`);
    for (let i = 0; i < 25; i++) mocks.routes.set(`https://many.example.com/feeds/${i}.rss`, refused(403));
    const result = await discoverFeeds("https://many.example.com/", { limits: { deadlineMs: 5_000, maxRequests: 8 } });
    expect(mocks.calls.length).toBeLessThanOrEqual(8);
    expect(result.feeds).toEqual([]);
    expect(result.partial).toBe("request-budget");
  });

  it("a normal run reports no partial flag", async () => {
    mocks.routes.set("https://ok.example.com/", '<html><head><link rel="alternate" type="application/rss+xml" href="/f.xml"></head></html>');
    mocks.routes.set("https://ok.example.com/f.xml", rss("OK"));
    const result = await discoverFeeds("https://ok.example.com/");
    expect(result.feeds).toHaveLength(1);
    expect(result.partial).toBeUndefined();
  });
});

describe("shared host backoff accounting", () => {
  it("three parallel 429s from one host record ONE failure (base window, no exponential inflation)", async () => {
    const links = ["/a.xml", "/b.xml", "/c.xml"].map((h) => `<link rel="alternate" type="application/rss+xml" href="${h}">`).join("");
    mocks.routes.set("https://burst.example.com/", `<html><head>${links}</head></html>`);
    for (const f of ["a", "b", "c"]) mocks.routes.set(`https://burst.example.com/${f}.xml`, refused(429));
    await discoverFeeds("https://burst.example.com/");
    // Three candidates went out in one parallel batch and all answered 429.
    expect(mocks.calls.filter((c) => c.url.endsWith(".xml"))).toHaveLength(3);
    const remaining = hostBackoffRemainingMs("https://burst.example.com/x");
    expect(remaining).toBeGreaterThan(0);
    // host-backoff: 429 without Retry-After = 5 min base for the FIRST failure (2nd would be 10, 3rd 20).
    expect(remaining).toBeLessThanOrEqual(5 * 60 * 1000);
  });
});

describe("transport memory within a run", () => {
  it("after the browser-like client got past a refusal, the host's next requests start with it", async () => {
    mocks.routes.set("https://pick.example.com/", {
      plain: refused(403),
      impit: '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>',
    });
    mocks.routes.set("https://pick.example.com/feed.xml", { plain: refused(403), impit: rss("Picked") });
    const result = await discoverFeeds("https://pick.example.com/");
    expect(result.feeds.map((f) => f.url)).toEqual(["https://pick.example.com/feed.xml"]);
    expect(mocks.calls.filter((c) => c.url === "https://pick.example.com/feed.xml")).toEqual([
      { url: "https://pick.example.com/feed.xml", impersonate: true },
    ]);
  });
});

describe("hostile pages through discoverFeeds", () => {
  it("candidate addresses over 2 KB are dropped without a request; slash-run paths stay cheap", async () => {
    const longHref = `/feed/${"a".repeat(3000)}.xml`;
    const slashy = `/a${"/".repeat(1500)}x/feed.xml`;
    mocks.routes.set(
      "https://long.example.com/",
      `<html><head><link rel="alternate" type="application/rss+xml" href="${longHref}"><link rel="alternate" type="application/rss+xml" href="${slashy}"></head></html>`,
    );
    mocks.routes.set(`https://long.example.com${slashy}`, rss("Slashy"));
    const started = performance.now();
    const result = await discoverFeeds("https://long.example.com/", { limits: { deadlineMs: 5_000, maxRequests: 30 } });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(mocks.calls.some((c) => c.url.includes("aaaa"))).toBe(false);
    expect(result.feeds.map((f) => f.title)).toEqual(["Slashy"]);
  });

  it.each([
    ["1 MiB of <div>", "<div>".repeat(210_000)],
    ["deep nesting", "<div><span><b><i>".repeat(60_000)],
  ])("%s: discovery finishes quickly and still finds a feed link placed before it", async (_label, junk) => {
    mocks.routes.set("https://junk.example.com/", `<html><head><link rel="alternate" type="application/rss+xml" href="/f.xml"></head><body>${junk}</body></html>`);
    mocks.routes.set("https://junk.example.com/f.xml", rss("Survivor"));
    const started = performance.now();
    const result = await discoverFeeds("https://junk.example.com/");
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result.feeds.map((f) => f.title)).toEqual(["Survivor"]);
  });
});

describe("<base> and oversized addresses through discoverFeeds", () => {
  it("<base href=\"\"> before a hostile <base>: relative links resolve against the response URL", async () => {
    mocks.routes.set("https://site.example.com/blog/", `<html><head><base href=""><base href="https://evil.example/"></head><body><a href="feed.xml">RSS</a></body></html>`);
    mocks.routes.set("https://site.example.com/blog/feed.xml", rss("Site feed"));
    const result = await discoverFeeds("https://site.example.com/blog/");
    expect(result.feeds.map((f) => f.url)).toEqual(["https://site.example.com/blog/feed.xml"]);
    expect(mocks.calls.some((c) => c.url.includes("evil.example"))).toBe(false);
  });

  it("an oversized <base> is not truncated into a different (attacker) base", async () => {
    mocks.routes.set(
      "https://site2.example.com/",
      `<html><head><base href="https://evil.example/${"a".repeat(3000)}"></head><body><a href="feed.xml">RSS</a></body></html>`,
    );
    mocks.routes.set("https://site2.example.com/feed.xml", rss("Site2 feed"));
    const result = await discoverFeeds("https://site2.example.com/");
    expect(result.feeds.map((f) => f.url)).toEqual(["https://site2.example.com/feed.xml"]);
    expect(mocks.calls.some((c) => c.url.includes("evil.example"))).toBe(false);
  });

  it("a 3,000-char href gives no candidate and no request", async () => {
    const href = `/feed.xml?${"a".repeat(2990)}`;
    mocks.routes.set("https://site3.example.com/", `<html><body><a href="${href}">RSS</a><link rel="alternate" type="application/rss+xml" href="${href}"></body></html>`);
    const result = await discoverFeeds("https://site3.example.com/", { limits: { deadlineMs: 5_000, maxRequests: 30 } });
    expect(result.feeds).toEqual([]);
    expect(mocks.calls.some((c) => c.url.startsWith("https://site3.example.com/feed.xml?"))).toBe(false);
  });
});
