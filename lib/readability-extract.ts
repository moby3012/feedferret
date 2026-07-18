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

export type ExtractionResult = {
  html: string | null; // sanitized, cleaned article HTML (null if extraction failed)
  markdown: string | null; // htmlToMarkdown(html) (null if failed)
  title: string | null;
  byline: string | null;
  excerpt: string | null;
  wordCount: number;
  extractedBy: "defuddle" | "readability" | "none";
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
  // Readability mutates the document it's given, so run Defuddle against its
  // own fresh JSDOM and (if needed) parse a second fresh JSDOM for
  // Readability, so one extractor's attempt can never corrupt the other's
  // input.
  const defuddleDom = new JSDOM(rawHtml, { url });
  const defuddleResult = tryDefuddle(defuddleDom.window.document, url);

  let raw: RawExtraction | null = defuddleResult;
  let extractedBy: ExtractionResult["extractedBy"] = defuddleResult ? "defuddle" : "none";

  if (!raw) {
    const readabilityDom = new JSDOM(rawHtml, { url });
    const readabilityResult = tryReadability(readabilityDom.window.document);
    if (readabilityResult) {
      raw = readabilityResult;
      extractedBy = "readability";
    }
  }

  if (!raw) {
    // Both extractors failed — still surface whatever title we can find.
    const titleDom = new JSDOM(rawHtml, { url });
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
