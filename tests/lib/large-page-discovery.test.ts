import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHttpLinkHeader } from "../../lib/http-link-header";
import { decodeHtmlBytes, findHtmlHeadEnd, readHtmlPrefix } from "../../lib/html-prefix";
import { discoverFeeds, headAdvertisesFeed } from "../../lib/feed-discovery";

// ─── RFC 8288 Link header ──────────────────────────────────────────────────

describe("parseHttpLinkHeader (RFC 8288)", () => {
  it("parses single and multiple link-values", () => {
    expect(parseHttpLinkHeader('<https://example.com/feed.xml>; rel="alternate"; type="application/rss+xml"; title="News Feed"')).toEqual([
      { url: "https://example.com/feed.xml", rels: ["alternate"], type: "application/rss+xml", title: "News Feed" },
    ]);
    expect(parseHttpLinkHeader('<https://example.com/atom.xml>; rel=alternate; type=application/atom+xml, <https://example.com/about>; rel="about"')).toEqual([
      { url: "https://example.com/atom.xml", rels: ["alternate"], type: "application/atom+xml" },
      { url: "https://example.com/about", rels: ["about"] },
    ]);
  });

  it("does not split on commas inside <…> or quoted strings; honours escapes and ;", () => {
    const header = '<https://example.com/a,b/feed?x=1,2>; rel="alternate"; type="application/rss+xml"; title="News, \\"Daily\\"; EU", </other>; rel=next';
    expect(parseHttpLinkHeader(header)).toEqual([
      { url: "https://example.com/a,b/feed?x=1,2", rels: ["alternate"], type: "application/rss+xml", title: 'News, "Daily"; EU' },
      { url: "/other", rels: ["next"] },
    ]);
  });

  it("splits rel into exact tokens and keeps only the first occurrence of a param", () => {
    const [entry] = parseHttpLinkHeader('</f>; rel="Alternate  home"; rel="nope"; type="Application/RSS+XML; charset=utf-8"');
    expect(entry.rels).toEqual(["alternate", "home"]);
    expect(entry.type).toBe("application/rss+xml");
    expect(parseHttpLinkHeader('</f>; rel="alternates"')[0].rels).toEqual(["alternates"]);
  });

  it("decodes title* (RFC 8187) and skips malformed values", () => {
    expect(parseHttpLinkHeader("</f>; rel=alternate; title*=UTF-8''Nachrichten%20%E2%82%AC")[0].title).toBe("Nachrichten €");
    expect(parseHttpLinkHeader('garbage, </ok>; rel=alternate')).toEqual([{ url: "/ok", rels: ["alternate"] }]);
    expect(parseHttpLinkHeader(null)).toEqual([]);
    expect(parseHttpLinkHeader("   ")).toEqual([]);
  });
});

// ─── HTML prefix reader ────────────────────────────────────────────────────

function streamOf(chunks: Uint8Array[], onPull?: () => void) {
  let n = 0;
  return {
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        onPull?.();
        if (n < chunks.length) controller.enqueue(chunks[n++]);
        else controller.close();
      },
    }),
    text: async () => {
      throw new Error("must stream");
    },
  };
}
const enc = (s: string) => new TextEncoder().encode(s);

describe("findHtmlHeadEnd", () => {
  it("ignores </head> inside script, style, title and comments", () => {
    const html = `<html><head><script>var s = "</head><body>";</script><style>/* </head> */</style><title>a </head> b</title><!-- </head> --><link rel="alternate" href="/f"></head><body>`;
    expect(html.slice(0, findHtmlHeadEnd(html))).toMatch(/<link rel="alternate" href="\/f"><\/head>$/);
  });

  it("treats <script/> as opening raw text (not self-closing) — reviewer repro", () => {
    const html = `<html><head><script/>var t = '<link rel="alternate" type="application/rss+xml" href="/fake.xml"></head><body>';</script><link rel="alternate" type="application/rss+xml" href="/real.xml"></head><body>`;
    expect(html.slice(0, findHtmlHeadEnd(html))).toMatch(/href="\/real\.xml"><\/head>$/);
  });

  it("honours script escaped / double-escaped states", () => {
    // Inside <!-- … --> a nested <script> double-escapes: its </script> does not end the outer script.
    const html = `<head><script><!--<script>document.write('</script></head><body>')</script>--></script><link rel="alternate" type="application/atom+xml" href="/real.atom"></head>`;
    expect(html.slice(0, findHtmlHeadEnd(html))).toMatch(/href="\/real\.atom"><\/head>$/);
    // Escaped (no nested <script>): </script> does end it.
    const escaped = `<head><script><!-- x </script><link rel="alternate" href="/a"></head>`;
    expect(escaped.slice(0, findHtmlHeadEnd(escaped))).toBe(escaped);
    // Self-closing <style/> too.
    const style = `<head><style/>a::after{content:"</head><body>"}</style><title>x</title></head>`;
    expect(style.slice(0, findHtmlHeadEnd(style))).toBe(style);
  });

  it("stops at the first <body> when </head> is omitted", () => {
    const html = `<html><head><link rel="alternate" href="/f"><BODY class="x"><p>hi`;
    expect(html.slice(0, findHtmlHeadEnd(html))).toBe(`<html><head><link rel="alternate" href="/f">`);
  });

  it("does not treat <bodyx> or attribute text as body", () => {
    expect(findHtmlHeadEnd(`<head><meta content="<body>"><bodyx>`)).toBe(-1);
  });
});

describe("readHtmlPrefix", () => {
  it("never returns more than maxBytes, even from a single oversized chunk", async () => {
    const big = enc(`<html><head><title>x</title>${"a".repeat(4096)}`);
    const out = await readHtmlPrefix(streamOf([big]), { maxBytes: 1000, stopAtHead: true });
    expect(new TextEncoder().encode(out).byteLength).toBeLessThanOrEqual(1000);
  });

  it("stops reading at the head end on a 3 MB stream", async () => {
    let pulls = 0;
    const chunks = [enc('<!doctype html><html><head><title>Large</title><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head>'), ...Array.from({ length: 100 }, () => enc("A".repeat(32 * 1024)))];
    const out = await readHtmlPrefix(streamOf(chunks, () => pulls++), { maxBytes: 512 * 1024, stopAtHead: true });
    expect(out.endsWith("</head>")).toBe(true);
    expect(pulls).toBeLessThan(5);
  });

  it("detects the head end across chunk boundaries", async () => {
    const html = '<html><head><scr' + 'ipt>x="</he' + 'ad>"</scr' + 'ipt><!' + '-- c --></he' + 'ad><body>BODY';
    const chunks = Array.from({ length: Math.ceil(html.length / 3) }, (_, i) => enc(html.slice(i * 3, i * 3 + 3)));
    expect(await readHtmlPrefix(streamOf(chunks), { stopAtHead: true })).toBe('<html><head><script>x="</head>"</script><!-- c --></head>');
  });

  it("feed-like markup inside script never triggers the early stop (reviewer repro, byte by byte)", async () => {
    const html = `<html><head><script/>var t = '<link rel="alternate" type="application/rss+xml" href="/fake.xml"></head>';</script>`
      + `<script><!--<script>x('</script></head>')</script>--></script>`
      + `<link rel="alternate" type="application/rss+xml" href="/real.xml"></head><body><p>${"x".repeat(5000)}</p>`;
    const out = await readHtmlPrefix(streamOf(Array.from(enc(html), (b) => new Uint8Array([b]))), { stopAtHead: headAdvertisesFeed });
    expect(out).toContain('href="/real.xml"');
    expect(out.endsWith('href="/real.xml"></head>')).toBe(true);
  });

  it("headAdvertisesFeed only counts real <link> elements", () => {
    expect(headAdvertisesFeed(`<head><script>'<link rel="alternate" type="application/rss+xml" href="/f">'</script></head>`)).toBe(false);
    expect(headAdvertisesFeed(`<head><!-- <link rel="alternate" type="application/rss+xml" href="/f"> --></head>`)).toBe(false);
    expect(headAdvertisesFeed(`<head><link rel="Alternate" type="application/rss+xml" href="/f"></head>`)).toBe(true);
    expect(headAdvertisesFeed(`<head><link rel="alternate" type="text/html" href="/f"></head>`)).toBe(false);
  });

  it("keeps reading the body (up to the budget) when the predicate rejects the head", async () => {
    const out = await readHtmlPrefix(streamOf([enc("<html><head><title>t</title></head><body><a href='/rss.xml'>RSS</a></body></html>")]), {
      stopAtHead: () => false,
    });
    expect(out).toContain("<a href='/rss.xml'>");
  });

  it("decodes UTF-8 sequences split across chunks", async () => {
    const bytes = enc("<head><title>Grüße 😀</title></head>");
    const chunks = Array.from(bytes, (b) => new Uint8Array([b]));
    expect(await readHtmlPrefix(streamOf(chunks), { stopAtHead: true })).toBe("<head><title>Grüße 😀</title></head>");
  });

  it("honours the charset from Content-Type, <meta charset> and http-equiv", async () => {
    const latin1 = Buffer.from("<head><title>Grüße</title></head>", "latin1");
    expect(await readHtmlPrefix(streamOf([latin1]), { contentType: "text/html; charset=ISO-8859-1" })).toContain("Grüße");
    const meta = Buffer.concat([Buffer.from('<head><meta charset="windows-1252"><title>', "latin1"), Buffer.from([0x80, 0xfc]), Buffer.from("</title></head>", "latin1")]);
    expect(await readHtmlPrefix(streamOf([meta]))).toContain("€ü");
    const equiv = Buffer.concat([Buffer.from('<head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-15"><title>', "latin1"), Buffer.from([0xa4]), Buffer.from("</title></head>", "latin1")]);
    expect(await readHtmlPrefix(streamOf([equiv]))).toContain("<title>€</title>");
    expect(decodeHtmlBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...enc("ok")]), "text/html; charset=latin1")).toBe("ok");
  });
});

// ─── discoverFeeds wiring (final URL, Link header, size) ───────────────────

const mocks = vi.hoisted(() => ({
  fetchWith: vi.fn(),
  fetchText: vi.fn(),
}));

vi.mock("../../lib/ssrf", async () => {
  const actual = await vi.importActual<typeof import("../../lib/ssrf")>("../../lib/ssrf");
  return {
    ...actual,
    fetchWithSsrfProtection: mocks.fetchWith,
    fetchTextWithSsrfProtection: mocks.fetchText,
    isTrustedFeedFetchingAllowed: vi.fn().mockResolvedValue(false),
  };
});


const RSS = '<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title></channel></rss>';

function page(opts: { url: string; link?: string; html?: string }) {
  const headers = new Headers();
  if (opts.link) headers.set("link", opts.link);
  return { notModified: false, text: opts.html ?? "<html><head><title>x</title></head><body></body></html>", etag: null, lastModified: null, headers, url: opts.url };
}

describe("discoverFeeds: HTTP Link header + final URL", () => {
  afterEach(() => {
    mocks.fetchWith.mockReset();
    mocks.fetchText.mockReset();
  });

  it("resolves a relative Link target against the final URL after redirects", async () => {
    mocks.fetchWith.mockResolvedValueOnce(page({ url: "https://www.final.example/blog/", link: '<feed.xml>; rel="alternate"; type="application/rss+xml"' }));
    mocks.fetchText.mockImplementation(async (url: string) => {
      if (url === "https://www.final.example/blog/feed.xml") return RSS;
      throw new Error("Fetch failed: 404");
    });
    const res = await discoverFeeds("https://start.example/");
    expect(res.feeds.map((f) => f.url)).toContain("https://www.final.example/blog/feed.xml");
    expect(mocks.fetchText.mock.calls.map(([u]) => u)).not.toContain("https://start.example/feed.xml");
  });

  it("requires the exact alternate token and a feed media type (no URL-suffix bypass)", async () => {
    mocks.fetchWith.mockResolvedValueOnce(page({
      url: "https://links.example/",
      link: [
        '</no-type/rss.xml>; rel="alternate"',
        '</wrong-rel/rss.xml>; rel="alternates"; type="application/rss+xml"',
        '</html-type/feed.xml>; rel="alternate"; type="text/html"',
        '</json-nohint/data.json>; rel="alternate"; type="application/json"',
        '</ok/atom>; rel="home alternate"; type="application/atom+xml"',
        '</ok/feed.json>; rel=alternate; type="application/json"',
      ].join(", "),
    }));
    mocks.fetchText.mockImplementation(async () => {
      throw new Error("Fetch failed: 404");
    });
    await discoverFeeds("https://links.example/");
    const probed = mocks.fetchText.mock.calls.map(([u]) => u as string);
    expect(probed).toContain("https://links.example/ok/atom");
    expect(probed).toContain("https://links.example/ok/feed.json");
    for (const bad of ["/no-type/rss.xml", "/wrong-rel/rss.xml", "/html-type/feed.xml", "/json-nohint/data.json"]) {
      expect(probed).not.toContain(`https://links.example${bad}`);
    }
  });

  it("asks for a bounded HTML prefix (never fails on page size)", async () => {
    mocks.fetchWith.mockResolvedValueOnce(page({ url: "https://big.example/" }));
    mocks.fetchText.mockRejectedValue(new Error("Fetch failed: 404"));
    await discoverFeeds("https://big.example/");
    const options = mocks.fetchWith.mock.calls[0][2];
    expect(options.maxBytes).toBe(1024 * 1024);
    expect(options.untilHead).toBe(headAdvertisesFeed);
  });
});
