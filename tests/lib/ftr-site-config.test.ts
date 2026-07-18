import { describe, it, expect } from "vitest";
import {
  parseFtrConfig,
  applyFtrConfig,
  findFtrConfigForUrl,
} from "../../lib/ftr-site-config";
import { extractReadableContent } from "../../lib/readability-extract";

// ── parseFtrConfig ───────────────────────────────────────────────────────────

describe("parseFtrConfig", () => {
  const SAMPLE = `
# a comment
title: //h1[@class="headline"]
body: //article[contains(@class, 'main')]
body: //div[@id='content']
author: //meta[@name="author"]/@content
date: //time/@datetime
strip: //aside
strip: //nav
strip_id_or_class: comments
## another comment
replace_string(<noscript>): <div>
http_header(User-Agent): Mozilla/5.0
test_url: https://example.com/a
requires_login: yes
`;

  it("collects supported directives, preserving order and repeats", () => {
    const c = parseFtrConfig(SAMPLE);
    expect(c.title).toEqual(['//h1[@class="headline"]']);
    expect(c.body).toEqual([
      "//article[contains(@class, 'main')]",
      "//div[@id='content']",
    ]);
    expect(c.author).toEqual(['//meta[@name="author"]/@content']);
    expect(c.date).toEqual(["//time/@datetime"]);
    expect(c.strip).toEqual(["//aside", "//nav"]);
    expect(c.stripIdOrClass).toEqual(["comments"]);
  });

  it("ignores comments and unsupported directives", () => {
    const c = parseFtrConfig(SAMPLE);
    // replace_string / http_header / test_url / requires_login must not appear
    // anywhere in the parsed config.
    const all = JSON.stringify(c);
    expect(all).not.toContain("noscript");
    expect(all).not.toContain("Mozilla");
    expect(all).not.toContain("requires_login");
    expect(all).not.toContain("test_url");
  });

  it("returns an all-empty config for junk input without throwing", () => {
    const c = parseFtrConfig("no directives here\njust prose");
    expect(c.body).toEqual([]);
    expect(c.strip).toEqual([]);
  });
});

// ── applyFtrConfig ───────────────────────────────────────────────────────────

const ARTICLE_HTML = `
<!doctype html><html><head>
  <meta name="author" content="Jane Reporter">
  <title>Site Title</title>
</head><body>
  <nav><a href="/">Home</a> menu links that should be stripped</nav>
  <article class="main-content">
    <h1 class="headline">The Headline That We Want</h1>
    <time datetime="2026-07-18T10:00:00Z">July 18</time>
    <aside class="promo">Subscribe now for amazing deals, this is boilerplate junk!</aside>
    <p>This is the first real paragraph of the article body and it carries enough
    genuine prose to comfortably clear the minimum body-length threshold used by
    the applier so the extraction is accepted as valid content.</p>
    <p>A second paragraph continues the story with more meaningful text so the
    extracted body is unmistakably the article and not stray chrome.</p>
    <div class="comments">Reader comment that should be stripped by id_or_class.</div>
  </article>
  <footer>Copyright junk footer</footer>
</body></html>`;

const CONFIG = parseFtrConfig(`
title: //h1[@class="headline"]
body: //article[contains(@class, 'main-content')]
author: //meta[@name="author"]/@content
date: //time/@datetime
strip: //aside
strip: //nav
strip_id_or_class: comments
`);

describe("applyFtrConfig", () => {
  it("extracts the body subtree named by the body XPath", () => {
    const result = applyFtrConfig(ARTICLE_HTML, "https://example.com/a", CONFIG);
    expect(result).not.toBeNull();
    expect(result!.content).toContain("first real paragraph");
    expect(result!.content).toContain("second paragraph");
  });

  it("strips chrome matched by strip and strip_id_or_class", () => {
    const result = applyFtrConfig(ARTICLE_HTML, "https://example.com/a", CONFIG);
    expect(result!.content).not.toContain("amazing deals");
    expect(result!.content).not.toContain("Reader comment");
    // nav lives outside the body subtree, so it can't leak in regardless.
    expect(result!.content).not.toContain("menu links");
  });

  it("pulls title, author and date from their XPath rules (incl. attribute nodes)", () => {
    const result = applyFtrConfig(ARTICLE_HTML, "https://example.com/a", CONFIG);
    expect(result!.title).toBe("The Headline That We Want");
    expect(result!.author).toBe("Jane Reporter");
    expect(result!.date).toBe("2026-07-18T10:00:00Z");
  });

  it("returns null when the config has no body directive", () => {
    const noBody = parseFtrConfig("title: //h1\nstrip: //nav");
    expect(applyFtrConfig(ARTICLE_HTML, "https://example.com/a", noBody)).toBeNull();
  });

  it("returns null when the matched body is thinner than the threshold", () => {
    const thinHtml = `<html><body><article class="main-content"><p>tiny</p></article></body></html>`;
    expect(applyFtrConfig(thinHtml, "https://example.com/a", CONFIG, 200)).toBeNull();
  });

  it("falls through body candidates until one yields real content", () => {
    const multi = parseFtrConfig(`
body: //div[@id='does-not-exist']
body: //article[contains(@class, 'main-content')]
`);
    const result = applyFtrConfig(ARTICLE_HTML, "https://example.com/a", multi);
    expect(result).not.toBeNull();
    expect(result!.content).toContain("first real paragraph");
  });

  it("does not throw on an XPath jsdom cannot evaluate", () => {
    const bad = parseFtrConfig(`body: //article[bogus:func()]\nbody: //article[contains(@class, 'main-content')]`);
    const result = applyFtrConfig(ARTICLE_HTML, "https://example.com/a", bad);
    // The bad expression is skipped; the valid one still extracts.
    expect(result).not.toBeNull();
    expect(result!.content).toContain("first real paragraph");
  });
});

// ── findFtrConfigForUrl (against the bundled dataset) ─────────────────────────

describe("findFtrConfigForUrl", () => {
  it("matches a bundled host and returns a parsed config with body rules", () => {
    const c = findFtrConfigForUrl("https://www.wired.com/story/some-article/");
    expect(c).not.toBeNull();
    expect(c!.body.length).toBeGreaterThan(0);
  });

  it("matches the bare host and sub-domains of a bundled host", () => {
    expect(findFtrConfigForUrl("https://wired.com/x")).not.toBeNull();
    expect(findFtrConfigForUrl("https://blog.wired.com/x")).not.toBeNull();
  });

  it("returns null for a host with no bundled rule", () => {
    expect(findFtrConfigForUrl("https://no-such-site-here.example/x")).toBeNull();
  });

  it("returns null for an unparseable url", () => {
    expect(findFtrConfigForUrl("not a url")).toBeNull();
  });
});

// ── integration: ftr is the first tier in extractReadableContent ─────────────

describe("extractReadableContent — ftr first tier", () => {
  // Craft HTML that matches wired.com's bundled body rule
  // (//article[contains(@class, 'main-content')]).
  const WIRED_LIKE = `
<!doctype html><html><head><title>Wired-ish</title></head><body>
  <article class="main-content">
    <h1>Motion Sensors Without Cameras</h1>
    <p>You do not need a camera to secure your home. Over several weeks of testing
    I evaluated a range of motion sensors and privacy-respecting alternatives that
    reliably detect activity without ever recording video of your household.</p>
    <p>Each device was judged on reliability, setup effort, and how cleanly it slots
    into common smart-home hubs, so you can pick one that fits without adding yet
    another camera to your life and your network.</p>
  </article>
</body></html>`;

  it("reports extractedBy 'ftr' when a bundled rule matches the host", async () => {
    const result = await extractReadableContent(WIRED_LIKE, "https://www.wired.com/story/motion-sensors/");
    expect(result.extractedBy).toBe("ftr");
    expect((result.html || "").toLowerCase()).toContain("motion sensors");
    expect(result.wordCount).toBeGreaterThan(0);
  });

  it("falls back to the generic path for a host with no bundled rule", async () => {
    const result = await extractReadableContent(WIRED_LIKE, "https://unknown-host.example/story/");
    expect(result.extractedBy).not.toBe("ftr");
  });
});
