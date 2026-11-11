import { describe, expect, it } from "vitest";
import { compileSelector, HTML_SCAN_MAX_CHARS, scanHtml, SCRIPT_TEXT_CAP } from "../../lib/html-scan";
import { trimTrailing } from "../../lib/url-input";

/**
 * lib/html-scan.ts replaces JSDOM in the discovery path: what it collects,
 * and that it stays linear (no tree, no recursion, capped input) on hostile
 * markup — every case < 200 ms and never throws.
 */

const timed = (fn: () => unknown) => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};
const MiB = 1024 * 1024;
const fill = (unit: string, bytes = MiB) => unit.repeat(Math.ceil(bytes / unit.length));

describe("scanHtml collects what discovery needs", () => {
  const page = `<!doctype html><html><head>
    <base href="/blog/">
    <meta name="Generator" content="WordPress 6.6">
    <link rel="Alternate stylesheet" type="application/rss+xml" title="Posts" href="/feed/">
    <!-- <link rel="alternate" type="application/rss+xml" href="/commented-out"> -->
    <script>var s = '<a href="/in-script.rss">RSS</a>';</script>
    <script src="/app.js"></script>
  </head><body class="home ipsApp">
    <main><a href="/post/1">Post <b>one</b></a></main>
    <footer><a href="/rss.xml" title="RSS"><img src="/i.png" alt="feed icon"><svg><title>Subscribe</title></svg></a></footer>
    <div role="banner"><a href="/atom">Atom</a></div>
    <a href="/after">After &amp; more</a>
  </body></html>`;
  const scan = scanHtml(page, { selectors: ["body.ipsApp", 'link[rel~="stylesheet"]', "[data-missing]"] });

  it("base, generator, links (comments ignored)", () => {
    expect(scan.baseHref).toBe("/blog/");
    expect(scan.generators).toEqual(["WordPress 6.6"]);
    expect(scan.links.map((l) => l.attrs.href)).toEqual(["/feed/"]);
  });

  it("anchors with text, entity decoding, icon alts and site-chrome position; script content is not markup", () => {
    expect(scan.anchors).toEqual([
      { href: "/post/1", title: "", ariaLabel: "", className: "", text: "Post one", imgAlts: [], inChrome: false },
      { href: "/rss.xml", title: "RSS", ariaLabel: "", className: "", text: "Subscribe", imgAlts: ["feed icon"], inChrome: true },
      { href: "/atom", title: "", ariaLabel: "", className: "", text: "Atom", imgAlts: [], inChrome: true },
      { href: "/after", title: "", ariaLabel: "", className: "", text: "After & more", imgAlts: [], inChrome: false },
    ]);
    expect(scan.scriptText).toContain("/in-script.rss");
  });

  it("selector hits: first matching element only, unmatched selectors absent", () => {
    expect(scan.selectorHits.get("body.ipsApp")?.tag).toBe("body");
    expect(scan.selectorHits.get('link[rel~="stylesheet"]')?.attrs.title).toBe("Posts");
    expect(scan.selectorHits.has("[data-missing]")).toBe(false);
  });

  it("compileSelector supports the registry subset only", () => {
    expect(compileSelector('a.x.y#i[href*="v"][data-z]')).toEqual({
      tag: "a",
      id: "i",
      classes: ["x", "y"],
      attrs: [
        { name: "href", op: "*=", value: "v" },
        { name: "data-z", op: "exists", value: "" },
      ],
    });
    expect(() => compileSelector("a b")).toThrow();
    expect(() => compileSelector("a:hover")).toThrow();
  });

  it("caps input, script text and attribute values", () => {
    const big = scanHtml(`<script>${"x".repeat(200_000)}</script>${fill("<p>", HTML_SCAN_MAX_CHARS + 10)}`);
    expect(big.truncated).toBe(true);
    expect(big.scriptText.length).toBeLessThanOrEqual(SCRIPT_TEXT_CAP);
    // Labels may be capped; addresses are dropped instead (see below).
    const attr = scanHtml(`<link rel="alternate" title="${"t".repeat(100_000)}" href="/f">`);
    expect(attr.links[0].attrs.title.length).toBe(2048);
    expect(attr.links[0].attrs.href).toBe("/f");
  });
});

describe("addresses: never a truncated prefix, first <base> with an href decides", () => {
  const long = (n: number) => `/feed.xml?${"a".repeat(n)}`;

  it("an oversized href / src is dropped, not truncated (anchor not collected, link has no href)", () => {
    const scan = scanHtml(
      `<link rel="alternate" type="application/rss+xml" href="${long(3000)}"><a href="${long(3000)}">RSS</a><script src="${long(3000)}"></script><a href="/ok.xml">RSS</a>`,
      { selectors: ["script[src]"] },
    );
    expect(scan.links[0].attrs.href).toBeUndefined();
    expect(scan.anchors.map((a) => a.href)).toEqual(["/ok.xml"]);
    expect(scan.selectorHits.has("script[src]")).toBe(false);
  });

  it("an oversized value spread over entities is dropped too", () => {
    const scan = scanHtml(`<a href="/x?${"&amp;".repeat(3000)}">RSS</a>`);
    expect(scan.anchors).toEqual([]);
  });

  it("a dropped attribute still claims its name: a later duplicate does not win", () => {
    const scan = scanHtml(`<a href="${long(3000)}" href="/feed.xml">RSS</a>`);
    expect(scan.anchors).toEqual([]);
  });

  it("first <base> with an href attribute wins, even when empty", () => {
    expect(scanHtml(`<base href=""><base href="https://evil.example/">`).baseHref).toBe("");
    expect(scanHtml(`<base target="_blank"><base href="/b/"><base href="/c/">`).baseHref).toBe("/b/");
    expect(scanHtml(`<p>no base</p>`).baseHref).toBeNull();
  });

  it("an oversized first <base> is unusable (document URL), and still blocks later ones", () => {
    expect(scanHtml(`<base href="https://evil.example/${"a".repeat(3000)}"><base href="https://evil2.example/">`).baseHref).toBe("");
  });
});

describe("scanHtml on hostile markup (< 200 ms, no throw)", () => {
  it.each([
    ["1 MiB of <div>", fill("<div>")],
    ["1 MiB of quoted-attribute elements", fill('<a href="x" title="y" class="z">')],
    ["deep nesting (1 MiB of mixed open tags)", fill("<div><span><b><i><section>")],
    ["deep nesting then unmatched close tags", `${"<div>".repeat(100_000)}${"</x>".repeat(100_000)}`],
    ["1 MiB of unterminated <meta", fill("<meta ")],
    ["unterminated attribute value", `<a href="${"x".repeat(MiB)}`],
    ["1 MiB of entities", fill("&amp;&#x41;&nbsp;")],
    ["tens of thousands of attributes on one tag", `<div ${Array.from({ length: 60_000 }, (_, i) => `a${i}=1`).join(" ")}>`],
    ["1 MiB of nested anchors in chrome", fill("<footer><a href='/rss'>RSS")],
  ])("%s", (_label, html) => {
    let threw: unknown = null;
    const ms = timed(() => {
      try {
        scanHtml(html, { selectors: ["body.ipsApp", "[data-xf-init]", 'a[href*="viewforum.php?f="]'] });
      } catch (err) {
        threw = err;
      }
    });
    expect(threw).toBeNull();
    expect(ms).toBeLessThan(200);
  });
});

describe("trimTrailing (replaces /x+$/ on untrusted strings)", () => {
  it("trims a trailing run only", () => {
    expect(trimTrailing("/feed///", "/")).toBe("/feed");
    expect(trimTrailing("/", "/")).toBe("");
    expect(trimTrailing("a/b", "/")).toBe("a/b");
    expect(trimTrailing("moddb.com..", ".")).toBe("moddb.com");
  });

  it.each([
    ["slash run then a char", `${"/".repeat(MiB)}x`],
    ["char then slash run", `x${"/".repeat(MiB)}`],
  ])("%s: linear", (_label, s) => {
    expect(timed(() => trimTrailing(s, "/"))).toBeLessThan(50);
  });
});
