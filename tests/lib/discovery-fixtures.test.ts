import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Discovery against the synthetic page fixtures in tests/fixtures/web (no
 * network). The mocked transport honours the caller's byte budget exactly
 * like the real one: `readPrefix` returns the first `maxBytes`, otherwise a
 * larger body fails with "Response too large".
 */

const mocks = vi.hoisted(() => ({
  routes: new Map<string, string | Error>(),
  /** url → redirect target (followed through the caller's redirectGuard, like the real transport). */
  redirects: new Map<string, string>(),
  calls: [] as Array<{ url: string; options: any }>,
}));

function respond(url: string, options: any = {}): string {
  mocks.calls.push({ url, options });
  const target = mocks.redirects.get(url);
  if (target) {
    const next = options?.redirectGuard ? options.redirectGuard(target, url) : target;
    if (!next) throw new Error("Redirect refused");
    return respond(next, options);
  }
  const body = mocks.routes.get(url);
  if (body === undefined) throw new Error("Fetch failed: 404");
  if (body instanceof Error) throw body;
  const bytes = Buffer.byteLength(body);
  if (options?.maxBytes && bytes > options.maxBytes) {
    if (options.readPrefix || options.untilHead) return Buffer.from(body).subarray(0, options.maxBytes).toString("utf8");
    throw new Error(`Response too large (${bytes} bytes > ${options.maxBytes} bytes)`);
  }
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
      headers: new Headers(),
      url,
    })),
    isTrustedFeedFetchingAllowed: vi.fn().mockResolvedValue(false),
  };
});
vi.mock("../../lib/rsshub", () => ({
  radarRoutesFor: () => [],
  getRsshubConfig: vi.fn().mockResolvedValue(null),
  validateRsshubRoute: vi.fn(),
  buildRsshubPublicRouteUrl: vi.fn(),
}));

import {
  discoverFeeds,
  FEED_INDEX_BYTES,
  FEED_SNIFF_BYTES,
  isSameSite,
  RESOLVER_PAGE_BYTES,
  lateLinkElements,
  sectionAffinity,
  sectionFeedPaths,
  sectionSegments,
  siteOf,
  sniffFeedPrefix,
} from "../../lib/feed-discovery";

const fixture = (name: string) => readFileSync(path.join(__dirname, "../fixtures/web", name, "page.html"), "utf8");
const rss = (title: string, firstLink = `https://x.example/${encodeURIComponent(title)}/1`) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${title}</title><link>https://x.example/</link><item><title>One</title><link>${firstLink}</link><guid>${firstLink}</guid></item></channel></rss>`;

/** A >1 MB RSS feed (the size class the old 512 KiB full-read verification dropped). */
function bigFeed(): string {
  const items = Array.from({ length: 900 }, (_, i) =>
    `<item><title>Changelog entry ${i}</title><link>https://big.example/changelog/${i}</link><guid>big-${i}</guid><description><![CDATA[<p>${"Release notes paragraph. ".repeat(50)}</p>]]></description></item>`);
  return `<?xml version="1.0" encoding="UTF-8"?><?xml-stylesheet type="text/xsl" href="/rss.xsl"?><!-- generated --><rss version="2.0"><channel><title>Big Changelog</title><link>https://big.example/</link>${items.join("")}</channel></rss>`;
}

beforeEach(() => {
  mocks.routes.clear();
  mocks.redirects.clear();
  mocks.calls.length = 0;
});

describe("sniffFeedPrefix", () => {
  it("classifies by root element and reads the channel title from a truncated prefix", () => {
    const feed = bigFeed();
    const prefix = feed.slice(0, FEED_SNIFF_BYTES);
    expect(sniffFeedPrefix(prefix)).toEqual({ type: "rss", title: "Big Changelog", signature: "rss|Big Changelog|big-0" });
  });

  it("knows Atom, RDF and JSON Feed, and rejects HTML that merely mentions <rss", () => {
    expect(sniffFeedPrefix('<feed xmlns="http://www.w3.org/2005/Atom"><title type="text">A &amp; B</title><entry><id>e1</id></entry></feed>'))
      .toEqual({ type: "atom", title: "A & B", signature: "atom|A & B|e1" });
    expect(sniffFeedPrefix('<?xml version="1.0"?><rdf:RDF xmlns:rdf="x"><channel><title><![CDATA[R]]></title></channel></rdf:RDF>'))
      .toMatchObject({ type: "rss", title: "R" });
    expect(sniffFeedPrefix('{"version":"https://jsonfeed.org/version/1.1","title":"J","items":[{"id":"1"}]}'))
      .toEqual({ type: "json", title: "J", signature: "json|J|1" });
    expect(sniffFeedPrefix("<!doctype html><html><body><pre>&lt;rss&gt; <rss version=2.0></pre></body></html>")).toBeNull();
    expect(sniffFeedPrefix('{"not":"a feed"}')).toBeNull();
  });
});

describe("sniffFeedPrefix: non-standard RSS", () => {
  it("rejects an <rss> root without <channel> (`<rss><items>` API look-alike)", () => {
    expect(sniffFeedPrefix('<?xml version="1.0"?><rss version="2.0"><items><title>API</title><item><title>A</title></item></items></rss>')).toBeNull();
  });

  it("a cut-off prefix with <rss but no <channel> yet stays undecided (classified as RSS, not rejected)", () => {
    expect(sniffFeedPrefix(`<?xml version="1.0"?><rss version="2.0"><!-- ${"x".repeat(5000)}`)).toMatchObject({ type: "rss" });
  });
});

describe("section affinity", () => {
  it("extracts meaningful section segments", () => {
    expect(sectionSegments(new URL("https://www.faz.net/aktuell/politik/"))).toEqual(["aktuell", "politik"]);
    expect(sectionSegments(new URL("https://www.derstandard.at/inland"))).toEqual(["inland"]);
    expect(sectionSegments(new URL("https://www.example.com/"))).toEqual([]);
    expect(sectionSegments(new URL("https://www.example.com/index.html"))).toEqual([]);
  });

  it("scores the section's own feed above the site-wide one", () => {
    const segs = ["aktuell", "politik"];
    expect(sectionAffinity(segs, "https://www.faz.net/rss/aktuell/politik/")).toBe(1);
    expect(sectionAffinity(segs, "https://www.faz.net/rss/aktuell/")).toBeCloseTo(1 / 3);
    expect(sectionAffinity(["inland"], "https://www.derstandard.at/rss")).toBe(0);
    expect(sectionAffinity(["inland"], "https://feeds.example/123.xml", "Example · Inland")).toBe(1);
    expect(sectionAffinity([], "https://x.example/rss")).toBe(0);
  });

  it("gives no bonus to another site's feed and never matches on the hostname", () => {
    const site = "https://www.paper.example/inland";
    expect(sectionAffinity(["inland"], "https://rss.paper.example/inland.xml", "", site)).toBe(1); // same site, other subdomain
    expect(sectionAffinity(["inland"], "https://aggregator.example/inland.xml", "Inland", site)).toBe(0); // foreign site
    expect(sectionAffinity(["inland"], "https://feeds.paper.example/x.xml", "Paper · Inland", site)).toBe(1); // title, same site
    expect(sectionAffinity(["inland"], "https://inland.paper.example/all.xml", "Alle", site)).toBe(0); // hostname only
    expect(siteOf("news.bbc.co.uk")).toBe("bbc.co.uk");
    expect(siteOf("rss.nytimes.com")).toBe("nytimes.com");
    expect(isSameSite("https://feeds.npr.org/1/rss.xml", "https://www.npr.org/")).toBe(true);
    expect(isSameSite("https://evil.example/", "https://www.npr.org/")).toBe(false);
  });

  it("builds section-relative feed paths only for shallow section pages", () => {
    expect(sectionFeedPaths(new URL("https://news.example/inland"))).toEqual(["/inland/feed", "/inland/rss", "/rss/inland", "/feed/inland"]);
    expect(sectionFeedPaths(new URL("https://news.example/"))).toEqual([]);
    expect(sectionFeedPaths(new URL("https://news.example/a/b/c/d"))).toEqual([]);
    expect(sectionFeedPaths(new URL("https://news.example/a/b/c"))).toEqual([]);
    expect(sectionFeedPaths(new URL("https://news.example/inland/a-1234567"))).toEqual([]);
    expect(sectionFeedPaths(new URL("https://news.example/section/world"))).toHaveLength(4);
    expect(sectionFeedPaths(new URL("https://news.example/story.html"))).toEqual([]);
    expect(sectionFeedPaths(new URL("https://blog.example/2024/05/hello"))).toEqual([]);
    expect(sectionFeedPaths(new URL("https://blog.example/my-very-long-post-title/"))).toEqual([]);
  });
});

describe("lateLinkElements", () => {
  it("recovers <link> tags beyond the scanner cap with a bounded linear pass", () => {
    const html = `<html><head><script>${"x".repeat(600 * 1024)}</script><link rel="alternate" type="application/rss+xml" href="/late.xml"></head></html>`;
    expect(lateLinkElements(html).map((l) => l.attrs.href)).toEqual(["/late.xml"]);
    expect(lateLinkElements("<html><link rel=alternate></html>")).toEqual([]);
    // Unterminated `<link` spam stays linear and bounded.
    const t = Date.now();
    lateLinkElements(`<html>${"y".repeat(600 * 1024)}${"<link ".repeat(200_000)}`);
    lateLinkElements(`<html>${"y".repeat(600 * 1024)}${"<script>".repeat(100_000)}`);
    lateLinkElements(`<html>${"y".repeat(600 * 1024)}${"<!--".repeat(100_000)}`);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it("skips <link> look-alikes inside scripts/comments and keeps offsets right after case-changing characters", () => {
    // "İ" lower-cases to two UTF-16 units: a lower-cased copy would shift every later offset.
    const html =
      `<html><head><title>${"İ".repeat(1000)}</title><script>${"s".repeat(600 * 1024)} var x = '<link rel="alternate" type="application/rss+xml" href="/in-script.xml">';</script>` +
      `<!-- <link rel="alternate" type="application/rss+xml" href="/in-comment.xml"> -->` +
      `<LINK REL="alternate" TYPE="application/rss+xml" HREF="/real.xml"></head></html>`;
    expect(lateLinkElements(html).map((l) => l.attrs.href)).toEqual(["/real.xml"]);
  });
});

describe("discovery fixtures", () => {
  it("chromie-like: huge head, feeds only as footer anchors → main feed ranks first, variants after", async () => {
    mocks.routes.set("https://www.chronik.example/", fixture("chromie-like"));
    mocks.routes.set("https://www.chronik.example/feed.xml", rss("Spielwelt Chronik"));
    for (const z of ["retail", "classic_plus", "classic", "mop_classic", "bc_anniversary"]) {
      mocks.routes.set(`https://www.chronik.example/feed.xml?zeitlinie=${z}`, rss(`Spielwelt Chronik · ${z}`));
    }
    // Bare domain, as typed by the owner.
    const r = await discoverFeeds("www.chronik.example");
    expect(r.mode).toBe("url");
    expect(r.feeds[0]).toMatchObject({ url: "https://www.chronik.example/feed.xml", title: "Spielwelt Chronik", type: "rss", source: "html" });
    expect(r.feeds).toHaveLength(6);
    expect(r.feeds.slice(1).every((f) => f.url.includes("?zeitlinie="))).toBe(true);
    // The site told us where its feed is → no blind common-path probing.
    expect(mocks.calls.some((c) => c.url === "https://www.chronik.example/rss.xml")).toBe(false);
  });

  it("footer-anchor-only: an RSS icon link at a non-feed-looking path is found; the comments feed ranks below", async () => {
    mocks.routes.set("https://workshop.example/", fixture("footer-anchor-only"));
    mocks.routes.set("https://workshop.example/syndication/everything", rss("Quiet Workshop"));
    mocks.routes.set("https://workshop.example/comments/feed/", rss("Comments on Quiet Workshop"));
    const r = await discoverFeeds("https://workshop.example/");
    expect(r.feeds.map((f) => f.url)).toEqual(["https://workshop.example/syndication/everything", "https://workshop.example/comments/feed/"]);
    expect(r.feeds[0].title).toBe("Quiet Workshop");
  });

  it("a >1 MB feed is verified from a 64 KiB prefix (not dropped for its size)", async () => {
    const feed = bigFeed();
    expect(Buffer.byteLength(feed)).toBeGreaterThan(1024 * 1024);
    mocks.routes.set("https://big.example/changelog", '<html><head><link rel="alternate" type="application/rss+xml" href="/changelog/rss.xml"></head><body></body></html>');
    mocks.routes.set("https://big.example/changelog/rss.xml", feed);
    const r = await discoverFeeds("https://big.example/changelog");
    expect(r.feeds.map((f) => f.url)).toEqual(["https://big.example/changelog/rss.xml"]);
    const probe = mocks.calls.find((c) => c.url === "https://big.example/changelog/rss.xml");
    expect(probe?.options).toMatchObject({ readPrefix: true, maxBytes: FEED_SNIFF_BYTES });
  });

  it("publisher-table host with a real <link>: the page's own feed wins, the curated route is not offered", async () => {
    mocks.routes.set("https://www.tagesschau.de/", fixture("publisher-with-link"));
    mocks.routes.set("https://www.tagesschau.de/feeds/alle.rss", rss("Alle Meldungen (Seite)"));
    mocks.routes.set("https://www.tagesschau.de/infoservices/alle-meldungen-100~rss2.xml", rss("Curated"));
    const r = await discoverFeeds("https://www.tagesschau.de/");
    expect(r.feeds.map((f) => f.url)).toEqual(["https://www.tagesschau.de/feeds/alle.rss"]);
    expect(r.feeds[0].source).toBe("html");
  });

  it("publisher-table route is only the fallback when the page yields nothing", async () => {
    mocks.routes.set("https://www.tagesschau.de/", "<html><body>consent wall</body></html>");
    mocks.routes.set("https://www.tagesschau.de/infoservices/alle-meldungen-100~rss2.xml", rss("Curated"));
    const r = await discoverFeeds("https://www.tagesschau.de/");
    expect(r.feeds.map((f) => [f.url, f.source])).toEqual([["https://www.tagesschau.de/infoservices/alle-meldungen-100~rss2.xml", "curated"]]);
  });

  it("de-duplicates aliases of the same feed (/feed vs /feed/ vs /rss)", async () => {
    mocks.routes.set("https://dup.example/", "<html><body></body></html>");
    const same = rss("Dup", "https://dup.example/p/1");
    for (const p of ["/feed", "/feed/", "/rss"]) mocks.routes.set(`https://dup.example${p}`, same);
    const r = await discoverFeeds("https://dup.example/");
    expect(r.feeds).toHaveLength(1);
    expect(r.feeds[0].url).toBe("https://dup.example/feed");
  });

  const connectRefused = () => new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), { code: "ECONNREFUSED" }) });

  it.each([
    ["wrapped self-signed", () => new TypeError("fetch failed", { cause: Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }) })],
    ["wrapped expired", () => new TypeError("fetch failed", { cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }) })],
    ["unwrapped altname", () => Object.assign(new Error("Hostname/IP does not match certificate's altnames"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" })],
    ["http server on the https port", () => new TypeError("fetch failed", { cause: Object.assign(new Error("ssl3_get_record:wrong version number"), { code: "ERR_SSL_WRONG_VERSION_NUMBER" }) })],
    ["unknown error", () => new TypeError("fetch failed")],
  ])("%s: no http request is ever made (no MITM downgrade)", async (_label, makeError) => {
    const err = makeError();
    mocks.routes.set("https://tls.example/", err);
    for (const p of ["/feed", "/feed/", "/rss", "/rss/", "/rss.xml", "/atom.xml", "/feed.xml", "/index.xml", "/feed.json", "/?feed=rss2", "/api/feeds/posts"]) {
      mocks.routes.set(`https://tls.example${p}`, err);
    }
    mocks.routes.set("http://tls.example/", '<link rel="alternate" type="application/rss+xml" href="/rss.xml">');
    mocks.routes.set("http://tls.example/rss.xml", rss("Downgraded"));
    const r = await discoverFeeds("tls.example");
    expect(r.feeds).toEqual([]);
    expect(mocks.calls.some((c) => c.url.startsWith("http://"))).toBe(false);
    if (_label !== "unknown error") expect(r.hint).toBe("tls-error");
  });

  it("a scheme-less address retries over http only when https cannot connect", async () => {
    mocks.routes.set("https://plain.example/", connectRefused());
    mocks.routes.set("http://plain.example/", '<html><head><link rel="alternate" type="application/atom+xml" href="/atom.xml"></head></html>');
    mocks.routes.set("http://plain.example/atom.xml", '<feed xmlns="http://www.w3.org/2005/Atom"><title>Plain</title></feed>');
    const r = await discoverFeeds("plain.example");
    expect(r.feeds.map((f) => f.url)).toEqual(["http://plain.example/atom.xml"]);
    expect(r.pageUrl).toBe("http://plain.example/");

    // An explicit https:// is respected (no downgrade).
    mocks.calls.length = 0;
    const strict = await discoverFeeds("https://plain.example/");
    expect(strict.feeds).toEqual([]);
    expect(mocks.calls.some((c) => c.url.startsWith("http://"))).toBe(false);
  });

  it("an HTTP status error never triggers the http retry", async () => {
    mocks.routes.set("https://blocked.example/", new Error("Fetch failed: 403"));
    await discoverFeeds("blocked.example");
    expect(mocks.calls.some((c) => c.url === "http://blocked.example/")).toBe(false);
  });

  it("section page: a site-wide common-path hit does not suppress the section feed; the section feed ranks first", async () => {
    mocks.routes.set("https://news.example/inland", "<html><body>Inland</body></html>");
    mocks.routes.set("https://news.example/rss", rss("News · Alle Meldungen"));
    mocks.routes.set("https://news.example/rss/inland", rss("Inland - News"));
    const r = await discoverFeeds("https://news.example/inland");
    expect(r.feeds.map((f) => f.url)).toEqual(["https://news.example/rss/inland", "https://news.example/rss"]);
  });

  it("section page advertising site-wide AND section feeds: the section feed ranks first", async () => {
    mocks.routes.set(
      "https://paper.example/aktuell/politik/",
      '<html><head><link rel="alternate" type="application/rss+xml" title="Paper - Aktuell" href="/rss/aktuell/"><link rel="alternate" type="application/rss+xml" title="Paper - Politik" href="/rss/aktuell/politik/"></head></html>',
    );
    mocks.routes.set("https://paper.example/rss/aktuell/", rss("Paper - Aktuell"));
    mocks.routes.set("https://paper.example/rss/aktuell/politik/", rss("Paper - Politik"));
    const r = await discoverFeeds("https://paper.example/aktuell/politik/");
    expect(r.feeds.map((f) => f.url)).toEqual(["https://paper.example/rss/aktuell/politik/", "https://paper.example/rss/aktuell/"]);
  });

  it("section page of a publisher-table host with only a site-wide feed: the curated section route is offered first", async () => {
    mocks.routes.set(
      "https://www.nytimes.com/section/world",
      '<html><head><link rel="alternate" type="application/rss+xml" href="https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml"></head></html>',
    );
    mocks.routes.set("https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", rss("NYT > Top Stories"));
    mocks.routes.set("https://rss.nytimes.com/services/xml/rss/nyt/World.xml", rss("NYT > World News"));
    const r = await discoverFeeds("https://www.nytimes.com/section/world");
    expect(r.feeds.map((f) => [f.url, f.source])).toEqual([
      ["https://rss.nytimes.com/services/xml/rss/nyt/World.xml", "curated"],
      ["https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", "html"],
    ]);
  });

  it("follows a feed INDEX page (HTML listing feeds at /rss) one level, ranked by section affinity", async () => {
    mocks.routes.set("https://idx.example/inland", "<html><body>Inland</body></html>");
    mocks.routes.set(
      "https://idx.example/rss",
      '<!doctype html><html><head><title>RSS-Feeds</title></head><body><ul><li><a href="/feeds/alle.xml">Alle Meldungen</a></li><li><a href="/feeds/inland.xml">Inland</a></li><li><a href="/impressum">Impressum</a></li></ul></body></html>',
    );
    mocks.routes.set("https://idx.example/feeds/alle.xml", rss("Alle"));
    mocks.routes.set("https://idx.example/feeds/inland.xml", rss("Inland"));
    const r = await discoverFeeds("https://idx.example/inland");
    expect(r.feeds.map((f) => f.url)).toEqual(["https://idx.example/feeds/inland.xml", "https://idx.example/feeds/alle.xml"]);
    // The index page is read with the larger index budget; non-feed links are never probed.
    expect(mocks.calls.find((c) => c.url === "https://idx.example/rss")?.options).toMatchObject({ readPrefix: true, maxBytes: FEED_INDEX_BYTES });
    expect(mocks.calls.some((c) => c.url === "https://idx.example/impressum")).toBe(false);
  });

  it("blocked homepage on a bare domain: curated route still found, page reported as blocked, blind probes bounded", async () => {
    mocks.routes.set("https://nytimes.com/", new Error("Fetch failed: 403"));
    mocks.routes.set("https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", rss("NYT > Top Stories"));
    const r = await discoverFeeds("nytimes.com");
    expect(r.feeds.map((f) => [f.url, f.source])).toEqual([["https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", "curated"]]);
    expect(r.pageBlocked).toBe(true);
    expect(r.hint).toBeUndefined();
    expect(r.partial).toBeUndefined();
    const probes = new Set(mocks.calls.filter((c) => c.url.startsWith("https://nytimes.com/") && c.url !== "https://nytimes.com/").map((c) => c.url));
    expect(probes.size).toBeLessThanOrEqual(5);
  });

  it("YouTube @handle (legacy 2-char) on a >4 MiB page: channel id read from a bounded prefix", async () => {
    const page = `<html><head><script>${"v".repeat(2 * 1024 * 1024)}</script><meta property="og:url" content="https://www.youtube.com/channel/UCTxDDUZ5RB5K8kme9DdbOqQ"></head><body>${"z".repeat(3 * 1024 * 1024)}</body></html>`;
    expect(Buffer.byteLength(page)).toBeGreaterThan(RESOLVER_PAGE_BYTES);
    mocks.routes.set("https://www.youtube.com/@EA", page);
    const r = await discoverFeeds("https://www.youtube.com/@EA");
    expect(r.feeds[0]).toMatchObject({ url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCTxDDUZ5RB5K8kme9DdbOqQ", source: "resolver" });
    expect(mocks.calls.find((c) => c.url === "https://www.youtube.com/@EA")?.options).toMatchObject({ readPrefix: true, maxBytes: RESOLVER_PAGE_BYTES });
  });

  it("a non-standard <rss><items> endpoint is never offered as a feed", async () => {
    mocks.routes.set("https://api.example/", '<html><head><link rel="alternate" type="application/rss+xml" href="/Rss/New"></head></html>');
    mocks.routes.set("https://api.example/Rss/New", '<?xml version="1.0"?><rss version="2.0"><items><title>API</title><item><title>A</title><link>https://api.example/a</link></item></items></rss>');
    const r = await discoverFeeds("https://api.example/");
    expect(r.feeds.map((f) => f.url)).not.toContain("https://api.example/Rss/New");
  });

  it("article address: the post's own comments feed does not outrank the site feed", async () => {
    mocks.routes.set(
      "https://wp.example/my-very-long-post-title/",
      '<html><head><link rel="alternate" type="application/rss+xml" title="WP Blog » Feed" href="/feed/"><link rel="alternate" type="application/rss+xml" title="WP Blog » My very long post title Comments Feed" href="/my-very-long-post-title/feed/"></head></html>',
    );
    mocks.routes.set("https://wp.example/feed/", rss("WP Blog"));
    mocks.routes.set("https://wp.example/my-very-long-post-title/feed/", rss("Comments on: My very long post title"));
    const r = await discoverFeeds("https://wp.example/my-very-long-post-title/");
    expect(r.feeds[0].url).toBe("https://wp.example/feed/");
  });

  it("does not follow a feed index page on ANOTHER site; follows a same-site one and resolves its links against its final URL", async () => {
    // /feeds/ on the page's site redirects to another site's listing → not followed.
    mocks.routes.set("https://xsite.example/", '<html><body><a href="/feeds/">Feeds</a></body></html>');
    mocks.redirects.set("https://xsite.example/feeds/", "https://other.example/listing/feeds");
    mocks.routes.set("https://other.example/listing/feeds", '<!doctype html><html><body><a href="https://other.example/listing/evil.xml">Alle Feeds</a></body></html>');
    mocks.routes.set("https://other.example/listing/evil.xml", rss("Foreign"));
    const foreign = await discoverFeeds("https://xsite.example/");
    expect(foreign.feeds.map((f) => f.url)).not.toContain("https://other.example/listing/evil.xml");
    expect(mocks.calls.some((c) => c.url === "https://other.example/listing/evil.xml")).toBe(false);

    // Same site, redirected into a subdirectory: relative links resolve against the FINAL URL.
    mocks.calls.length = 0;
    mocks.routes.set("https://same.example/", '<html><body><a href="/rss">RSS</a></body></html>');
    mocks.redirects.set("https://same.example/rss", "https://www.same.example/service/rss/");
    mocks.routes.set("https://www.same.example/service/rss/", '<!doctype html><html><body><a href="alle.xml">Alle Meldungen</a></body></html>');
    mocks.routes.set("https://www.same.example/service/rss/alle.xml", rss("Same · Alle"));
    const same = await discoverFeeds("https://same.example/");
    expect(same.feeds.map((f) => f.url)).toEqual(["https://www.same.example/service/rss/alle.xml"]);
  });

  it("section bonus only for same-site feeds: a foreign feed repeating the section word does not outrank the site's feed", async () => {
    mocks.routes.set(
      "https://site.example/inland",
      '<html><head><link rel="alternate" type="application/rss+xml" title="Site" href="/feed.xml"><link rel="alternate" type="application/rss+xml" title="Aggregator Inland" href="https://aggregator.example/inland.xml"></head></html>',
    );
    mocks.routes.set("https://site.example/feed.xml", rss("Site"));
    mocks.routes.set("https://aggregator.example/inland.xml", rss("Aggregator Inland"));
    const r = await discoverFeeds("https://site.example/inland");
    expect(r.feeds.map((f) => f.url)).toEqual(["https://site.example/feed.xml", "https://aggregator.example/inland.xml"]);
  });
});
