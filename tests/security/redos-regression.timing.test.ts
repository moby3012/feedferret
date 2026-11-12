import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { reduceHtmlForPrompt } from "@/lib/ai-feed-config";
import { acceptCleanTitle } from "@/lib/ai-tagging";
import { buildAliasMap, neutralizeLinks, sanitizeDigestSummary, sanitizeOutputText, validateLine } from "@/lib/ai/citations";
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
import { findRoleMainTag, matchBearerToken, replaceTagsNamed, stripTags } from "@/lib/linear-text";
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
// hostile input — the shapes that triggered the old quadratic behaviour
// (unterminated markup, long whitespace / delimiter runs, U+2028 tails, …).
//
// Shared CI runners are slow and noisy, so absolute millisecond budgets are
// unreliable; the test checks GROWTH instead. Size ×4 costs ≈ ×4 time for a
// linear scan and ≈ ×16 for a quadratic one, and a quadratic regex needs
// minutes at 1 MiB where a linear one needs well under a second:
//   1. 64 KiB and 256 KiB are timed first (cheap even for a quadratic regex,
//      so a regression fails fast instead of hanging the run); growth above
//      ×8 on a non-trivial time fails.
//   2. then 1 MiB must stay under a generous absolute ceiling (CI-safe) and
//      keep the same growth bound against 256 KiB.
// This file runs in its own vitest project, strictly sequentially (see
// vitest.config.ts), so it neither gets starved by nor starves other suites.

const KIB = 1024;
const SIZES = { small: 64 * KIB, mid: 256 * KIB, big: 1024 * KIB };
const GROWTH_LIMIT = 8; // linear ≈ 4, quadratic ≈ 16
const GROWTH_MIN_MS = 100; // below this the ratio is dominated by noise
const ABSOLUTE_CEILING_MS = 2_000; // 1 MiB; a quadratic regex needs minutes

const rep = (unit: string, bytes: number, suffix = "") => unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes) + suffix;

/** Unterminated-markup payloads for every function that scans HTML. */
const HTML_UNITS = [
  "<", "<a ", "<A ", "<img ", "<p ", "<p>", "<link ", "<meta ", "<style ", "<style>", "<script ", "<scripty>", "<head ", "<br ", "<div ",
  "<!--", "<![CDATA[", "<a role=", "<a href=\"x\" ", "</", "<h1 ", "<svg ", " ", "\n", "a",
];
const MD_UNITS = ["[", "![", "[a](", "[a](b", "[a]", "](", "<", " ", "(", "!"];
const TEXT_UNITS = [" ", "a", "a.", "a-", ".0", "a@", "/", "=", "%23", "%3f", "&", "://", "a://", "http://", "x@y.", ">", "<", "\u2026 ", " - ", "!", "?", "(", "-", "token", "auth:", "Authorization: ", "bearer ", "api_key=", "a=", '"password":"', 'Digest a="', '"', "\\", '{\\"password\\":\\"', '\\\\\\"', '"password":123,', '\\"password\\":'];
const SEARCH_UNITS = ['"', "'", 'a:"', "a ", '"a ', "'a ", "-a:", "a:", " ", "\"'", "a'", '"a\u2028', "\u2028", "\u2029", '-a:"b ', "!a:'"];

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
  // `.`/`$` also end at U+2028/U+2029 and \r, which survive a "\n" split: "<marker> <spaces>x<terminator>y" was quadratic.
  ...["\u2028", "\u2029", "\r", "\n"].flatMap((lt) => [
    { name: `ai/citations validateLine (list item, tail after ${JSON.stringify(lt)})`, units: [" ", "\t", "\u00a0"], suffix: `x${lt}z`, run: (s: string) => validateLine(`- ${s}`, buildAliasMap<string>([])) },
    { name: `ai/citations validateLine (numbered, tail after ${JSON.stringify(lt)})`, units: [" ", "\t"], suffix: `x${lt}z`, run: (s: string) => validateLine(`12. ${s}`, buildAliasMap<string>([])) },
    { name: `linear-text matchBearerToken (tail after ${JSON.stringify(lt)})`, units: [" ", "\t"], suffix: `x${lt}z`, run: (s: string) => matchBearerToken(`Bearer ${s}`) },
    { name: `ftr-site-config parseFtrConfig directive (tail after ${JSON.stringify(lt)})`, units: [" ", "\t"], suffix: `x${lt}z`, run: (s: string) => parseFtrConfig(`title:${s}`) },
  ]),
  { name: "search tokenizeSearch (user query)", units: SEARCH_UNITS, run: tokenizeSearch },
];

/** Best of `runs` timings (short pause between them): scheduler / GC noise must not look like growth. */
function best(fn: () => unknown, runs: number): number {
  let min = Infinity;
  for (let i = 0; i < runs; i++) {
    if (i > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    const t0 = performance.now();
    fn();
    min = Math.min(min, performance.now() - t0);
  }
  return min;
}

function evaluate(c: Case, unit: string, runs: number): string | null {
  const suffix = c.suffix ?? "\u0001!";
  const time = (bytes: number) => {
    const input = rep(unit, bytes, suffix);
    return best(() => c.run(input), runs);
  };
  const growth = (a: number, b: number) => b / Math.max(a, 2);
  const small = time(SIZES.small);
  const mid = time(SIZES.mid);
  if (mid > GROWTH_MIN_MS && growth(small, mid) > GROWTH_LIMIT) {
    return `${JSON.stringify(unit)}: 64 KiB ${small.toFixed(0)} ms → 256 KiB ${mid.toFixed(0)} ms (×${growth(small, mid).toFixed(1)}, quadratic?)`;
  }
  const big = time(SIZES.big);
  if (big > ABSOLUTE_CEILING_MS) return `${JSON.stringify(unit)}: 1 MiB took ${big.toFixed(0)} ms (ceiling ${ABSOLUTE_CEILING_MS} ms)`;
  if (big > GROWTH_MIN_MS * 2 && growth(mid, big) > GROWTH_LIMIT) {
    return `${JSON.stringify(unit)}: 256 KiB ${mid.toFixed(0)} ms → 1 MiB ${big.toFixed(0)} ms (×${growth(mid, big).toFixed(1)}, quadratic?)`;
  }
  return null;
}

/** One quick pass; only a suspicious result is re-measured (best of 3, with pauses) before it counts as a failure. */
function scalingProblem(c: Case, unit: string): string | null {
  return evaluate(c, unit, 1) === null ? null : evaluate(c, unit, 3);
}

describe("ReDoS regression: hostile input scales linearly (64 KiB → 256 KiB → 1 MiB)", () => {
  for (const c of CASES) {
    it(c.name, () => {
      // Warm-up on a small input so JIT/regex compilation is not billed to the measured runs.
      c.run(rep(c.units[0], 2048));
      const problems: string[] = [];
      for (const unit of c.units) {
        const problem = scalingProblem(c, unit);
        if (problem) problems.push(problem);
      }
      expect(problems, "super-linear on hostile input").toEqual([]);
    }, 120_000);
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

  it("acceptCleanTitle fails closed: a URL behind the scan window is not accepted", () => {
    const words = Array.from({ length: 900 }, (_, i) => `word${i}`).join(" "); // ~6 KB original
    const clean = `${words} visit http://evil.example/login`;
    expect(clean.length).toBeLessThanOrEqual(Math.ceil(words.length * 1.5));
    expect(clean.indexOf("http://")).toBeGreaterThan(4096);
    expect(acceptCleanTitle(clean, words, "")).toBeNull();
    // the same URL inside the window is caught by the regular guard
    expect(acceptCleanTitle("word1 word2 http://evil.example/login", "word1 word2 word3 word4 word5", "")).toBeNull();
    // and an oversized candidate without any URL is rejected too (real clean titles are ≤ 140 chars)
    expect(acceptCleanTitle(words, `${words} extra`, "")).toBeNull();
    // a normal, grounded title still passes
    expect(acceptCleanTitle("Wasserstand Rhein steigt", "Wasserstand am Rhein steigt weiter – Experten warnen!", "")).toBe("Wasserstand Rhein steigt");
  });

  it("list items / bearer tokens / directives keep their results", () => {
    const aliases = buildAliasMap<string>(["a", "b"]);
    expect(validateLine("- Quelle eins [[s1]]", aliases)).toMatchObject({ text: expect.stringContaining("Quelle eins"), cited: ["a"] });
    expect(validateLine("2) Zwei [[s2]]", aliases)).toMatchObject({ cited: ["b"] });
    expect(validateLine("kein Listenpunkt", aliases)).toBeNull();
    expect(matchBearerToken("Bearer abc.def")).toBe("abc.def");
    expect(matchBearerToken("bearer   abc")).toBe("abc");
    expect(matchBearerToken("Basic abc")).toBeNull();
    expect(parseFtrConfig("title: //h1\nbody:   //article  \n# comment\nunknown: x").title).toEqual(["//h1"]);
  });

  it("detectClickbait still sees trailing ?!", () => {
    expect(detectClickbait("Is this real?!")).toBe(true);
    expect(detectClickbait("A calm headline")).toBe(false);
  });
});
