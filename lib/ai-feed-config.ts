// AI feed-config PROPOSAL ENGINE (Phase 2 M4, slice 1).
//
// Given a URL and the user's BYOK AI config, asks the model to propose a
// scraping config (either "fulltext" — a truncated-article page whose full
// body lives on the page — or "pagefeed" — a listing page of many items),
// then validates that proposal through the REAL extraction engine
// (`buildXPathArticles` for pagefeed, a JSDOM query + sanitizer for
// fulltext) before anything is shown or saved. The AI's output is never
// trusted on its own — it only gets to keep a proposal if the real engine
// can actually make something of it.
//
// No UI here (that's slice 2) and no network beyond what's injected via
// `deps` in tests.

import { JSDOM } from "jsdom";
import { type AiConfig, runAiPrompt } from "./ai-summary";
import { buildXPathArticles } from "./feed-fetcher";
import { getSanitizer } from "./sanitize-html";
import { fetchTextWithSsrfProtection, isTrustedFeedFetchingAllowed } from "./ssrf";
import type { SuggestedFieldConfig } from "./page-feed-suggest";

export type { SuggestedFieldConfig };

export type AiFeedProposal =
  | { mode: "fulltext"; fullTextSelector: string; confidence: number; notes?: string }
  | { mode: "pagefeed"; itemConfig: SuggestedFieldConfig; confidence: number; notes?: string };

export type AiFeedValidation = {
  ok: boolean;
  itemCount?: number; // pagefeed: how many items the engine parsed
  sampleTitles?: string[]; // pagefeed preview
  extractedTextLength?: number; // fulltext: length of extracted body text
  error?: string;
};

export type AiFeedConfigResult = { proposal: AiFeedProposal; validation: AiFeedValidation };

const MAX_PROMPT_HTML_CHARS = 8_000;
const PAGEFEED_MIN_ITEMS = 3;
const FULLTEXT_MIN_CHARS = 400;

/**
 * Reduces a raw HTML page to a token-bounded structural snippet: strips the
 * contents of `<script>`/`<style>`/`<svg>`/`<noscript>` and HTML comments,
 * collapses whitespace, and caps the result — while keeping tags/classes/ids
 * so the model can still see the repeating structure of the page.
 */
function reduceHtmlForPrompt(html: string): string {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, " ");
  const withoutNoisyTags = withoutComments.replace(
    /<(script|style|svg|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi,
    " ",
  );
  const collapsed = withoutNoisyTags.replace(/\s+/g, " ").trim();
  return collapsed.slice(0, MAX_PROMPT_HTML_CHARS);
}

/** Builds the strict-JSON prompt asking the model to propose a feed config. */
export function buildFeedConfigPrompt(html: string, url: string): string {
  const snippet = reduceHtmlForPrompt(html);
  return `You are configuring a web-scraping feed reader for the page at ${url}.

Decide whether this page is:
- "fulltext": a single article page whose full body text is present on the page (possibly truncated by a paywall/teaser, but the reader body container is identifiable).
- "pagefeed": a listing page containing many repeating items (a blog index, news list, forum, search results) that should each become a feed entry.

Respond with STRICT JSON only — no prose, no markdown code fences, no explanation outside the JSON object.

For "fulltext" mode, respond with exactly this shape (the selector is a CSS selector for the article body container):
{"mode":"fulltext","fullTextSelector":"article.post-body","confidence":0.9,"notes":"Main article body identified by class."}

For "pagefeed" mode, respond with exactly this shape (selectors are XPath: xPathItem is an absolute path like "//div[...]" selecting each repeating item; the other fields are relative paths starting with ".//", using "@href"/"@datetime"/"@src" to pull attributes):
{"mode":"pagefeed","itemConfig":{"xPathItem":"//div[contains(@class,'post')]","xPathItemTitle":".//h2","xPathItemUri":".//a/@href","xPathItemTimestamp":".//time/@datetime","xPathItemThumbnail":".//img/@src","xPathItemContent":".//p"},"confidence":0.8,"notes":"Repeating post cards under the main list."}

Only include the fields relevant to the chosen mode. "confidence" is a number between 0 and 1. Keep "notes" to one short sentence.

Page HTML (structure preserved, scripts/styles/comments stripped, truncated):
${snippet}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function coerceConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Extracts the JSON object from the model's raw text (tolerating ```json
 * fences and surrounding prose) and strictly validates its shape. Returns
 * `null` on any parse or shape failure — never throws.
 */
export function parseAiFeedProposal(rawText: string): AiFeedProposal | null {
  if (typeof rawText !== "string") return null;

  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText.slice(start, end + 1));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const confidence = coerceConfidence(obj.confidence);
  const notes = isNonEmptyString(obj.notes) ? obj.notes : undefined;

  if (obj.mode === "fulltext") {
    if (!isNonEmptyString(obj.fullTextSelector)) return null;
    return { mode: "fulltext", fullTextSelector: obj.fullTextSelector, confidence, notes };
  }

  if (obj.mode === "pagefeed") {
    const rawItemConfig = obj.itemConfig;
    if (!rawItemConfig || typeof rawItemConfig !== "object") return null;
    const item = rawItemConfig as Record<string, unknown>;
    if (!isNonEmptyString(item.xPathItem)) return null;

    const itemConfig: SuggestedFieldConfig = { xPathItem: item.xPathItem };
    const optionalFields: (keyof SuggestedFieldConfig)[] = [
      "xPathItemTitle",
      "xPathItemUri",
      "xPathItemContent",
      "xPathItemTimestamp",
      "xPathItemThumbnail",
    ];
    for (const field of optionalFields) {
      if (isNonEmptyString(item[field])) itemConfig[field] = item[field] as string;
    }

    return { mode: "pagefeed", itemConfig, confidence, notes };
  }

  return null;
}

async function validatePagefeed(
  itemConfig: SuggestedFieldConfig,
  html: string,
  url: string,
): Promise<AiFeedValidation> {
  try {
    const xpath: Record<string, string> = {};
    for (const [key, value] of Object.entries(itemConfig)) {
      if (value) xpath[key] = value;
    }
    const { articles } = buildXPathArticles(html, url, { xpath }, "text/html");
    const linked = articles.filter((a) => a.link && a.link.trim().length > 0);
    const ok = articles.length >= PAGEFEED_MIN_ITEMS && linked.length > 0;
    const sampleTitles = articles
      .map((a) => a.title)
      .filter((t) => t && t !== "Untitled")
      .slice(0, 5);
    return { ok, itemCount: articles.length, sampleTitles };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to parse pagefeed config" };
  }
}

async function validateFulltext(
  fullTextSelector: string,
  html: string,
  url: string,
): Promise<AiFeedValidation> {
  try {
    const dom = new JSDOM(html, { url });
    let element: Element | null;
    try {
      element = dom.window.document.querySelector(fullTextSelector);
    } catch {
      return { ok: false, error: `Invalid CSS selector: ${fullTextSelector}` };
    }
    if (!element) {
      return { ok: false, error: `Selector matched nothing: ${fullTextSelector}` };
    }

    const sanitizer = await getSanitizer();
    const sanitized = sanitizer.sanitize(element.innerHTML);
    const plainText = sanitized.replace(/<[^>]*>?/gm, " ").replace(/\s+/g, " ").trim();
    const extractedTextLength = plainText.length;
    return { ok: extractedTextLength >= FULLTEXT_MIN_CHARS, extractedTextLength };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to validate fulltext config" };
  }
}

/** Validates a proposal through the real extraction engine. Never throws. */
export async function validateAiFeedProposal(
  proposal: AiFeedProposal,
  html: string,
  url: string,
): Promise<AiFeedValidation> {
  if (proposal.mode === "pagefeed") return validatePagefeed(proposal.itemConfig, html, url);
  return validateFulltext(proposal.fullTextSelector, html, url);
}

/**
 * Orchestrator: fetches the page (SSRF-safe by default), asks the AI to
 * propose a config, then validates that proposal through the real engine
 * before returning it. `deps` lets tests inject a fake fetch/AI call — no
 * network required.
 */
export async function proposeFeedConfig(
  url: string,
  aiConfig: AiConfig,
  deps?: { fetchHtml?: (u: string) => Promise<string>; runAi?: (prompt: string) => Promise<string> },
): Promise<AiFeedConfigResult> {
  const fetchHtml =
    deps?.fetchHtml ??
    (async (u: string) =>
      fetchTextWithSsrfProtection(
        u,
        {},
        {
          allowInternal: await isTrustedFeedFetchingAllowed(),
          context: "AI feed config",
          maxBytes: 2 * 1024 * 1024,
          maxRedirects: 5,
          timeoutMs: 12_000,
        },
      ));
  const html = await fetchHtml(url);
  const prompt = buildFeedConfigPrompt(html, url);
  const raw = await (deps?.runAi ?? ((p: string) => runAiPrompt(p, aiConfig, 800)))(prompt);

  const proposal = parseAiFeedProposal(raw);
  if (!proposal) throw new Error("The AI returned an unreadable config");

  const validation = await validateAiFeedProposal(proposal, html, url);
  return { proposal, validation };
}
