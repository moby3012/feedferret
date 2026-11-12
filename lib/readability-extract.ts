// Readable-content extraction engine.
//
// Given raw article HTML, produces clean, sanitized content in both HTML and
// Markdown form, suitable for storage/display as an article's "readable"
// full-text version.
//
// The pure extraction ensemble lives in lib/readability-core.ts and runs in
// the HTML worker pool (lib/html-worker): the page is attacker-controlled and
// jsdom parses it synchronously, so on the main thread one hostile page froze
// every request and the background sync. `extractReadableContent` bounds the
// input (lib/html-guard.ts), hands it to a worker with a hard timeout and
// reports a page that cannot be parsed in budget as `parseAborted` instead of
// throwing. `fetchAndExtractReadable` is the SSRF-safe fetch + escalation
// wrapper around it.

import { fetchTextWithSsrfProtection, isTrustedFeedFetchingAllowed } from "@/lib/ssrf";
import { renderViaSidecar, getRenderSidecarConfig } from "@/lib/render-sidecar";
import { fetchViaHostedApiDetailed, getHostedFetchConfigForUser, HostedFetchRateLimitedError } from "@/lib/hosted-fetch";
import { renderMarkdownToHtmlStrict } from "@/lib/markdown-render";
import type { MeteredAiConfig } from "@/lib/ai-summary";
import { extractArticleWithAi } from "@/lib/ai-extraction";
import { htmlToPlainText } from "@/lib/article-kind";
import { assessExtraction, decideFullText, isBetterCandidate } from "@/lib/extraction-quality";
import { classifyFetchFailure, recordHostFailure, recordHostSuccess } from "@/lib/host-backoff";
import { guardHtml } from "@/lib/html-guard";
import { isHtmlWorkerError, runHtmlTask } from "@/lib/html-worker/pool";
import { runInHtmlWorker } from "@/lib/html-worker";
import { countWords, type ExtractionResult } from "@/lib/readability-types";
import { logger, urlForLog } from "@/lib/logger";

export type { ExtractionResult } from "@/lib/readability-types";

/** Thrown when every tier failed AND a tier was skipped for budget (retry later, don't count as failure). */
export class EscalationBudgetExhaustedError extends Error {
  constructor(readonly cause: unknown) {
    super("Full-text escalation budget for this sync is spent");
    this.name = "EscalationBudgetExhaustedError";
  }
}

/**
 * Extracts readable article content from raw HTML (no network I/O): bounds the
 * input, then runs the extraction ensemble (lib/readability-core.ts) in the
 * HTML worker pool. Never throws for a hostile page: a task that times out or
 * crashes its worker yields an empty result with `parseAborted: "too_complex"`
 * (a saturated pool: `"busy"`).
 */
export async function extractReadableContent(rawHtml: string, url: string): Promise<ExtractionResult> {
  const guarded = guardHtml(rawHtml);
  try {
    return await runHtmlTask("extractReadable", { html: guarded.html, url });
  } catch (error) {
    if (!isHtmlWorkerError(error)) throw error;
    logger.warn(`[full-text] extraction aborted for ${urlForLog(url)} (${error.reason}${guarded.truncatedBy ? `, input cut by ${guarded.truncatedBy}` : ""})`);
    return {
      html: null,
      markdown: null,
      title: null,
      byline: null,
      excerpt: null,
      wordCount: 0,
      extractedBy: "none",
      quality: null,
      parseAborted: error.reason === "busy" || error.reason === "unavailable" ? error.reason : "too_complex",
    };
  }
}

/**
 * Builds an ExtractionResult from a Markdown-native tier's output (hosted-API
 * or AI extraction). Strict rendering: the result may be stored as the
 * article's full text, so a worker failure makes the tier count as failed
 * (null) instead of storing a degraded plain-text rendering.
 */
async function buildResultFromMarkdown(
  markdown: string,
  title: string | null,
  extractedBy: "hosted" | "ai",
): Promise<ExtractionResult | null> {
  let html: string;
  try {
    html = await renderMarkdownToHtmlStrict(markdown);
  } catch (error) {
    if (!isHtmlWorkerError(error)) throw error;
    logger.warn(`[full-text] ${extractedBy} result not rendered (${error.reason}); tier skipped`);
    return null;
  }
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
  /** Optional capture of the winning candidate’s source page, null for source-less tiers. */
  onFetchedPage?: (html: string | null) => void;
  selector?: string | null;
  removeSelectors?: string | null;
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
function takeBudget(budget: EscalationBudget | undefined, tier: keyof EscalationBudget, onSkip?: () => void): boolean {
  if (!budget) return true;
  if (budget[tier] <= 0) {
    onSkip?.();
    return false;
  }
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
  const extractPage = async (html: string): Promise<ExtractionResult> => {
    if (options.selector === undefined) return extractReadableContent(html, url);
    try {
      const selected = await runInHtmlWorker({ task: "css", html, url, selector: options.selector, removeSelectors: options.removeSelectors, mode: "sync" });
      return { html: selected.html, markdown: null, title: null, byline: null, excerpt: null,
        wordCount: selected.html ? countWords(selected.html) : 0, extractedBy: "selector", quality: selected.quality };
    } catch (error) {
      if (!isHtmlWorkerError(error)) throw error;
      return { html: null, markdown: null, title: null, byline: null, excerpt: null, wordCount: 0,
        extractedBy: "none", quality: null,
        parseAborted: error.reason === "busy" || error.reason === "unavailable" ? error.reason : "too_complex" };
    }
  };
  let directError: unknown = null;
  let best: ExtractionResult | null = null;
  let firstResult: ExtractionResult | null = null;
  let firstFetchedHtml: string | null = null;
  let bestFetchedHtml: string | null = null;
  let lastFetchedHtml: string | null = null;

  const consider = (result: ExtractionResult, fetchedHtml: string | null) => {
    if (!firstResult) { firstResult = result; firstFetchedHtml = fetchedHtml; }
    if (!result.quality || !result.html) return;
    if (!best?.quality || isBetterCandidate(result.quality, best.quality)) {
      best = result;
      bestFetchedHtml = fetchedHtml;
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
    // Manual fetch: escalate only on wall/empty/thin — a good page that is
    // merely not longer than what the reader shows won't improve by spending
    // render/hosted calls on it.
    if (options.gate === "manual") return true;
    if (options.baselineHtml === undefined || baselineLength >= SUBSTANTIAL_FEED_TEXT_LENGTH) return true;
    return decideFullText(current.quality, options.baselineHtml, options.gate ?? "auto", current.html).accept;
  };
  let budgetSkipped = false;
  const skipped = () => {
    budgetSkipped = true;
  };

  const transports = transportOrder(url);
  let anyFetchSucceeded = false;
  for (const [index, transport] of transports.entries()) {
    try {
      const html = await fetchPage(url, transport);
      anyFetchSucceeded = true;
      lastFetchedHtml = html;
      const extracted = await extractPage(html);
      consider(extracted, html);
      // The other transport would fetch the same page and abort the same way.
      if (extracted.parseAborted) break;
      if (goodEnough()) {
        if (index > 0) rememberTransport(url, transport);
        break;
      }
    } catch (error) {
      directError ??= error;
      // A permanent failure (404, SSRF refusal, oversized page) won't change
      // with a different TLS fingerprint — don't retry it.
      // Neither does an explicit rate limit: a second request right away
      // (other transport) would only hammer the site — back off instead.
      const failure = classifyFetchFailure(error);
      if (failure.kind === "permanent" || failure.kind === "rate_limited" || failure.retryAfterMs !== null) break;
    }
  }
  if (anyFetchSucceeded) recordHostSuccess(url);
  else if (directError) recordHostFailure(url, directError);

  // M6: per-feed opt-in AI-extraction, on the already-fetched HTML — before
  // falling to the (slower, whole-page-re-fetching) render sidecar.
  const aiSource = (bestFetchedHtml as string | null) ?? lastFetchedHtml;
  if (!goodEnough() && options.aiExtraction && aiSource && takeBudget(options.escalationBudget, "ai", skipped)) {
    const aiResult = await extractArticleWithAi(aiSource, url, options.aiExtraction);
    const built = aiResult ? await buildResultFromMarkdown(aiResult.content, aiResult.title, "ai") : null;
    if (built) consider(built, aiSource);
  }

  // Render sidecar (M7-T2, admin-configured): client-only pages, consent/bot
  // walls a real browser gets past, or a direct fetch that was blocked outright.
  // Every attempt counts against the per-sync budget (a no-op when no sidecar is configured).
  const shellOnly = (firstResult as ExtractionResult | null)?.quality?.reason === "js_shell";
  const shellHasRenderer = !shellOnly || (await getRenderSidecarConfig()) !== null;
  let renderDeferred = false;
  if (!goodEnough() && shellHasRenderer && takeBudget(options.escalationBudget, "render", skipped)) {
    let rendered: string | null = null;
    try {
      rendered = await renderViaSidecar(url, { context: "Full-text" });
    } catch (error) {
      if (!shellOnly) throw error;
    }
    renderDeferred = shellOnly && !rendered;
    if (rendered) {
      const extracted = await extractPage(rendered);
      consider(extracted, rendered);
      // Preserve a completed render's actual outcome instead of the original shell.
      if (shellOnly) { firstResult = extracted; firstFetchedHtml = rendered; }
    }
  }

  // Last resort: the user's own hosted-API BYOK connector (M7-T3), for pages
  // that beat even a real rendered browser (active anti-bot challenges).
  let hostedRateLimited = false;
  if (!goodEnough() && options.userId && options.selector === undefined) {
    const hostedConfig = await getHostedFetchConfigForUser(options.userId);
    if (hostedConfig && takeBudget(options.escalationBudget, "hosted", skipped)) {
      const outcome = await fetchViaHostedApiDetailed(url, hostedConfig);
      if (outcome.ok) {
        const built = await buildResultFromMarkdown(outcome.result.content, outcome.result.title, "hosted");
        if (built) consider(built, null);
      } else hostedRateLimited = outcome.rateLimited;
    }
  }

  const finalBest = best as ExtractionResult | null;
  options.onFetchedPage?.(finalBest ? bestFetchedHtml : firstFetchedHtml);
  if (finalBest) return budgetSkipped && !goodEnough() ? { ...finalBest, budgetSkipped: true } : finalBest;
  const empty = firstResult as ExtractionResult | null;
  if (empty) return { ...empty, ...(budgetSkipped ? { budgetSkipped: true } : {}), ...(renderDeferred ? { renderDeferred: true } : {}) }; // the (empty) in-process result
  // Rate-limiting on the last-resort tier is worth telling the caller apart
  // from an ordinary fetch failure (see fetchFullText in app/actions/feeds.ts),
  // since "try again later / add your own key" is actionable advice a plain
  // "couldn't fetch" message can't give.
  if (hostedRateLimited) throw new HostedFetchRateLimitedError();
  if (budgetSkipped) throw new EscalationBudgetExhaustedError(directError);
  throw directError ?? new Error("Full-text fetch failed");
}
