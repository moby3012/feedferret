import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The mapping phase is pure; keep the DB module out of the import graph.
vi.mock("@/lib/db", () => ({ db: {} }));

import { generateOpml, OpmlParseError, OPML_PARSE_LIMITS, parseOpml, type OpmlOutline } from "../../lib/opml";
import { mapOutlineToFeed, planOpmlImport, type ImportIssue, type PlannedFeed } from "../../lib/import/opml-import";

const fixture = readFileSync(join(__dirname, "../fixtures/freshrss/feeds_2026-11-09.opml.xml"), "utf8");

async function plan(trust: "local" | "remote" = "local") {
  return planOpmlImport(await parseOpml(fixture), { trust });
}
function allFeeds(p: Awaited<ReturnType<typeof plan>>): PlannedFeed[] {
  const out: PlannedFeed[] = [...p.feeds];
  const walk = (cats: typeof p.categories) => cats.forEach((c) => { out.push(...c.feeds); walk(c.children); });
  walk(p.categories);
  return out;
}
const feed = async (name: string, trust: "local" | "remote" = "local") => allFeeds(await plan(trust)).find((f) => f.name === name)!;
const issuesFor = async (subject: string, trust: "local" | "remote" = "local") => (await plan(trust)).issues.filter((i) => i.subject === subject);
const codes = (issues: ImportIssue[]) => issues.map((i) => i.code).sort();

describe("FreshRSS OPML golden fixture → plan", () => {
  it("builds the category tree including the empty category and the dynamic one", async () => {
    const p = await plan();
    expect(p.categories.map((c) => c.name)).toEqual(["Tech", "News & Politik", "Scraped", "Leer", "Shared Packs"]);
    expect(p.categories.find((c) => c.name === "Leer")).toMatchObject({ feeds: [], children: [] });
    expect(p.categories.find((c) => c.name === "Shared Packs")!.opmlUrl).toBe("https://packs.example.net/starter.opml");
    expect(p.feeds.map((f) => f.name)).toEqual(["Lone Feed"]);
  });

  it("rejects the file:// feed with a reported error instead of importing it", async () => {
    const p = await plan();
    expect(allFeeds(p).some((f) => f.url.startsWith("file:"))).toBe(false);
    expect(p.errors).toEqual(["Broken Local: invalid or missing feed URL"]);
    expect(p.issues.some((i) => i.code === "feed-url-invalid" && i.subject === "Broken Local")).toBe(true);
  });

  it("maps priority, ttl, unicity and full-content settings (Ars Technica, muted)", async () => {
    const f = await feed("Ars Technica");
    expect(f.data).toMatchObject({
      unicityCriteria: "link",
      unicityCriteriaForced: true,
      updateFrequency: 60,
      mute: true,
      fullTextSelector: "article .article-content",
      fullTextRemoveSelectors: ".ad, .related",
      fullTextConditions: "title=Review\nurl~/gadgets/",
      enableSelectorMode: true,
    });
    // Both condition lines are plain keywords, so they are evaluated: nothing to report.
    expect(codes(await issuesFor("Ars Technica"))).toEqual([]);
  });

  it("translates Hacker News read-filters and reports what has no equivalent", async () => {
    const f = await feed("Hacker News");
    expect(f.data.priority).toBe("important");
    expect(f.data.updateFrequency).toBe(30);
    expect(f.data.filtersActionRead).toBe("sponsored");
    expect(f.ruleQuery).toBe("intitle:hiring OR author:bot -intitle:rust");
    const unsupported = (await issuesFor("Hacker News")).filter((i) => i.code === "filter-untranslatable").map((i) => i.detail!.split(" — ")[0]);
    expect(unsupported).toEqual(['intitle:"Show HN"', "/^\\[dead\\]/", "#spam", "(a OR b) c", "date:P1D/"]);
    expect((await issuesFor("Hacker News")).some((i) => i.code === "filter-rule-created")).toBe(true);
  });

  it("keeps all XPath scraping fields, cURL options and the css selector for HTML+XPath feeds", async () => {
    const f = await feed("Example Blog");
    expect(f.data.sourceType).toBe("HTML+XPath");
    expect(JSON.parse(f.data.scraperConfig!).xpath).toEqual({
      xPathItem: "//article[contains(@class,'post')]",
      xPathItemTitle: ".//h2",
      xPathItemContent: ".//div[@class='summary']",
      xPathItemUri: ".//h2/a/@href",
      xPathItemAuthor: ".//span[@class='by']",
      xPathItemTimestamp: ".//time/@datetime",
      xPathItemTimeFormat: "d.m.Y H:i",
      xPathItemThumbnail: ".//img/@src",
      xPathItemCategories: ".//a[@rel='tag']",
      xPathItemUid: "./@id",
    });
    const http = JSON.parse(f.data.httpOptions!);
    expect(http).toMatchObject({
      CURLOPT_COOKIE: "session=abc123",
      CURLOPT_FOLLOWLOCATION: true,
      CURLOPT_MAXREDIRS: 5,
      CURLOPT_PROXY: "http://proxy.internal:3128",
      CURLOPT_PROXYTYPE: 0,
      CURLOPT_HTTPHEADER: "X-Test: 1\nAccept: text/html",
    });
    expect(http).not.toHaveProperty("CURLOPT_COOKIEFILE");
    expect(f.data.customUserAgent).toBe("Mozilla/5.0 (X11; Linux x86_64) FreshRSS");
    expect(f.data.fullTextSelector).toBe("div.post-body");
    expect(codes(await issuesFor("Example Blog"))).toEqual(["cookiefile-server-local", "proxytype-ignored", "unknown-extension"]);
  });

  it("preserves unknown frss:* attributes on the feed and reports them", async () => {
    const f = await feed("Example Blog");
    expect(JSON.parse(f.data.scraperConfig!).extensions).toEqual({ futureFlag: "yes" });
    const unknown = (await issuesFor("Example Blog")).find((i) => i.code === "unknown-extension")!;
    expect(unknown).toMatchObject({ kind: "preserved", attribute: "frss:futureFlag" });
  });

  it("maps JSON, XML, hybrid, JSONFeed and legacy DotPath sources", async () => {
    expect((await feed("Shop API")).data.sourceType).toBe("JSON+DotNotation");
    expect(JSON.parse((await feed("Shop API")).data.scraperConfig!).json).toMatchObject({ jsonItem: "data.products", jsonItemUid: "sku", jsonItemTimeFormat: "c" });
    expect((await feed("Sitemap XML")).data.sourceType).toBe("XML+XPath");
    const hybrid = await feed("Hybrid");
    expect(hybrid.data.sourceType).toBe("HTML+XPath+JSON+DotNotation");
    expect(JSON.parse(hybrid.data.scraperConfig!).xPathToJson).toBe("//script[@id='__DATA__']");
    expect((await feed("Podcast Hub")).data.sourceType).toBe("JSONFeed");
    expect((await feed("Legacy Dot Path")).data.sourceType).toBe("JSON+DotNotation");
  });

  it("clamps an absurd ttl and maps the hidden priority", async () => {
    const f = await feed("Lone Feed");
    expect(f.data).toMatchObject({ priority: "hidden", updateFrequency: 10_080 });
    expect(f.data.mute).toBeUndefined();
    expect(codes(await issuesFor("Lone Feed"))).toEqual(["priority-hidden-approximated", "ttl-clamped"]);
    expect(f.data.hideFromAllFeeds).toBe(true);
    // The original TTL is kept for the export back to FreshRSS.
    expect(JSON.parse(f.data.scraperConfig!).preserved).toEqual({ ttl: "86400000" });
  });

  it("never drops a frss attribute silently: every attribute is mapped, reported or preserved", async () => {
    const outlines = await parseOpml(fixture);
    const attrs = new Set<string>();
    const walk = (list: OpmlOutline[]) => list.forEach((o) => { Object.keys(o.extensions ?? {}).forEach((a) => attrs.add(a)); walk(o.children ?? []); });
    walk(outlines);
    // Every extension attribute of the real export is visible to the importer (incl. ttl + unknown).
    expect([...attrs]).toEqual(expect.arrayContaining(["ttl", "futureFlag", "filtersActionRead", "cssFullContent", "CURLOPT_COOKIEFILE", "opmlUrl", "priority"]));
  });
});

describe("trust policy for remote (dynamic) OPML", () => {
  it("drops cookies, headers, proxy, POST options and rule creation from remote files, and says so", async () => {
    const blog = await feed("Example Blog", "remote");
    // Every cURL option is refused from remote files, incl. user agent and redirect policy.
    expect(blog.data.httpOptions).toBeNull();
    expect(blog.data.customUserAgent).toBeUndefined();
    expect(codes(await issuesFor("Example Blog", "remote"))).toEqual(expect.arrayContaining(["http-option-remote-dropped", "expression-remote-dropped"]));
    expect(blog.data.scraperConfig === null || !JSON.parse(blog.data.scraperConfig).xpath).toBe(true);
    expect(blog.data.fullTextSelector).toBeUndefined();

    const hn = await feed("Hacker News", "remote");
    expect(hn.ruleQuery).toBeNull();
    expect(codes(await issuesFor("Hacker News", "remote"))).toContain("filter-rule-remote-dropped");
  });

  it("does not follow nested dynamic category URLs from remote OPML", async () => {
    const p = await plan("remote");
    expect(p.categories.find((c) => c.name === "Shared Packs")!.opmlUrl).toBeNull();
    expect(p.issues.some((i) => i.code === "nested-dynamic-opml-dropped")).toBe(true);
  });
});

describe("mapOutlineToFeed edge cases", () => {
  const map = (outline: Partial<OpmlOutline>) => {
    const issues: ImportIssue[] = [];
    const planned = mapOutlineToFeed({ text: "X", xmlUrl: "https://x.example/feed", ...outline }, "local", issues);
    return { planned, issues };
  };
  it("reports an unknown type and an invalid priority instead of guessing silently", () => {
    const { planned, issues } = map({ type: "carrier-pigeon", extensions: { priority: "urgent" } });
    expect(planned!.data).toMatchObject({ sourceType: "rss", priority: "main" });
    expect(codes(issues)).toEqual(["priority-invalid", "type-unknown"]);
  });
  it("reports scraper feeds that lack their item selector", () => {
    expect(codes(map({ type: "HTML+XPath" }).issues)).toEqual(["scraper-incomplete"]);
  });
  it("ignores a non-numeric ttl with a report", () => {
    const { planned, issues } = map({ extensions: { ttl: "soon" } });
    expect(planned!.data.updateFrequency).toBeUndefined();
    expect(codes(issues)).toEqual(["ttl-invalid"]);
  });
  it("is a no-op for default ttl 0", () => {
    expect(map({ extensions: { ttl: "0" } }).planned!.data.updateFrequency).toBeUndefined();
  });
});

describe("FeedFerret's own export still round-trips (incl. ttl and unknown attributes)", () => {
  it("round-trips ttl/mute and unknown extension attributes", async () => {
    const xml = generateOpml([
      { name: "Round", url: "https://r.example/feed", sourceType: "rss", updateFrequency: 30, autoMuted: true, scraperConfig: JSON.stringify({ extensions: { futureFlag: "yes" } }) },
    ], [], { includeCredentials: true });
    const p = planOpmlImport(await parseOpml(xml));
    const f = p.feeds[0];
    expect(f.data).toMatchObject({ updateFrequency: 30, mute: true });
    expect(JSON.parse(f.data.scraperConfig!).extensions).toEqual({ futureFlag: "yes" });
  });
});

describe("XML safety (XXE, billion laughs, depth/size bombs)", () => {
  const wrap = (doctype: string, body = "<outline text='a' type='rss' xmlUrl='https://a.example/f'/>") =>
    `<?xml version="1.0"?>${doctype}<opml version="2.0"><body>${body}</body></opml>`;

  it("rejects an external entity (XXE) declaration", async () => {
    const xxe = wrap('<!DOCTYPE opml [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>', "<outline text='&xxe;' type='rss' xmlUrl='https://a.example/f'/>");
    await expect(parseOpml(xxe)).rejects.toBeInstanceOf(OpmlParseError);
  });

  it("rejects a billion-laughs entity expansion", async () => {
    const lol = wrap(
      '<!DOCTYPE opml [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>',
      "<outline text='&c;' type='rss' xmlUrl='https://a.example/f'/>",
    );
    await expect(parseOpml(lol)).rejects.toThrow(/entity|DTD/i);
  });

  it("rejects an internal DTD subset even without entities", async () => {
    await expect(parseOpml(wrap("<!DOCTYPE opml [<!ELEMENT opml ANY>]>"))).rejects.toBeInstanceOf(OpmlParseError);
  });

  it("rejects malformed XML with a clean error", async () => {
    await expect(parseOpml("<opml><body><outline></body>")).rejects.toBeInstanceOf(OpmlParseError);
  });

  it("rejects nesting deeper than the limit", async () => {
    const depth = OPML_PARSE_LIMITS.maxDepth + 2;
    const body = "<outline text='n'>".repeat(depth) + "</outline>".repeat(depth);
    await expect(parseOpml(wrap("", body))).rejects.toThrow(/nesting/);
  });

  it("rejects more outlines than the limit", async () => {
    const many = "<outline text='o' type='rss' xmlUrl='https://a.example/f'/>".repeat(OPML_PARSE_LIMITS.maxOutlines + 1);
    await expect(parseOpml(wrap("", many))).rejects.toThrow(/more than/);
  });

  it("still accepts a plain DOCTYPE without an internal subset and a BOM", async () => {
    const outlines = await parseOpml("﻿" + wrap('<!DOCTYPE opml SYSTEM "opml.dtd">'));
    expect(outlines).toHaveLength(1);
  });
});


describe("content rule import policy", () => {
  it("maps local rules, rejects unsafe patterns and blocks remote rules", async () => {
    const rules = JSON.stringify({ transforms: [{ type: "strip_text_after", marker: "Footer" }] });
    const outlines = await parseOpml(generateOpml([{ name: "Synthetic", url: "https://example.com/feed", contentRules: rules }]));
    expect(planOpmlImport(outlines, { trust: "local" }).feeds[0].data.contentRules).toBe(rules);
    expect(planOpmlImport(outlines, { trust: "remote" }).feeds[0].data.contentRules).toBeUndefined();
    outlines[0].extensions!.contentRules = JSON.stringify({ gates: [{ type: "title_include", pattern: "(a+)+$" }] });
    const unsafe = planOpmlImport(outlines, { trust: "local" });
    expect(unsafe.feeds[0].data.contentRules).toBeUndefined();
    expect(unsafe.issues.some(x => x.code === "content-rules-invalid")).toBe(true);
  });
});
