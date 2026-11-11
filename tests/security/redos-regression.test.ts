import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { reduceHtmlForPrompt } from "@/lib/ai-feed-config";
import { acceptCleanTitle } from "@/lib/ai-tagging";
import { neutralizeLinks, sanitizeDigestSummary, sanitizeOutputText } from "@/lib/ai/citations";
import { htmlToPlainText, markdownToPlainText } from "@/lib/article-kind";
import { buildWatchFeedUrl } from "@/lib/changedetection";
import { computeContentHash, normalizeArticleUrl } from "@/lib/content-hash";
import { computeHeuristicEnrichment, detectClickbait, detectSponsored } from "@/lib/enrichment-heuristics";
import { assessExtraction } from "@/lib/extraction-quality";
import { articleMatchesContentFilter } from "@/lib/feed-content-filter";
import { extractImageFromHtml } from "@/lib/feed-fetcher";
import { parseFtrConfig } from "@/lib/ftr-site-config";
import { stripStyleBlocks } from "@/lib/html-utils";
import { extractRecipientTokens, normalizeMessageId } from "@/lib/inbound-email";
import { findRoleMainTag, replaceTagsNamed, stripTags } from "@/lib/linear-text";
import { normalizeTitle } from "@/lib/page-feed-quality";
import { redact } from "@/lib/redact";
import { stripHtml } from "@/lib/saved-search-sharing";
import { stripLayoutBreakingStyles } from "@/lib/sanitize-html";
import { tokenizeSearch } from "@/lib/search";
import { stripSiteSuffix } from "@/lib/story-clustering/normalize";
import { synthesizeItemTitle } from "@/lib/title-synthesis";
import { decodeBase32 } from "@/lib/totp";

// Node runs everything on ONE event loop: a regex that backtracks
// super-linearly on attacker-controlled text (feed item HTML, fetched pages,
// mail headers, AI output, search input, …) freezes the whole instance for
// minutes. Each case feeds a function that used to contain such a regex with
// hostile 1 MiB input — the shapes that triggered the old quadratic behaviour
// (unterminated tags / comments / brackets, long whitespace and delimiter
// runs) — and requires it to finish within a budget a linear scan meets with
// a wide margin (the old code needed seconds to minutes).

const SIZE = 1024 * 1024;
const BUDGET_MS = 200;

const rep = (unit: string, bytes = SIZE, suffix = "") => unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes) + suffix;

/** Unterminated-markup payloads for every function that scans HTML. */
const HTML_UNITS = [
  "<", "<a ", "<A ", "<img ", "<p ", "<p>", "<link ", "<meta ", "<style ", "<style>", "<script ", "<scripty>", "<head ", "<br ", "<div ",
  "<!--", "<![CDATA[", "<a role=", "<a href=\"x\" ", "</", "<h1 ", "<svg ", " ", "\n", "a",
];
const MD_UNITS = ["[", "![", "[a](", "[a](b", "[a]", "](", "<", " ", "(", "!"];
const TEXT_UNITS = [" ", "a", "a.", "a-", ".0", "a@", "/", "=", "%23", "%3f", "&", "://", "a://", "http://", "x@y.", ">", "<", "\u2026 ", " - ", "!", "?", "(", "-"];
const SEARCH_UNITS = ['"', "'", 'a:"', "a ", '"a ', "'a ", "-a:", "a:", " ", "\"'"];

interface Case {
  name: string;
  units: string[];
  run: (input: string) => unknown;
  /** Optional suffix appended after the repeated unit (a "rejecting" tail). */
  suffix?: string;
}

const CASES: Case[] = [
  // --- HTML (feed item content, fetched pages) -----------------------------
  { name: "feed-fetcher extractImageFromHtml (background feed sync)", units: HTML_UNITS, run: extractImageFromHtml },
  { name: "html-utils stripStyleBlocks", units: HTML_UNITS, run: stripStyleBlocks },
  { name: "ai-feed-config reduceHtmlForPrompt", units: HTML_UNITS, run: reduceHtmlForPrompt },
  { name: "article-kind htmlToPlainText", units: HTML_UNITS, run: htmlToPlainText },
  { name: "title-synthesis synthesizeItemTitle", units: HTML_UNITS, run: (s) => synthesizeItemTitle(s) },
  { name: "saved-search-sharing stripHtml", units: HTML_UNITS, run: stripHtml },
  { name: "feed-content-filter articleMatchesContentFilter", units: HTML_UNITS, run: (s) => articleMatchesContentFilter({ content: s }, ["needle"]) },
  { name: "page-feed-quality / readability / ssrf stripTags", units: HTML_UNITS, run: (s) => stripTags(s) },
  { name: "linear-text replaceTagsNamed + findRoleMainTag", units: HTML_UNITS, run: (s) => [replaceTagsNamed(s, new Set(["p", "div"]), " "), findRoleMainTag(s)] },
  { name: "enrichment-heuristics detectSponsored (html)", units: HTML_UNITS, run: (s) => detectSponsored({ title: "t", html: s }) },
  { name: "extraction-quality assessExtraction", units: HTML_UNITS, run: (s) => assessExtraction(s) },
  { name: "ftr-site-config parseFtrConfig", units: [": ", "a:", " ", "# "], run: parseFtrConfig },
  // --- Markdown ------------------------------------------------------------
  { name: "article-kind markdownToPlainText", units: MD_UNITS, run: markdownToPlainText },
  // --- E-mail (headers of newsletter ingest) -------------------------------
  { name: "inbound-email extractRecipientTokens", units: TEXT_UNITS, run: (s) => extractRecipientTokens([s]) },
  { name: "inbound-email normalizeMessageId", units: ["<", ">", " ", ".", "a"], run: (s) => normalizeMessageId(s) },
  // --- AI output / prompts -------------------------------------------------
  { name: "ai/citations neutralizeLinks", units: TEXT_UNITS, run: neutralizeLinks },
  { name: "ai/citations sanitizeOutputText", units: TEXT_UNITS, run: (s) => sanitizeOutputText(s) },
  { name: "ai/citations sanitizeDigestSummary", units: TEXT_UNITS, run: sanitizeDigestSummary },
  { name: "ai-tagging acceptCleanTitle (feed title as `original`)", units: ["a.", "a-", "a@", " ", "a"], run: (s) => acceptCleanTitle("a.b", s, "") },
  // --- Titles / URLs / misc text -------------------------------------------
  { name: "page-feed-quality normalizeTitle", units: TEXT_UNITS, run: normalizeTitle },
  { name: "story-clustering stripSiteSuffix", units: TEXT_UNITS, run: (s) => stripSiteSuffix(s, { feedName: "x" }) },
  { name: "enrichment-heuristics detectClickbait", units: TEXT_UNITS, run: detectClickbait },
  { name: "enrichment-heuristics computeHeuristicEnrichment", units: TEXT_UNITS, run: (s) => computeHeuristicEnrichment({ title: s, text: s }) },
  { name: "content-hash normalizeArticleUrl / computeContentHash", units: ["/", "//", "#", "a", "%2F"], run: (s) => [normalizeArticleUrl(`https://e.test/${s}`), normalizeArticleUrl(s), computeContentHash(s)] },
  { name: "changedetection buildWatchFeedUrl (trailing slashes)", units: ["/"], suffix: "x", run: (s) => buildWatchFeedUrl({ baseUrl: `https://e.test${s}`, apiKey: "k" } as never, "u") },
  { name: "totp decodeBase32", units: ["=", "A", " "], suffix: "!", run: decodeBase32 },
  { name: "redact (diagnostic text)", units: TEXT_UNITS, run: redact },
  { name: "sanitize-html stripLayoutBreakingStyles (style attr)", units: ["(", "( ", "-", " ", "a(", "rgb(", ";", ":"], run: (s) => stripLayoutBreakingStyles(`width:${s}`) },
  { name: "search tokenizeSearch (user query)", units: SEARCH_UNITS, run: tokenizeSearch },
];

/**
 * Best of up to five runs with a short pause in between: the suite runs in parallel workers, so a slow
 * sample is scheduler/GC noise, not a regression (a quadratic regex needs seconds to minutes on every run).
 */
function elapsed(fn: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < 5 && best > BUDGET_MS; i++) {
    if (i > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe("ReDoS regression: hostile 1 MiB input finishes in linear time", () => {
  for (const c of CASES) {
    it(`${c.name} < ${BUDGET_MS} ms`, () => {
      // Warm-up on a small input so JIT/regex compilation is not billed to the 1 MiB run.
      c.run(rep(c.units[0], 2048));
      const slow: string[] = [];
      for (const unit of c.units) {
        const input = rep(unit, SIZE, c.suffix ?? "\u0001!");
        const ms = elapsed(() => c.run(input));
        if (ms > BUDGET_MS) slow.push(`${JSON.stringify(unit)}: ${Math.round(ms)} ms`);
      }
      expect(slow, `slower than ${BUDGET_MS} ms on 1 MiB`).toEqual([]);
    }, 60_000);
  }
});

describe("ReDoS regression: normal inputs keep their behaviour", () => {
  it("extractImageFromHtml finds the first <img src>", () => {
    expect(extractImageFromHtml('<p>Hi</p><img alt="x" src="https://e.test/a.jpg"><img src="b.png">')).toBe("https://e.test/a.jpg");
    expect(extractImageFromHtml("<p>no image</p>")).toBeNull();
  });

  it("stripStyleBlocks removes <style> blocks only", () => {
    expect(stripStyleBlocks("<p>a</p><style>p{color:red}</style><STYLE type='x'>b{}</STYLE><p>b</p>")).toBe("<p>a</p><p>b</p>");
    expect(stripStyleBlocks("<style>unterminated")).toBe("<style>unterminated");
  });

  it("htmlToPlainText strips script/style bodies and tags", () => {
    expect(htmlToPlainText("<p>Hello <b>world</b></p><script>alert(1)</script><style>a{}</style>!")).toBe("Hello world !");
  });

  it("markdownToPlainText drops images and keeps link text", () => {
    expect(markdownToPlainText("![alt](u) see [the docs](https://e.test) now")).toBe("see the docs now");
  });

  it("synthesizeItemTitle ignores script/style and block tags", () => {
    expect(synthesizeItemTitle("<p>First line</p><script>x()</script><p>second</p>")).toBe("First line second");
  });

  it("redact keeps masking credentials", () => {
    expect(redact("GET https://user:pw@host/x?api_key=SECRET&b=1")).toBe("GET https://***@host/x?api_key=***&b=1");
    expect(redact("https://h/p%3Ftoken%3Dabc%26x%3D1")).toBe("https://h/p%3Ftoken%3D***%26x%3D1");
  });

  it("neutralizeLinks removes URLs and addresses, defangs domains", () => {
    expect(neutralizeLinks("see https://evil.test/x and a@b.co or evil-login.com")).toBe("see   and   or evil-login[.]com");
  });

  it("extractRecipientTokens still finds +ff- and bare token recipients", () => {
    expect(extractRecipientTokens(['"Name" <box+ff-abcdef23@example.com>'])).toEqual(expect.any(Array));
  });

  it("normalizeTitle collapses whitespace and trailing punctuation", () => {
    expect(normalizeTitle("  Read   more →  ")).toBe("read more");
    expect(normalizeTitle("Title…!?")).toBe("title");
  });

  it("stripSiteSuffix still splits ' - Site'", () => {
    expect(stripSiteSuffix("Big news today - SPIEGEL", { feedName: "SPIEGEL" })).toBe("Big news today");
  });

  it("detectClickbait still sees trailing ?!", () => {
    expect(detectClickbait("Is this real?!")).toBe(true);
    expect(detectClickbait("A calm headline")).toBe(false);
  });
});
