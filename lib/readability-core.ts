// Pure readable-content extraction (no I/O): the ensemble of extractors
// (bundled FTR site rule, Defuddle, Readability, extractus, JSON-LD
// articleBody) whose candidates are all scored by the generic quality gate in
// lib/extraction-quality.ts; the best one wins. Each extractor is wrapped in
// try/catch so a thrown error from one library only removes that candidate
// rather than failing the whole request.
//
// Parses untrusted page HTML with jsdom, so it only runs inside the HTML
// worker pool (lib/html-worker) — production code calls the worker-backed
// `extractReadableContent` in lib/readability-extract.ts, never this module.

import { JSDOM } from "jsdom";
import Defuddle from "defuddle";
import { Readability } from "@mozilla/readability";
import { extractFromHtml } from "@extractus/article-extractor";
import { getSanitizer } from "@/lib/sanitize-html";
import { htmlToMarkdown } from "@/lib/html-to-markdown";
import { stripStyleBlocks } from "@/lib/html-utils";
import { findFtrConfigForUrl, applyFtrConfig } from "@/lib/ftr-site-config";
import { normalizeLazyMedia } from "@/lib/lazy-media";
import { collapseNewlineWhitespace, stripTags } from "@/lib/linear-text";
import { countWords, type ExtractionResult } from "@/lib/readability-types";
import { assessExtraction, isBetterCandidate, type ExtractionQuality } from "@/lib/extraction-quality";
import { trimEdgeBoilerplate } from "@/lib/extraction-trim-core";

export type { ExtractionResult } from "@/lib/readability-types";


// Below this many characters of plain text, Defuddle's result is treated as
// too thin to be useful and we fall back to Readability instead.
const MIN_CONTENT_TEXT_LENGTH = 200;

// Defuddle runs only below these (see extractReadableContentInProcess). Real
// pages in the fixture corpus: at most ~7 500 elements (a homepage; articles
// stay well under 3 000) and an average element depth of 9–16.
export const DEFUDDLE_MAX_ELEMENTS = 6_000;
export const DEFUDDLE_MAX_AVERAGE_DEPTH = 32;

/** Element count and average depth within Defuddle's budget? One iterative walk, no recursion. */
function defuddleAffordable(document: Document): boolean {
  const root = document.documentElement;
  if (!root) return false;
  let elements = 0;
  let depthSum = 0;
  const stack: Array<[Element, number]> = [[root, 1]];
  while (stack.length > 0) {
    const [el, depth] = stack.pop()!;
    elements++;
    depthSum += depth;
    if (elements > DEFUDDLE_MAX_ELEMENTS) return false;
    for (let child = el.firstElementChild; child; child = child.nextElementSibling) stack.push([child, depth + 1]);
  }
  return depthSum / elements <= DEFUDDLE_MAX_AVERAGE_DEPTH;
}

function textLength(html: string): number {
  return stripTags(html)
    .replace(/\s+/g, " ")
    .trim().length;
}


/** Removes every inline `style="…"` attribute from an HTML string. */
function stripInlineStyleAttributes(html: string): string {
  return html.replace(/\sstyle\s*=\s*(".*?"|'.*?')/gi, "");
}

/**
 * Sanitizes extracted article content, never throwing. jsdom's CSS engine can
 * throw on modern CSS (e.g. `var()` inside a `border`/`outline` shorthand) —
 * previously seen inside `<style>` blocks (fixed by stripping those before
 * parsing, see `stripStyleBlocks`) but the same class of crash can also come
 * from an inline `style="…"` attribute the source page carries on some
 * element within the extracted subtree. Retry once with inline styles
 * stripped entirely before giving up — the reader applies its own
 * typography, so losing arbitrary source styling here costs nothing — and
 * fall back to `null` (never throw) if sanitizing still fails.
 */
function sanitizeExtractedContent(
  DOMPurify: Awaited<ReturnType<typeof getSanitizer>>,
  rawContent: string,
): string | null {
  try {
    return DOMPurify.sanitize(rawContent, { ADD_ATTR: ["target", "rel"] });
  } catch {
    try {
      return DOMPurify.sanitize(stripInlineStyleAttributes(rawContent), { ADD_ATTR: ["target", "rel"] });
    } catch {
      return null;
    }
  }
}

/** Best-effort title lookup from the raw document, used when both extractors fail. */
function fallbackTitle(document: Document): string | null {
  const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content");
  if (ogTitle && ogTitle.trim()) return ogTitle.trim();
  const titleTag = document.title;
  if (titleTag && titleTag.trim()) return titleTag.trim();
  return null;
}

type RawExtraction = {
  content: string;
  title: string | null;
  byline: string | null;
  excerpt: string | null;
};

// Kill-switch: set FEEDFERRET_DISABLE_FTR=1 to bypass the bundled per-site
// ftr rules and fall straight through to the generic Defuddle/Readability path.
const FTR_DISABLED = process.env.FEEDFERRET_DISABLE_FTR === "1";

/**
 * First extraction tier: if a bundled FiveFilters ftr-site-config rule matches
 * this URL's host, apply its XPath rules to pull the article body/title/author
 * directly. Returns null when no rule matches or it yields too little — callers
 * then fall through to the generic heuristics. Never throws.
 */
function tryFtr(rawHtml: string, url: string): RawExtraction | null {
  if (FTR_DISABLED) return null;
  try {
    const config = findFtrConfigForUrl(url);
    if (!config) return null;
    const result = applyFtrConfig(rawHtml, url, config, MIN_CONTENT_TEXT_LENGTH);
    if (!result) return null;
    return {
      content: result.content,
      title: result.title,
      byline: result.author,
      excerpt: null,
    };
  } catch {
    return null;
  }
}

/** Runs Defuddle against a jsdom document. Returns null on failure/empty result. */
function tryDefuddle(document: Document, url: string): RawExtraction | null {
  try {
    const result = new Defuddle(document, { url, useAsync: false }).parse();
    if (!result?.content || textLength(result.content) < MIN_CONTENT_TEXT_LENGTH) return null;
    return {
      content: result.content,
      title: result.title || null,
      byline: result.author || null,
      excerpt: result.description || null,
    };
  } catch {
    return null;
  }
}

const ARTICLE_LD_TYPES = new Set([
  "Article",
  "NewsArticle",
  "BlogPosting",
  "Report",
  "ReportageNewsArticle",
  "TechArticle",
  "ScholarlyArticle",
  "AdvertiserContentArticle",
]);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Wrap a plain-text article body (as found in JSON-LD) into paragraph HTML. */
function textToParagraphs(text: string): string {
  return text
    .split(/\n{2,}|\r\n{2,}/)
    .map((block) => collapseNewlineWhitespace(block).trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block)}</p>`)
    .join("\n");
}

/**
 * Many news sites (Wired/Condé Nast, etc.) truncate or paywall the article
 * body in the visible DOM but still ship the FULL text in schema.org
 * structured data (`<script type="application/ld+json">` → `articleBody`) for
 * SEO. When the DOM extractors come up thin, this recovers that full text.
 * Returns the longest `articleBody` found, or null.
 */
function extractJsonLdArticleBody(document: Document): string | null {
  let best: string | null = null;
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of Array.from(scripts)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent || "");
    } catch {
      continue;
    }
    // JSON-LD can be a single object, an array, or use an @graph wrapper.
    const nodes: unknown[] = [];
    const stack: unknown[] = [parsed];
    while (stack.length) {
      const node = stack.pop();
      if (Array.isArray(node)) stack.push(...node);
      else if (node && typeof node === "object") {
        nodes.push(node);
        const graph = (node as { "@graph"?: unknown })["@graph"];
        if (Array.isArray(graph)) stack.push(...graph);
      }
    }
    for (const node of nodes) {
      const obj = node as { "@type"?: unknown; articleBody?: unknown };
      const types = Array.isArray(obj["@type"]) ? obj["@type"] : [obj["@type"]];
      const isArticle = types.some((t) => typeof t === "string" && ARTICLE_LD_TYPES.has(t));
      if (!isArticle) continue;
      const body = obj.articleBody;
      if (typeof body === "string" && body.trim().length > (best?.length ?? 0)) {
        best = body.trim();
      }
    }
  }
  return best;
}

/** Runs Mozilla Readability against a jsdom document. Returns null on failure/empty result. */
function tryReadability(document: Document): RawExtraction | null {
  try {
    const result = new Readability(document).parse();
    if (!result?.content || textLength(result.content) < MIN_CONTENT_TEXT_LENGTH) return null;
    return {
      content: result.content,
      title: result.title || null,
      byline: result.byline || null,
      excerpt: result.excerpt || null,
    };
  } catch {
    return null;
  }
}

/**
 * Fourth-tier fallback: @extractus/article-extractor uses a different
 * heuristic (unfluff-derived scoring) than Defuddle/Readability, so it
 * occasionally succeeds on a layout that trips up both of them. Runs last,
 * before the JSON-LD structured-data recovery.
 */
async function tryArticleExtractor(html: string, url: string): Promise<RawExtraction | null> {
  try {
    const result = await extractFromHtml(html, url, { contentLengthThreshold: MIN_CONTENT_TEXT_LENGTH });
    if (!result?.content || textLength(result.content) < MIN_CONTENT_TEXT_LENGTH) return null;
    return {
      content: result.content,
      title: result.title || null,
      byline: result.author || null,
      excerpt: result.description || null,
    };
  } catch {
    return null;
  }
}

type Candidate = {
  raw: RawExtraction;
  extractedBy: ExtractionResult["extractedBy"];
};

/** Sanitizes, edge-trims and scores one raw candidate. Null when sanitizing fails. */
function finalizeCandidate(
  DOMPurify: Awaited<ReturnType<typeof getSanitizer>>,
  candidate: Candidate,
): { candidate: Candidate; html: string; quality: ExtractionQuality } | null {
  const clean = sanitizeExtractedContent(DOMPurify, candidate.raw.content);
  if (clean === null) return null;
  const trimmed = trimEdgeBoilerplate(clean);
  return { candidate, html: trimmed, quality: assessExtraction(trimmed) };
}

// A bundled FTR rule is hand-curated for its host, so when its result is about
// as good as the best generic extractor's (within this factor) it wins the tie.
const FTR_TIE_FACTOR = 0.85;

function pickBest(
  scored: { candidate: Candidate; html: string; quality: ExtractionQuality }[],
): { candidate: Candidate; html: string; quality: ExtractionQuality } | null {
  let best: (typeof scored)[number] | null = null;
  for (const entry of scored) {
    if (!best || isBetterCandidate(entry.quality, best.quality)) best = entry;
  }
  if (!best) return null;
  const ftr = scored.find((entry) => entry.candidate.extractedBy === "ftr");
  if (
    ftr &&
    ftr !== best &&
    ftr.quality.verdict === best.quality.verdict &&
    ftr.quality.score >= best.quality.score * FTR_TIE_FACTOR
  ) {
    return ftr;
  }
  return best;
}

function noneResult(title: string | null): ExtractionResult {
  return {
    html: null,
    markdown: null,
    title,
    byline: null,
    excerpt: null,
    wordCount: 0,
    extractedBy: "none",
    quality: null,
  };
}

/**
 * Runs `fn` on a fresh document of `html` and closes its window afterwards:
 * every extractor gets its own DOM (Readability mutates its input), and
 * closing frees the tree right away instead of leaving several page-sized DOMs
 * for the GC (the worker's memory watchdog counts uncollected garbage too).
 */
function withDocument<T>(html: string, url: string, fn: (document: Document) => T): T {
  const dom = new JSDOM(html, { url });
  try {
    return fn(dom.window.document);
  } finally {
    dom.window.close();
  }
}

/**
 * Parses the page once, normalizes lazy images and serializes it back for the
 * extractors. Everything later steps need from this DOM (the fallback title,
 * Defuddle's size check) is read here and the window is closed right away, so
 * the page-sized tree does not stay alive next to every extractor's own copy.
 */
function normalizePageHtml(html: string, url: string): { html: string; title: string | null; defuddleOk: boolean } {
  const dom = new JSDOM(html, { url });
  try {
    const document = dom.window.document;
    normalizeLazyMedia(document, url);
    return { html: dom.serialize(), title: fallbackTitle(document), defuddleOk: defuddleAffordable(document) };
  } finally {
    dom.window.close();
  }
}

/**
 * Extracts readable article content from raw HTML. Pure/testable: takes HTML
 * directly and does not perform any network I/O.
 *
 * Runs the extractors as an ENSEMBLE rather than a first-hit chain: a bundled
 * FTR site rule, Defuddle and Readability always run; extractus and the JSON-LD
 * `articleBody` recovery join when those come up short. Every candidate is
 * sanitized, edge-trimmed (`trimEdgeBoilerplate`) and scored by the generic
 * quality gate (`assessExtraction`); the best one wins, so a matching FTR rule
 * that yields a consent wall or nothing no longer short-circuits a good generic
 * extraction. Lazy-loaded images are normalized before any extractor runs.
 */
export async function extractReadableContentInProcess(rawHtml: string, url: string): Promise<ExtractionResult> {
  const stripped = stripStyleBlocks(rawHtml);
  let html = stripped;
  let pageTitle: string | null = null;
  let defuddleOk = false;
  let normalizedOk = false;
  try {
    const normalized = normalizePageHtml(stripped, url);
    html = normalized.html;
    pageTitle = normalized.title;
    defuddleOk = normalized.defuddleOk;
    normalizedOk = true;
  } catch {
    // jsdom could not parse/serialize: extractors still get the stripped HTML.
  }

  const DOMPurify = await getSanitizer();
  const scored: { candidate: Candidate; html: string; quality: ExtractionQuality }[] = [];
  const add = (raw: RawExtraction | null, extractedBy: ExtractionResult["extractedBy"]) => {
    if (!raw) return;
    const entry = finalizeCandidate(DOMPurify, { raw, extractedBy });
    if (entry) scored.push(entry);
  };

  // FTR is one candidate among several, never a short-circuit.
  add(tryFtr(html, url), "ftr");
  // Readability mutates the document it's given, so every extractor gets its
  // own fresh JSDOM and one attempt can never corrupt another's input.
  // Defuddle's cost grows much faster than linearly with the element count
  // and the nesting depth (10 000 flat <p>s: ~16 s; 2 000 <p>s under 60
  // <div>s: ~22 s; a 7 500-element news homepage: ~3.7 s, longer than every
  // other extractor together), so on very large or unusually deep documents
  // it is skipped and Readability / extractus / JSON-LD decide.
  if (defuddleOk) {
    add(withDocument(html, url, (document) => tryDefuddle(document, url)), "defuddle");
  }
  add(withDocument(html, url, (document) => tryReadability(document)), "readability");

  let best = pickBest(scored);
  if (!best || best.quality.verdict !== "good") {
    add(await tryArticleExtractor(html, url), "extractus");
    best = pickBest(scored);
  }

  // JSON-LD full-text recovery: only when the DOM extraction is missing or
  // thin (paywalled/truncated bodies), since when the DOM has a real article
  // its structured HTML (headings, images, links) beats JSON-LD's plain text.
  const domTextLen = best ? best.quality.textLength : 0;
  if (domTextLen < 1200 || (best && best.quality.verdict !== "good")) {
    const jsonLdDom = new JSDOM(html, { url });
    const jsonLdBody = extractJsonLdArticleBody(jsonLdDom.window.document);
    if (jsonLdBody && jsonLdBody.length >= MIN_CONTENT_TEXT_LENGTH && jsonLdBody.length > domTextLen * 1.5) {
      add(
        {
          content: textToParagraphs(jsonLdBody),
          title: best?.candidate.raw.title ?? fallbackTitle(jsonLdDom.window.document),
          byline: best?.candidate.raw.byline ?? null,
          excerpt: best?.candidate.raw.excerpt ?? null,
        },
        "jsonld",
      );
      best = pickBest(scored);
    }
  }

  if (!best) {
    // All strategies failed (or every candidate's sanitize crashed) — still
    // surface whatever title we can find.
    let title: string | null = null;
    try {
      title = normalizedOk ? pageTitle : withDocument(html, url, fallbackTitle);
    } catch {
      title = null;
    }
    return noneResult(title);
  }

  // Markdown conversion is a secondary output (only consulted for feeds whose
  // configured content format is Markdown); a crash converting it must not
  // discard the html we already have.
  let markdown: string | null;
  try {
    markdown = htmlToMarkdown(best.html);
  } catch {
    markdown = null;
  }

  // Title/byline: prefer the winner's, fall back to any other candidate's.
  const title = best.candidate.raw.title ?? scored.find((s) => s.candidate.raw.title)?.candidate.raw.title ?? null;
  return {
    html: best.html,
    markdown,
    title,
    byline: best.candidate.raw.byline,
    excerpt: best.candidate.raw.excerpt,
    wordCount: countWords(best.html),
    extractedBy: best.candidate.extractedBy,
    quality: best.quality,
  };
}
