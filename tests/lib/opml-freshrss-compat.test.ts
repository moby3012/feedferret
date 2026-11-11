import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The mapping phase is pure; keep the DB module out of the import graph.
vi.mock("@/lib/db", () => ({ db: {} }));

import { exportPriority, exportReadFilters, exportTtl, generateApiOpml, generateOpml, parseOpml, ttlToMinutes, type OpmlOutline } from "../../lib/opml";
import { mapOutlineToFeed, planOpmlImport, type ImportIssue, type PlannedCategory, type PlannedFeed } from "../../lib/import/opml-import";
import { buildDedupeKey } from "../../lib/dedupe-key";
import { compileFullTextConditions } from "../../lib/full-text-conditions";
import { runInHtmlWorker } from "../../lib/html-worker";

// cssContentFilter on feed content runs as the pool's `removeSelectors` task (inline in unit tests).
const removeSelectorsFromHtml = async (html: string, selectors: string) =>
  (await runInHtmlWorker({ task: "removeSelectors", items: [html], selectors }))[0];

const fixtureDir = join(__dirname, "../fixtures/freshrss");
const goldenFixture = readFileSync(join(fixtureDir, "feeds_2026-11-09.opml.xml"), "utf8");
const realExport = readFileSync(join(fixtureDir, "real-export-minimised.opml.xml"), "utf8");

// ── helpers ──────────────────────────────────────────────────────────────────

/** A plan turned into Feed/Category rows exactly as applyOpmlImportPlan would create them. */
function planToRows(categories: PlannedCategory[], rootFeeds: PlannedFeed[]) {
  const feeds: Record<string, unknown>[] = [];
  const cats: Record<string, unknown>[] = [];
  const feedRow = (feed: PlannedFeed, categoryId: string | null) => {
    const d = feed.data;
    feeds.push({
      url: feed.url,
      name: d.name,
      sourceType: d.sourceType,
      htmlUrl: d.htmlUrl,
      description: d.description,
      priority: d.priority,
      unicityCriteria: d.unicityCriteria,
      unicityCriteriaForced: d.unicityCriteriaForced,
      scraperConfig: d.scraperConfig,
      httpOptions: d.httpOptions,
      filtersActionRead: d.filtersActionRead ?? null,
      fullTextSelector: d.fullTextSelector ?? null,
      fullTextConditions: d.fullTextConditions ?? null,
      fullTextRemoveSelectors: d.fullTextRemoveSelectors ?? null,
      fullTextMode: d.enableSelectorMode ? "selector" : "off",
      updateFrequency: d.updateFrequency ?? null,
      autoMuted: d.mute ?? false,
      customUserAgent: d.customUserAgent ?? null,
      hideFromAllFeeds: d.hideFromAllFeeds ?? false,
      categoryId,
    });
  };
  const walk = (nodes: PlannedCategory[], parentId: string | null) => {
    for (const node of nodes) {
      const id = `${parentId ?? ""}/${node.name}`;
      cats.push({ id, name: node.name, parentId, opmlUrl: node.opmlUrl });
      node.feeds.forEach((feed) => feedRow(feed, id));
      walk(node.children, id);
    }
  };
  rootFeeds.forEach((feed) => feedRow(feed, null));
  walk(categories, null);
  return { feeds, categories: cats };
}

function feedOutlines(outlines: OpmlOutline[]): OpmlOutline[] {
  return outlines.flatMap((outline) => (outline.xmlUrl ? [outline] : feedOutlines(outline.children ?? [])));
}

const BOOLEAN_ATTRS = new Set(["unicityCriteriaForced", "CURLOPT_FOLLOWLOCATION", "CURLOPT_POST"]);
const MULTILINE_ATTRS = new Set(["filtersActionRead", "cssFullContentConditions", "CURLOPT_HTTPHEADER"]);

/** Attribute values as FreshRSS' importer interprets them (booleans via filter_var, lists line by line). */
function semantic(extensions: Record<string, string> = {}) {
  return Object.fromEntries(
    Object.entries(extensions).map(([name, value]) => {
      if (BOOLEAN_ATTRS.has(name)) return [name, /^(1|true|yes|on)$/i.test(value)];
      if (MULTILINE_ATTRS.has(name)) return [name, value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort()];
      return [name, value];
    }),
  );
}

async function roundTrip(xml: string) {
  const original = await parseOpml(xml);
  const plan = planOpmlImport(original);
  const rows = planToRows(plan.categories, plan.feeds);
  const exported = generateOpml(rows.feeds, rows.categories);
  return { original, plan, exported, reparsed: await parseOpml(exported) };
}

const codes = (issues: ImportIssue[]) => issues.map((issue) => issue.code).sort();
const outline = (extensions: Record<string, string>, extra: Partial<OpmlOutline> = {}): OpmlOutline => ({
  text: "Feed",
  type: "rss",
  xmlUrl: "https://feeds.example.com/rss.xml",
  extensions,
  ...extra,
});
const map = (extensions: Record<string, string>, trust: "local" | "remote" = "local", extra: Partial<OpmlOutline> = {}) => {
  const issues: ImportIssue[] = [];
  const feed = mapOutlineToFeed(outline(extensions, extra), trust, issues)!;
  return { feed, issues };
};

// ── export format ────────────────────────────────────────────────────────────

describe("export is readable by FreshRSS", () => {
  it("uses the literal frss: prefix (FreshRSS' lib_opml reads attributes by qualified name)", async () => {
    const { exported } = await roundTrip(realExport);
    expect(exported).toContain('xmlns:frss="https://freshrss.org/opml"');
    expect(exported).toMatch(/ frss:cssFullContent="\.bodyarticle"/);
    expect(exported).toMatch(/ frss:xPathItem="\/\/ea-tile"/);
    expect(exported).not.toMatch(/ ffx:/);

    // What lib_opml sees: DOM nodeName of every extension attribute.
    const { JSDOM } = await import("jsdom");
    const document = new JSDOM(exported, { contentType: "text/xml" }).window.document;
    const names = new Set(Array.from(document.querySelectorAll("outline")).flatMap((el) => Array.from(el.attributes).map((a) => a.name)));
    for (const name of ["frss:cssFullContent", "frss:unicityCriteria", "frss:unicityCriteriaForced", "frss:xPathItemUid"]) expect(names).toContain(name);
  });

  it("encodes line breaks as character references so multi-line values survive XML attribute normalisation", async () => {
    const { exported, reparsed } = await roundTrip(realExport);
    expect(exported).toContain("&#13;&#10;  substring-after(");
    const community = feedOutlines(reparsed).find((o) => o.text === "Community site")!;
    expect(community.extensions!.xPathItemUid).toBe(
      "concat(\r\n  substring-after(.//h3[@class='title']/a/@href, '/news/'),\r\n  '-',\r\n  translate(.//div[@class='date'], ' ', '-')\r\n)",
    );
  });

  it("still imports exports of older FeedFerret versions (ffx: prefix bound to the FreshRSS namespace)", async () => {
    const legacy = `<?xml version="1.0"?><opml version="2.0" xmlns:ffx="https://freshrss.org/opml"><body>
      <outline text="Old" type="rss" xmlUrl="https://old.example.com/feed" ffx:cssFullContent=".post" ffx:filtersActionRead="a&#10;b"/>
    </body></opml>`;
    const [old] = await parseOpml(legacy);
    expect(old.extensions).toEqual({ cssFullContent: ".post", filtersActionRead: "a\nb" });
  });
});

// ── round trips ──────────────────────────────────────────────────────────────

describe("FreshRSS → FeedFerret → FreshRSS round trip", () => {
  it("keeps every frss: attribute of the (anonymised) real export", async () => {
    const { original, reparsed } = await roundTrip(realExport);
    const before = feedOutlines(original);
    const after = new Map(feedOutlines(reparsed).map((o) => [o.xmlUrl, o]));
    expect(after.size).toBe(before.length);
    for (const feed of before) {
      const back = after.get(feed.xmlUrl)!;
      expect({ url: feed.xmlUrl, type: back.type, ext: semantic(back.extensions) }).toEqual({ url: feed.xmlUrl, type: feed.type, ext: semantic(feed.extensions) });
      expect(back.text).toBe(feed.text);
      expect(back.htmlUrl).toBe(feed.htmlUrl);
      expect(back.description).toBe(feed.description);
    }
    // Category tree incl. both empty categories.
    expect(reparsed.filter((o) => !o.xmlUrl).map((o) => o.text)).toEqual(["Strategy", "Unkategorisiert", "Scraped news", "Mods", "lifestyle", "webhosting"]);
  });

  it("keeps every attribute of the full-spec golden fixture except the documented non-transferable ones", async () => {
    const { original, reparsed } = await roundTrip(goldenFixture);
    const after = new Map(feedOutlines(reparsed).map((o) => [o.xmlUrl, o]));
    for (const feed of feedOutlines(original)) {
      if (feed.xmlUrl!.startsWith("file:")) continue; // rejected on import (SSRF)
      const expected = { ...feed.extensions };
      delete expected.CURLOPT_COOKIEFILE; // a path on the FreshRSS server; FreshRSS itself only keeps ""
      const type = feed.type === "JSON+DotPath" ? "JSON+DotNotation" : feed.type; // FreshRSS alias
      const back = after.get(feed.xmlUrl)!;
      expect({ name: feed.text, type: back.type, ext: semantic(back.extensions) }).toEqual({ name: feed.text, type, ext: semantic(expected) });
    }
    const packs = reparsed.find((o) => o.text === "Shared Packs")!;
    expect(packs.extensions?.opmlUrl).toBe("https://packs.example.net/starter.opml");
  });

  it("is stable: a second FeedFerret round trip changes nothing", async () => {
    const first = await roundTrip(goldenFixture);
    const second = await roundTrip(first.exported);
    const strip = (xml: string) => xml.replace(/<dateCreated>.*<\/dateCreated>/, "");
    expect(strip(second.exported)).toBe(strip(first.exported));
  });
});

// ── per-attribute mapping ────────────────────────────────────────────────────

describe("per-attribute mapping", () => {
  it.each([
    ["important", "important", false, []],
    ["main", "main", false, []],
    ["category", "category", true, []],
    ["feed", "feed", true, ["priority-hidden-approximated"]],
    ["hidden", "hidden", true, ["priority-hidden-approximated"]],
    ["HIDDEN", "hidden", true, ["priority-hidden-approximated"]],
    ["archived", "main", undefined, ["priority-invalid"]],
  ])("frss:priority=%s → priority %s, hideFromAllFeeds %s", (given, priority, hidden, issueCodes) => {
    const { feed, issues } = map({ priority: given });
    expect(feed.data.priority).toBe(priority);
    expect(feed.data.hideFromAllFeeds).toBe(hidden);
    expect(codes(issues)).toEqual(issueCodes);
  });

  it("exports FeedFerret's hide-from-All-feeds as FreshRSS 'category' and never overrides an explicit priority", () => {
    expect(exportPriority({ priority: "main", hideFromAllFeeds: true })).toBe("category");
    expect(exportPriority({ priority: "main", hideFromAllFeeds: false })).toBeUndefined();
    expect(exportPriority({ priority: "hidden", hideFromAllFeeds: true })).toBe("hidden");
    expect(exportPriority({ priority: "important", hideFromAllFeeds: false })).toBe("important");
  });

  it.each([
    ["1800", 30, undefined, undefined],
    ["-3600", 60, true, undefined],
    ["90", 5, undefined, "90"],
    ["-61", 5, true, "-61"],
    ["86400000", 10_080, undefined, "86400000"],
  ])("frss:ttl=%s → %i min, muted %s, preserved %s", (ttl, minutes, mute, preserved) => {
    const { feed } = map({ ttl });
    expect(feed.data.updateFrequency).toBe(minutes);
    expect(feed.data.mute).toBe(mute);
    expect(JSON.parse(feed.data.scraperConfig ?? "{}").preserved?.ttl).toBe(preserved);
  });

  it.each(["abc", "1.5", "1e3", ""])("ignores the invalid ttl %j", (ttl) => {
    const { feed, issues } = map({ ttl });
    expect(feed.data.updateFrequency).toBeUndefined();
    if (ttl) expect(codes(issues)).toEqual(["ttl-invalid"]);
  });

  it("exports ttl signed, incl. muted feeds without an own interval, and writes a preserved value back only while it still applies", () => {
    expect(exportTtl({ updateFrequency: null, autoMuted: false }, undefined, {})).toBeUndefined();
    expect(exportTtl({ updateFrequency: 30, autoMuted: false }, undefined, {})).toBe("1800");
    expect(exportTtl({ updateFrequency: null, autoMuted: true }, undefined, { defaultUpdateFrequency: 120 })).toBe("-7200");
    expect(exportTtl({ updateFrequency: 5, autoMuted: false }, "90", {})).toBe("90");
    expect(exportTtl({ updateFrequency: 15, autoMuted: false }, "90", {})).toBe("900"); // user changed the interval
    expect(exportTtl({ updateFrequency: 5, autoMuted: false }, "-90", {})).toBe("300"); // user unmuted
    expect(ttlToMinutes(-3600)).toEqual({ minutes: 60, exact: true });
  });

  it.each(["link", "id", "sha1:link_published", "sha1:title_published_content", "link:title"])("accepts unicityCriteria %s", (criteria) => {
    expect(map({ unicityCriteria: criteria }).feed.data.unicityCriteria).toBe(criteria);
  });

  it("rejects an unicityCriteria FreshRSS itself would refuse", () => {
    const { feed, issues } = map({ unicityCriteria: "Robert'); DROP TABLE" });
    expect(feed.data.unicityCriteria).toBe("id");
    expect(codes(issues)).toEqual(["unicity-invalid"]);
  });

  it.each([["true", true], ["1", true], ["false", false], ["0", false]])("unicityCriteriaForced=%s → %s", (value, forced) => {
    expect(map({ unicityCriteriaForced: value }).feed.data.unicityCriteriaForced).toBe(forced);
  });

  it("maps cssFullContent, cssContentFilter (and its legacy alias) and conditions", () => {
    const { feed, issues } = map({ cssFullContent: "div.main, .summary", cssFullContentFilter: ".footer", cssFullContentConditions: "intitle:review\nkeyword" });
    expect(feed.data).toMatchObject({ fullTextSelector: "div.main, .summary", enableSelectorMode: true, fullTextRemoveSelectors: ".footer", fullTextConditions: "intitle:review\nkeyword" });
    expect(issues).toEqual([]);
  });

  it("reports full-text conditions it cannot evaluate", () => {
    const { issues } = map({ cssFullContent: "article", cssFullContentConditions: "intitle:review\n/^regex/" });
    expect(codes(issues)).toEqual(["css-conditions-partial"]);
  });

  it("keeps every non-keyword read filter line for the export", () => {
    const raw = "sponsored\n\"Show HN\"\nintitle:hiring\n#spam";
    const { feed } = map({ filtersActionRead: raw });
    expect(feed.data.filtersActionRead).toBe("sponsored\nShow HN");
    expect(JSON.parse(feed.data.scraperConfig!).preserved.filtersActionRead).toBe("intitle:hiring\n#spam");
    expect(exportReadFilters(feed.data.filtersActionRead, "intitle:hiring\n#spam")!.split("\n")).toEqual(["sponsored", '"Show HN"', "intitle:hiring", "#spam"]);
  });

  it("quotes FeedFerret keywords that FreshRSS would read as search syntax", () => {
    expect(exportReadFilters("crypto\nbig sale\n-minus\nOR\nfoo:bar", undefined)!.split("\n")).toEqual(["crypto", '"big sale"', '"-minus"', '"OR"', '"foo:bar"']);
  });

  it("exports the selector only while full text is switched on (in FreshRSS the selector is the switch)", () => {
    const row = { name: "F", url: "https://f.example.com/rss", sourceType: "rss", fullTextSelector: ".post", fullTextRemoveSelectors: ".ad" };
    expect(generateOpml([{ ...row, fullTextMode: "selector" }])).toContain('frss:cssFullContent=".post"');
    expect(generateOpml([{ ...row, fullTextMode: "auto" }])).toContain('frss:cssFullContent=".post"');
    const off = generateOpml([{ ...row, fullTextMode: "off" }]);
    expect(off).not.toContain("frss:cssFullContent=");
    expect(off).toContain('frss:cssContentFilter=".ad"');
  });

  it("exports the per-feed user agent as CURLOPT_USERAGENT (private export only)", () => {
    const row = { name: "F", url: "https://f.example.com/rss", sourceType: "rss", customUserAgent: "MyAgent/1.0" };
    expect(generateOpml([row])).toContain('frss:CURLOPT_USERAGENT="MyAgent/1.0"');
    expect(generateApiOpml([row])).not.toContain("CURLOPT_USERAGENT");
  });

  it("never writes an attribute twice when a preserved unknown attribute collides with a known one", async () => {
    const row = { name: "F", url: "https://f.example.com/rss", sourceType: "rss", priority: "important", scraperConfig: JSON.stringify({ extensions: { priority: "hidden", futureFlag: "x" } }) };
    const xml = generateOpml([row]);
    expect(xml.match(/frss:priority=/g)).toHaveLength(1);
    const [parsed] = await parseOpml(xml);
    expect(parsed.extensions).toMatchObject({ priority: "important", futureFlag: "x" });
  });

  it("maps every scraper type and its xPath/json attributes", async () => {
    const plan = planOpmlImport(await parseOpml(goldenFixture));
    const byName = new Map(planToRows(plan.categories, plan.feeds).feeds.map((f) => [f.name, f]));
    expect(byName.get("Example Blog")!.sourceType).toBe("HTML+XPath");
    expect(byName.get("Sitemap XML")!.sourceType).toBe("XML+XPath");
    expect(byName.get("Shop API")!.sourceType).toBe("JSON+DotNotation");
    expect(byName.get("Legacy Dot Path")!.sourceType).toBe("JSON+DotNotation");
    expect(byName.get("Hybrid")!.sourceType).toBe("HTML+XPath+JSON+DotNotation");
    expect(byName.get("Podcast Hub")!.sourceType).toBe("JSONFeed");
    expect(Object.keys(JSON.parse(byName.get("Example Blog")!.scraperConfig as string).xpath)).toHaveLength(10);
    expect(Object.keys(JSON.parse(byName.get("Shop API")!.scraperConfig as string).json)).toHaveLength(10);
    expect(JSON.parse(byName.get("Hybrid")!.scraperConfig as string).xPathToJson).toBe("//script[@id='__DATA__']");
  });
});

// ── fetch-side semantics ─────────────────────────────────────────────────────

describe("FreshRSS unicity criteria in article identity", () => {
  const item = { link: "https://e.example.com/a", title: "Hello", publishedAt: new Date("2026-01-02T03:04:05Z"), content: "<p>Body</p>" };
  const sha1 = (value: string) => `sha1:${createHash("sha1").update(value).digest("hex")}`;
  const unix = String(Math.floor(item.publishedAt.getTime() / 1000));

  it.each([
    ["sha1:link_published", item.link + unix],
    ["sha1:link_published_title", item.link + unix + item.title],
    ["sha1:link_published_title_content", item.link + unix + item.title + item.content],
    ["sha1:title", item.title],
    ["sha1:title_published", item.title + unix],
    ["sha1:title_published_content", item.title + unix + item.content],
    ["sha1:content", item.content],
    ["sha1:content_published", item.content + unix],
    ["sha1:published", unix],
  ])("%s hashes like FreshRSS", (criteria, input) => {
    expect(buildDedupeKey({ unicityCriteria: criteria }, item, "guid-1")).toBe(sha1(input));
  });

  it("falls back to the item id when the hashed fields are all empty (FreshRSS treats sha1('') as no GUID)", () => {
    expect(buildDedupeKey({ unicityCriteria: "sha1:title" }, { link: "https://e.example.com/b" }, "guid-2")).toBe("guid-2");
  });

  it("leaves FeedFerret's own criteria unchanged", () => {
    expect(buildDedupeKey({ unicityCriteria: "link:title" }, item, "g")).toBe(`${item.link}:Hello`);
    expect(buildDedupeKey({ unicityCriteria: "id" }, item, "g")).toBe("g");
  });
});

describe("full-text conditions", () => {
  it("compiles keyword and field lines and refuses partial evaluation", () => {
    expect(compileFullTextConditions("Review\nintitle:test")).toEqual({ keywords: ["review"], queries: ["intitle:test"] });
    expect(compileFullTextConditions("intitle:test\n/^re/")).toBeNull();
    expect(compileFullTextConditions("  ")).toBeNull();
  });
});

describe("cssContentFilter on feed content", () => {
  it("removes every match of the selector list, incl. lists inside :is()", async () => {
    const html = '<p>Keep</p><div class="ad">Ad</div><aside class="related">R</aside><footer>F</footer>';
    expect(await removeSelectorsFromHtml(html, ".ad, :is(.related, footer)")).toBe("<p>Keep</p>");
  });

  it("leaves content untouched for an invalid selector or no match", async () => {
    const html = "<p>Keep</p>";
    expect(await removeSelectorsFromHtml(html, "[[invalid")).toBe(html);
    expect(await removeSelectorsFromHtml(html, ".nothing")).toBe(html);
    expect(await removeSelectorsFromHtml(html, "  ")).toBe(html);
  });
});

// ── security ─────────────────────────────────────────────────────────────────

describe("imported HTTP options stay inside the SSRF and secrecy rules", () => {
  const secretHeaders = "Authorization: Bearer SUPER-SECRET-TOKEN\nHost: 169.254.169.254\nTransfer-Encoding: chunked\nX-Ok: 1\nbroken line SECRET-IN-BROKEN";
  const options = { CURLOPT_HTTPHEADER: secretHeaders, CURLOPT_COOKIE: "sid=COOKIE-SECRET", CURLOPT_PROXY: "http://user:PROXY-SECRET@10.0.0.1:3128", CURLOPT_POSTFIELDS: "token=POST-SECRET", CURLOPT_POST: "1" };

  it("drops request-retargeting headers and reports only header names", () => {
    const { feed, issues } = map(options);
    const http = JSON.parse(feed.data.httpOptions!);
    expect(http.CURLOPT_HTTPHEADER).toBe("Authorization: Bearer SUPER-SECRET-TOKEN\nX-Ok: 1");
    const report = JSON.stringify(issues);
    expect(issues.find((i) => i.code === "http-header-dropped")!.detail).toBe("Host, Transfer-Encoding, (line without name)");
    for (const secret of ["SUPER-SECRET-TOKEN", "COOKIE-SECRET", "PROXY-SECRET", "POST-SECRET", "SECRET-IN-BROKEN", "169.254.169.254"]) {
      expect(report).not.toContain(secret);
    }
  });

  it("accepts no cookie, header, proxy or POST option from a remote (dynamic) OPML", () => {
    const { feed, issues } = map(options, "remote");
    expect(feed.data.httpOptions).toBeNull();
    expect(codes(issues)).toContain("http-option-remote-dropped");
    expect(JSON.stringify(issues)).not.toContain("SECRET");
  });

  it("clamps an excessive redirect limit", () => {
    const { feed, issues } = map({ CURLOPT_MAXREDIRS: "5000" });
    expect(JSON.parse(feed.data.httpOptions!).CURLOPT_MAXREDIRS).toBe(20);
    expect(codes(issues)).toEqual(["maxredirs-clamped"]);
  });

  it("never exports credentials or cURL options through the API export", () => {
    const row = {
      name: "F", url: "https://user:pw@f.example.com/rss", sourceType: "rss",
      httpOptions: JSON.stringify({ CURLOPT_COOKIE: "sid=COOKIE-SECRET", CURLOPT_PROXY: "http://u:PROXY-SECRET@proxy.example.com:3128" }),
      scraperConfig: JSON.stringify({ extensions: { secretish: "EXT-SECRET" }, preserved: { filtersActionRead: "intitle:x" } }),
    };
    const xml = generateApiOpml([row]);
    for (const secret of ["COOKIE-SECRET", "PROXY-SECRET", "EXT-SECRET", "user:pw"]) expect(xml).not.toContain(secret);
    expect(xml).toContain('frss:filtersActionRead="intitle:x"');
  });

  it("rejects a non-http feed URL from the file instead of fetching it", () => {
    const issues: ImportIssue[] = [];
    expect(mapOutlineToFeed(outline({}, { xmlUrl: "file:///etc/passwd" }), "local", issues)).toBeNull();
    expect(codes(issues)).toEqual(["feed-url-invalid"]);
  });
});
