// Public entry point for parsing untrusted HTML / XML: one call per
// operation, the input bounded by lib/html-guard.ts and evaluated in the HTML
// worker pool (lib/html-worker/pool.ts) under its time / memory limits.
//
// Use this for ANY evaluation of fetched or mailed markup, and in particular
// of user-configured scraper expressions (Scout / page-feed XPath configs,
// FreshRSS `frss:*` OPML imports: cssFullContent, cssContentFilter, xPath*):
// a hostile selector or XPath on a hostile page then costs at most one task
// timeout in a worker instead of freezing the event loop.
//
//   const feed = await runInHtmlWorker({ task: "xpath", html, url, config, contentType: "text/html" });
//   const page = await runInHtmlWorker({ task: "css", html, url, selector, removeSelectors, mode: "sync" });
//   const items = await runInHtmlWorker({ task: "removeSelectors", items: [a, b], selectors: feed.fullTextRemoveSelectors });
//
// Rejects with `HtmlWorkerError` (reason `timeout` / `memory` / `crashed`:
// the page or expression is too complex — record it, do not retry at once;
// `busy`: the pool is saturated or a background task waited too long, retry
// later; `unavailable`: no worker bundle — the pool fails closed, keep what
// you have) or `HtmlTaskFailedError` (the task threw, e.g. an invalid XPath /
// CSS selector where the task does not swallow it).
//
// Priority: interactive by default; work started inside
// `runAsBackgroundHtmlWork(() => …)` (scheduled / bulk sync, imports) or with
// `priority: "background"` queues behind interactive work and never takes the
// reserved worker.

import type { FeedExtractionConfig } from "@/lib/feed-extraction";
import type { FetchedFeed } from "@/lib/feed-parse-core";
import type { PageDigestOptions } from "@/lib/page-digest";
import type { SuggestionResult } from "@/lib/page-feed-suggest-core";
import type { ExtractionResult } from "@/lib/readability-types";
import type { SelectorExtractOutput, SelectorTextOutput } from "@/lib/selector-extract";
import type { SanitizedFeedItem } from "@/lib/feed-item-sanitize";
import { guardHtml, type HtmlGuardLimits } from "@/lib/html-guard";
import { runHtmlTask, type HtmlTaskPriority } from "./pool";

export {
  HtmlTaskFailedError,
  HtmlWorkerError,
  isHtmlWorkerError,
  isTooComplexError,
  runAsBackgroundHtmlWork,
  htmlWorkerStatus,
  type HtmlTaskPriority,
  type HtmlWorkerAbortReason,
} from "./pool";

type Base = {
  /** Per-call timeout (ms); default FEEDFERRET_HTML_WORKER_TIMEOUT_MS (8 s). */
  timeoutMs?: number;
  /** Default: the async context's (runAsBackgroundHtmlWork), else interactive. */
  priority?: HtmlTaskPriority;
  /** Background only: queue-wait deadline (ms). */
  queueWaitMs?: number;
  /** Overrides of the pre-parse guard limits (lib/html-guard.ts). */
  guard?: Partial<HtmlGuardLimits>;
};

export type HtmlWorkerRequest = Base &
  (
    | { task: "telegram"; html: string; url: string; channel: string }
    | { task: "readability"; html: string; url: string }
    | { task: "xpath"; html: string; url: string; config: FeedExtractionConfig; contentType: "text/html" | "text/xml" }
    | { task: "xpathString"; html: string; url: string; expression: string | undefined }
    | { task: "css"; html: string; url: string; selector?: string | null; removeSelectors?: string | null; mode: "sync" | "preview" }
    | { task: "cssProbe"; html: string; url: string; selector: string }
    | { task: "removeSelectors"; items: string[]; selectors: string | null | undefined }
    | { task: "sanitize"; items: string[]; removeSelectors?: string | null }
    | { task: "suggestFeed"; html: string; url: string }
    | { task: "digest"; html: string; url: string; options?: PageDigestOptions }
  );

export type HtmlWorkerResult<R extends HtmlWorkerRequest> = R extends { task: "telegram" }
  ? FetchedFeed
  : R extends { task: "readability" }
  ? ExtractionResult
  : R extends { task: "xpath" }
    ? FetchedFeed
    : R extends { task: "xpathString" }
      ? string
      : R extends { task: "css" }
        ? SelectorExtractOutput
        : R extends { task: "cssProbe" }
          ? SelectorTextOutput
          : R extends { task: "removeSelectors" }
            ? string[]
            : R extends { task: "sanitize" }
              ? SanitizedFeedItem[]
              : R extends { task: "suggestFeed" }
                ? SuggestionResult
                : R extends { task: "digest" }
                  ? string
                  : never;

/** Parses / evaluates untrusted markup off the main thread, on guarded input. */
export async function runInHtmlWorker<R extends HtmlWorkerRequest>(request: R): Promise<HtmlWorkerResult<R>> {
  const opts = { timeoutMs: request.timeoutMs, priority: request.priority, queueWaitMs: request.queueWaitMs };
  const bound = (html: string, xml = false) => guardHtml(html, { ...request.guard, xml }).html;
  const r = request as HtmlWorkerRequest;
  let out: unknown;
  switch (r.task) {
    case "telegram":
      out = await runHtmlTask("telegram", { html: bound(r.html), url: r.url, channel: r.channel }, opts);
      break;
    case "readability":
      out = await runHtmlTask("extractReadable", { html: bound(r.html), url: r.url }, opts);
      break;
    case "xpath":
      out = await runHtmlTask(
        "xpathArticles",
        { html: bound(r.html, r.contentType === "text/xml"), url: r.url, config: r.config, contentType: r.contentType },
        opts,
      );
      break;
    case "xpathString":
      out = await runHtmlTask("xpathString", { html: bound(r.html), url: r.url, expression: r.expression }, opts);
      break;
    case "css":
      out = await runHtmlTask(
        "selectorExtract",
        { html: bound(r.html), url: r.url, selector: r.selector, removeSelectors: r.removeSelectors, mode: r.mode },
        opts,
      );
      break;
    case "cssProbe":
      out = await runHtmlTask("selectorText", { html: bound(r.html), url: r.url, selector: r.selector }, opts);
      break;
    case "removeSelectors":
      out = await runHtmlTask("removeSelectors", { items: r.items.map((h) => bound(h)), selectors: r.selectors }, opts);
      break;
    case "sanitize":
      out = await runHtmlTask("sanitizeFeedItems", { items: r.items.map((h) => bound(h)), removeSelectors: r.removeSelectors }, opts);
      break;
    case "suggestFeed":
      out = await runHtmlTask("suggestFeedCandidates", { html: bound(r.html), url: r.url }, { ...opts, timeoutMs: r.timeoutMs ?? 12_000 });
      break;
    case "digest":
      out = await runHtmlTask("pageDigest", { html: bound(r.html), url: r.url, options: r.options }, opts);
      break;
  }
  return out as HtmlWorkerResult<R>;
}
