// Readable-content extraction engine.
//
// Given raw article HTML, produces clean, sanitized content in both HTML and
// Markdown form, suitable for storage/display as an article's "readable"
// full-text version.
//
// Strategy: try Defuddle first (more forgiving, richer metadata), and fall
// back to Mozilla Readability if Defuddle's result is empty/too short. Both
// extractors are wrapped in try/catch so a thrown error from either library
// falls through to the next strategy rather than failing the whole request.
//
// This module is intentionally split into a pure function
// (`extractReadableContent`, takes HTML, no I/O — easy to unit test) and a
// thin SSRF-safe fetch wrapper (`fetchAndExtractReadable`).

import { JSDOM } from "jsdom";
import Defuddle from "defuddle";
import { Readability } from "@mozilla/readability";
import { getSanitizer } from "@/lib/sanitize-html";
import { htmlToMarkdown } from "@/lib/html-to-markdown";
import { fetchTextWithSsrfProtection, isTrustedFeedFetchingAllowed } from "@/lib/ssrf";
import { stripStyleBlocks } from "@/lib/html-utils";

export type ExtractionResult = {
  html: string | null; // sanitized, cleaned article HTML (null if extraction failed)
  markdown: string | null; // htmlToMarkdown(html) (null if failed)
  title: string | null;
  byline: string | null;
  excerpt: string | null;
  wordCount: number;
  extractedBy: "defuddle" | "readability" | "jsonld" | "none";
};

// Below this many characters of plain text, Defuddle's result is treated as
// too thin to be useful and we fall back to Readability instead.
const MIN_CONTENT_TEXT_LENGTH = 200;

function textLength(html: string): number {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

function countWords(html: string): number {
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.split(" ").length : 0;
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
    .map((block) => block.replace(/\s*\n\s*/g, " ").trim())
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
 * Extracts readable article content from raw HTML. Pure/testable: takes HTML
 * directly and does not perform any network I/O.
 */
export async function extractReadableContent(rawHtml: string, url: string): Promise<ExtractionResult> {
  const html = stripStyleBlocks(rawHtml);
  // Readability mutates the document it's given, so run Defuddle against its
  // own fresh JSDOM and (if needed) parse a second fresh JSDOM for
  // Readability, so one extractor's attempt can never corrupt the other's
  // input.
  const defuddleDom = new JSDOM(html, { url });
  const defuddleResult = tryDefuddle(defuddleDom.window.document, url);

  let raw: RawExtraction | null = defuddleResult;
  let extractedBy: ExtractionResult["extractedBy"] = defuddleResult ? "defuddle" : "none";

  if (!raw) {
    const readabilityDom = new JSDOM(html, { url });
    const readabilityResult = tryReadability(readabilityDom.window.document);
    if (readabilityResult) {
      raw = readabilityResult;
      extractedBy = "readability";
    }
  }

  // JSON-LD full-text recovery: only when the DOM extraction is missing or
  // thin (paywalled/truncated bodies), since when the DOM has a real article
  // its structured HTML (headings, images, links) beats JSON-LD's plain text.
  const domTextLen = raw ? textLength(raw.content) : 0;
  if (domTextLen < 1200) {
    const jsonLdDom = new JSDOM(html, { url });
    const jsonLdBody = extractJsonLdArticleBody(jsonLdDom.window.document);
    if (jsonLdBody && jsonLdBody.length >= MIN_CONTENT_TEXT_LENGTH && jsonLdBody.length > domTextLen * 1.5) {
      raw = {
        content: textToParagraphs(jsonLdBody),
        title: raw?.title ?? fallbackTitle(jsonLdDom.window.document),
        byline: raw?.byline ?? null,
        excerpt: raw?.excerpt ?? null,
      };
      extractedBy = "jsonld";
    }
  }

  if (!raw) {
    // All strategies failed — still surface whatever title we can find.
    const titleDom = new JSDOM(html, { url });
    return {
      html: null,
      markdown: null,
      title: fallbackTitle(titleDom.window.document),
      byline: null,
      excerpt: null,
      wordCount: 0,
      extractedBy: "none",
    };
  }

  const DOMPurify = await getSanitizer();
  const clean = DOMPurify.sanitize(raw.content, { ADD_ATTR: ["target", "rel"] });
  const markdown = htmlToMarkdown(clean);

  return {
    html: clean,
    markdown,
    title: raw.title,
    byline: raw.byline,
    excerpt: raw.excerpt,
    wordCount: countWords(clean),
    extractedBy,
  };
}

/**
 * SSRF-safe wrapper: fetches `url`'s HTML (subject to the app's SSRF
 * protections) and extracts readable content from it. Fetch errors
 * (including SSRF blocks) are propagated to the caller, not swallowed.
 */
export async function fetchAndExtractReadable(url: string): Promise<ExtractionResult> {
  const html = await fetchTextWithSsrfProtection(
    url,
    {},
    {
      allowInternal: await isTrustedFeedFetchingAllowed(),
      context: "Full-text",
      impersonate: true,
      maxBytes: 2 * 1024 * 1024,
      maxRedirects: 5,
      timeoutMs: 12_000,
    },
  );
  return extractReadableContent(html, url);
}
