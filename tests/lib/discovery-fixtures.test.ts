import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Discovery against the synthetic page fixtures in tests/fixtures/web (no
 * network). The mocked transport honours the caller's byte budget exactly
 * like the real one: `readPrefix` returns the first `maxBytes`, otherwise a
 * larger body fails with "Response too large".
 */

const mocks = vi.hoisted(() => ({ routes: new Map<string, string | Error>(), calls: [] as Array<{ url: string; options: any }> }));

function respond(url: string, options: any = {}) {
  mocks.calls.push({ url, options });
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

import { discoverFeeds, FEED_SNIFF_BYTES, sniffFeedPrefix } from "../../lib/feed-discovery";

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

  it("a scheme-less address retries over http only when https cannot connect", async () => {
    mocks.routes.set("https://plain.example/", new TypeError("fetch failed"));
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
});
