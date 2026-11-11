// Readable-content extraction engine.
//
// Given raw article HTML, produces clean, sanitized content in both HTML and
// Markdown form, suitable for storage/display as an article's "readable"
// full-text version.
//
// Strategy: an ensemble of extractors (bundled FTR site rule, Defuddle,
// Readability, extractus, JSON-LD articleBody) whose candidates are all scored
// by the generic quality gate in lib/extraction-quality.ts; the best one wins.
// Each extractor is wrapped in try/catch so a thrown error from one library
// only removes that candidate rather than failing the whole request.
//
// This module is intentionally split into a pure function
// (`extractReadableContent`, takes HTML, no I/O — easy to unit test) and an
// SSRF-safe fetch + escalation wrapper (`fetchAndExtractReadable`).

import { JSDOM } from "jsdom";
import Defuddle from "defuddle";
import { Readability } from "@mozilla/readability";
import { extractFromHtml } from "@extractus/article-extractor";
import { getSanitizer } from "@/lib/sanitize-html";
import { htmlToMarkdown } from "@/lib/html-to-markdown";
import { fetchTextWithSsrfProtection, isTrustedFeedFetchingAllowed } from "@/lib/ssrf";
import { stripStyleBlocks } from "@/lib/html-utils";
import { findFtrConfigForUrl, applyFtrConfig } from "@/lib/ftr-site-config";
import { renderViaSidecar } from "@/lib/render-sidecar";
import { fetchViaHostedApiDetailed, getHostedFetchConfigForUser, HostedFetchRateLimitedError } from "@/lib/hosted-fetch";
import { renderMarkdownToHtml } from "@/lib/markdown-render";
import type { MeteredAiConfig } from "@/lib/ai-summary";
import { extractArticleWithAi } from "@/lib/ai-extraction";
import { normalizeLazyMedia } from "@/lib/lazy-media";
import { htmlToPlainText } from "@/lib/article-kind";
import {
  assessExtraction,
  decideFullText,
  isBetterCandidate,
  trimEdgeBoilerplate,
  type ExtractionQuality,
} from "@/lib/extraction-quality";
import { classifyFetchFailure, recordHostFailure, recordHostSuccess } from "@/lib/host-backoff";

export type ExtractionResult = {
  html: string | null; // sanitized, cleaned article HTML (null if extraction failed)
  markdown: string | null; // htmlToMarkdown(html) (null if failed)
  title: string | null;
  byline: string | null;
  excerpt: string | null;
  wordCount: number;
  extractedBy: "ftr" | "defuddle" | "readability" | "extractus" | "jsonld" | "ai" | "hosted" | "none";
  // Generic quality assessment of `html` (lib/extraction-quality.ts); null when nothing was extracted.
  quality: ExtractionQuality | null;
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

/** Parses the page once, normalizes lazy images, and serializes it back for the extractors. */
function normalizePageHtml(html: string, url: string): { html: string; document: Document } {
  const dom = new JSDOM(html, { url });
  normalizeLazyMedia(dom.window.document, url);
  return { html: dom.serialize(), document: dom.window.document };
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
export async function extractReadableContent(rawHtml: string, url: string): Promise<ExtractionResult> {
  const stripped = stripStyleBlocks(rawHtml);
  let html = stripped;
  let titleDocument: Document | null = null;
  try {
    const normalized = normalizePageHtml(stripped, url);
    html = normalized.html;
    titleDocument = normalized.document;
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
  add(tryDefuddle(new JSDOM(html, { url }).window.document, url), "defuddle");
  add(tryReadability(new JSDOM(html, { url }).window.document), "readability");

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
      title = fallbackTitle(titleDocument ?? new JSDOM(html, { url }).window.document);
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

/** Builds an ExtractionResult from a Markdown-native tier's output (hosted-API or AI extraction). */
async function buildResultFromMarkdown(
  markdown: string,
  title: string | null,
  extractedBy: "hosted" | "ai",
): Promise<ExtractionResult> {
  const html = await renderMarkdownToHtml(markdown);
  return {
    html,
    markdown,
    title,
    byline: null,
    excerpt: null,
    wordCount: countWords(html),
    extractedBy,
    quality: assessExtraction(html),
  };
}

export type FetchAndExtractReadableOptions = {
  // When set, a hosted BYOK connector (M7-T3, Jina Reader / Firecrawl Cloud)
  // is tried as the final fallback if configured for this user AND the
  // in-process + sidecar tiers didn't produce a good result. Omit to skip this
  // tier entirely (e.g. unattended background sync, where sending a user's
  // articles to a third party without an explicit per-call opt-in would be
  // a silent cost/privacy surprise — see `contentFetchAutoUse`).
  userId?: string;
  // M6: per-feed opt-in AI-extraction fallback. When set, and the in-process
  // deterministic tiers found nothing good on the directly-fetched HTML, the same
  // HTML is sent to this BYOK model to extract the article before falling
  // through to the (slower, whole-page-re-fetching) render sidecar. Callers
  // must only set this for feeds with `fullTextMode === "ai"` — it spends the
  // user's own AI tokens per article.
  aiExtraction?: MeteredAiConfig;
  // The content the article already has (the feed item, sanitized HTML). When
  // given, a result that would not be accepted over it (`decideFullText`) is
  // treated as "not good enough yet" and the escalation chain continues.
  baselineHtml?: string | null;
  // Gate mode used together with `baselineHtml` (see `decideFullText`).
  gate?: "auto" | "manual";
  // Shared, mutable per-sync budget for the costly escalation tiers. Each tier
  // runs only while its counter is > 0 and decrements it when it actually runs.
  // Omitted (manual fetch): no limit beyond the tiers' own opt-ins.
  escalationBudget?: EscalationBudget;
};

export type EscalationBudget = { ai: number; render: number; hosted: number };

/** Takes one unit of `tier` from the budget; true when the tier may run. */
function takeBudget(budget: EscalationBudget | undefined, tier: keyof EscalationBudget): boolean {
  if (!budget) return true;
  if (budget[tier] <= 0) return false;
  budget[tier]--;
  return true;
}

// Feed items with at least this much plain text are "substantial" (see goodEnough).
const SUBSTANTIAL_FEED_TEXT_LENGTH = 1000;

type Transport = "impit" | "plain";

// Which transport last worked for a host after the other one failed (TTL'd,
// in-memory). Purely observed behaviour, never a hand-maintained host list.
const TRANSPORT_MEMORY_TTL_MS = 6 * 60 * 60 * 1000;
const preferredTransport = new Map<string, { transport: Transport; until: number }>();

function hostKey(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function transportOrder(url: string): Transport[] {
  const isHttps = url.toLowerCase().startsWith("https:");
  if (!isHttps) return ["plain"]; // impit only ever applies to https
  const host = hostKey(url);
  const memo = host ? preferredTransport.get(host) : undefined;
  if (memo && memo.until > Date.now() && memo.transport === "plain") return ["plain", "impit"];
  return ["impit", "plain"];
}

function rememberTransport(url: string, transport: Transport) {
  const host = hostKey(url);
  if (!host) return;
  if (preferredTransport.size > 2_000) preferredTransport.clear();
  preferredTransport.set(host, { transport, until: Date.now() + TRANSPORT_MEMORY_TTL_MS });
}

/** Test helper. */
export function resetTransportMemory() {
  preferredTransport.clear();
}

async function fetchPage(url: string, transport: Transport): Promise<string> {
  return fetchTextWithSsrfProtection(
    url,
    transport === "plain" ? { headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" } } : {},
    {
      allowInternal: await isTrustedFeedFetchingAllowed(),
      context: "Full-text",
      impersonate: transport === "impit",
      maxBytes: 2 * 1024 * 1024,
      maxRedirects: 5,
      timeoutMs: 12_000,
    },
  );
}

/**
 * SSRF-safe wrapper: fetches `url`'s HTML (subject to the app's SSRF
 * protections) and extracts readable content from it, escalating along a
 * generic chain until a GOOD result is found (not merely a non-empty one):
 *
 *   direct fetch (browser-fingerprint transport) → the other transport
 *   (plain undici ↔ impit; on a block status/network error OR a bad result)
 *   → AI extraction on the fetched HTML (feed opt-in) → render sidecar
 *   (admin-configured) → hosted BYOK API (explicit opt-in).
 *
 * Every tier's result is scored by the same quality gate and the best one is
 * returned. Fetch errors (incl. SSRF blocks) propagate only when no tier
 * produced anything at all. Host failures/successes feed the per-host backoff.
 */
export async function fetchAndExtractReadable(
  url: string,
  options: FetchAndExtractReadableOptions = {},
): Promise<ExtractionResult> {
  let directError: unknown = null;
  let best: ExtractionResult | null = null;
  let firstResult: ExtractionResult | null = null;
  let bestFetchedHtml: string | null = null;
  let lastFetchedHtml: string | null = null;

  const consider = (result: ExtractionResult, fetchedHtml: string | null) => {
    if (!firstResult) firstResult = result;
    if (!result.quality || !result.html) return;
    if (!best?.quality || isBetterCandidate(result.quality, best.quality)) {
      best = result;
      if (fetchedHtml) bestFetchedHtml = fetchedHtml;
    }
  };
  // A good page that is no longer than the feed item only warrants escalation
  // (render / hosted) when the feed item itself is a short teaser — then the
  // page may be withholding the body. A substantial feed item that the page
  // merely repeats will not get better by rendering it in a browser.
  const baselineLength = options.baselineHtml == null ? 0 : htmlToPlainText(options.baselineHtml).length;
  const goodEnough = () => {
    const current = best as ExtractionResult | null;
    if (!current?.quality || current.quality.verdict !== "good") return false;
    if (options.baselineHtml === undefined || baselineLength >= SUBSTANTIAL_FEED_TEXT_LENGTH) return true;
    return decideFullText(current.quality, options.baselineHtml, options.gate ?? "auto").accept;
  };

  const transports = transportOrder(url);
  let anyFetchSucceeded = false;
  for (const [index, transport] of transports.entries()) {
    try {
      const html = await fetchPage(url, transport);
      anyFetchSucceeded = true;
      lastFetchedHtml = html;
      consider(await extractReadableContent(html, url), html);
      if (goodEnough()) {
        if (index > 0) rememberTransport(url, transport);
        break;
      }
    } catch (error) {
      directError ??= error;
      // A permanent failure (404, SSRF refusal, oversized page) won't change
      // with a different TLS fingerprint — don't retry it.
      if (classifyFetchFailure(error).kind === "permanent") break;
    }
  }
  if (anyFetchSucceeded) recordHostSuccess(url);
  else if (directError) recordHostFailure(url, directError);

  // M6: per-feed opt-in AI-extraction, on the already-fetched HTML — before
  // falling to the (slower, whole-page-re-fetching) render sidecar.
  const aiSource = (bestFetchedHtml as string | null) ?? lastFetchedHtml;
  if (!goodEnough() && options.aiExtraction && aiSource && takeBudget(options.escalationBudget, "ai")) {
    const aiResult = await extractArticleWithAi(aiSource, url, options.aiExtraction);
    if (aiResult) consider(await buildResultFromMarkdown(aiResult.content, aiResult.title, "ai"), null);
  }

  // Render sidecar (M7-T2, admin-configured): client-only pages, consent/bot
  // walls a real browser gets past, or a direct fetch that was blocked outright.
  // Every attempt counts against the per-sync budget (a no-op when no sidecar is configured).
  if (!goodEnough() && takeBudget(options.escalationBudget, "render")) {
    const rendered = await renderViaSidecar(url, { context: "Full-text" });
    if (rendered) consider(await extractReadableContent(rendered, url), rendered);
  }

  // Last resort: the user's own hosted-API BYOK connector (M7-T3), for pages
  // that beat even a real rendered browser (active anti-bot challenges).
  let hostedRateLimited = false;
  if (!goodEnough() && options.userId) {
    const hostedConfig = await getHostedFetchConfigForUser(options.userId);
    if (hostedConfig && takeBudget(options.escalationBudget, "hosted")) {
      const outcome = await fetchViaHostedApiDetailed(url, hostedConfig);
      if (outcome.ok) consider(await buildResultFromMarkdown(outcome.result.content, outcome.result.title, "hosted"), null);
      else hostedRateLimited = outcome.rateLimited;
    }
  }

  const finalBest = best as ExtractionResult | null;
  if (finalBest) return finalBest;
  const empty = firstResult as ExtractionResult | null;
  if (empty) return empty; // the (empty) in-process result
  // Rate-limiting on the last-resort tier is worth telling the caller apart
  // from an ordinary fetch failure (see fetchFullText in app/actions/feeds.ts),
  // since "try again later / add your own key" is actionable advice a plain
  // "couldn't fetch" message can't give.
  if (hostedRateLimited) throw new HostedFetchRateLimitedError();
  throw directError ?? new Error("Full-text fetch failed");
}
