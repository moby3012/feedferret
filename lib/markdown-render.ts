// Markdown → sanitized HTML for API clients (Fever, GReader, v1 REST), the
// reader's article detail and the hosted / AI extraction tiers. Article
// markdown comes from feeds and third-party services; markdown-it + DOMPurify
// (jsdom-backed) of a large document is a long synchronous task, so rendering
// runs in the HTML worker pool (lib/markdown-render-core.ts).
//
// Reads must not fail because the pool is momentarily saturated or missing:
//   - rendered HTML is memoized per markdown (content hash, bounded LRU), so an
//     article is rendered once, not on every read / sync page;
//   - if the worker cannot render (busy / unavailable / too complex), the
//     caller gets a SAFE plain-text rendering (every character escaped, no
//     markup from the input survives) and a `fallback` reason instead of an
//     error — one article never fails a whole API page.

import { createHash } from "node:crypto";
import { isHtmlWorkerError, runHtmlTask, type HtmlWorkerAbortReason } from "@/lib/html-worker/pool";
import { logger } from "@/lib/logger";

export type RenderedMarkdown = {
  html: string;
  /** Why the plain-text fallback was used; null for a real rendering. */
  fallback: HtmlWorkerAbortReason | "error" | null;
};

const CACHE_MAX_ENTRIES = 1_000;
const CACHE_MAX_CHARS = 32 * 1024 * 1024;
// A markdown that cannot be rendered in budget is not retried on every read.
const TOO_COMPLEX_TTL_MS = 10 * 60_000;

type CacheState = {
  rendered: Map<string, string>;
  chars: number;
  tooComplex: Map<string, number>;
};

// Per process (Next bundles route handlers separately: module state would be duplicated).
const CACHE_KEY = Symbol.for("feedferret.markdownRenderCache");
function cache(): CacheState {
  const g = globalThis as unknown as Record<symbol, CacheState | undefined>;
  return (g[CACHE_KEY] ??= { rendered: new Map(), chars: 0, tooComplex: new Map() });
}

function keyOf(markdown: string): string {
  return createHash("sha256").update(markdown).digest("base64url");
}

function remember(key: string, html: string) {
  const c = cache();
  if (html.length > CACHE_MAX_CHARS / 4) return;
  const previous = c.rendered.get(key);
  if (previous !== undefined) {
    c.rendered.delete(key);
    c.chars -= previous.length;
  }
  c.rendered.set(key, html);
  c.chars += html.length;
  while (c.rendered.size > CACHE_MAX_ENTRIES || c.chars > CACHE_MAX_CHARS) {
    const [oldestKey, oldest] = c.rendered.entries().next().value as [string, string];
    c.rendered.delete(oldestKey);
    c.chars -= oldest.length;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/**
 * Safe plain-text rendering of markdown source: paragraphs on blank lines,
 * line breaks kept, everything escaped. Linear; no parser involved.
 */
export function markdownPlainTextFallback(markdown: string): string {
  const paragraphs: string[] = [];
  for (const block of markdown.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/)) {
    const text = block.trim();
    if (text) paragraphs.push(`<p>${escapeHtml(text).split("\n").join("<br>")}</p>`);
  }
  return paragraphs.join("\n");
}

/** Renders markdown for display. Never throws: falls back to escaped plain text with a reason. */
export async function renderMarkdownForDisplay(markdown: string): Promise<RenderedMarkdown> {
  const key = keyOf(markdown);
  const c = cache();
  const hit = c.rendered.get(key);
  if (hit !== undefined) {
    c.rendered.delete(key); // LRU: move to the end
    c.rendered.set(key, hit);
    return { html: hit, fallback: null };
  }
  const tooComplexUntil = c.tooComplex.get(key);
  if (tooComplexUntil !== undefined) {
    if (tooComplexUntil > Date.now()) return { html: markdownPlainTextFallback(markdown), fallback: "timeout" };
    c.tooComplex.delete(key);
  }
  try {
    const html = await runHtmlTask("renderMarkdown", markdown);
    remember(key, html);
    return { html, fallback: null };
  } catch (error) {
    const reason = isHtmlWorkerError(error) ? error.reason : "error";
    if (reason === "timeout" || reason === "memory" || reason === "crashed" || reason === "error") {
      if (c.tooComplex.size > CACHE_MAX_ENTRIES) c.tooComplex.clear();
      c.tooComplex.set(key, Date.now() + TOO_COMPLEX_TTL_MS);
    }
    logger.warn(`[markdown-render] plain-text fallback (${reason})`);
    return { html: markdownPlainTextFallback(markdown), fallback: reason };
  }
}

/** Display rendering as an HTML string (plain-text fallback included). Never throws. */
export async function renderMarkdownToHtml(markdown: string): Promise<string> {
  return (await renderMarkdownForDisplay(markdown)).html;
}

/**
 * Strict rendering for content that will be STORED (hosted / AI extraction
 * tiers): a degraded plain-text version must not become the article's full
 * text, so worker errors propagate (the tier counts as failed).
 */
export async function renderMarkdownToHtmlStrict(markdown: string): Promise<string> {
  const key = keyOf(markdown);
  const hit = cache().rendered.get(key);
  if (hit !== undefined) return hit;
  const html = await runHtmlTask("renderMarkdown", markdown);
  remember(key, html);
  return html;
}

/** Test helper. */
export function resetMarkdownRenderCache() {
  const c = cache();
  c.rendered.clear();
  c.tooComplex.clear();
  c.chars = 0;
}
