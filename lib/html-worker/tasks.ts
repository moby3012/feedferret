import { rewriteMediaInProcess } from "@/lib/media-rewrite-core";
// The HTML tasks the worker pool (lib/html-worker/pool.ts) can run. Everything
// reachable from here is bundled into build/html-worker/worker.cjs, so this
// graph must stay free of I/O modules (db, ssrf, auth, next): the bundle
// script fails the build when one sneaks in (scripts/build-html-worker.mjs).
// Inputs and outputs cross the thread boundary by structured clone.

import { extractReadableContentInProcess } from "@/lib/readability-core";
import { buildXPathArticles, evaluateXPathStringInHtml } from "@/lib/feed-parse-core";
import type { FeedExtractionConfig } from "@/lib/feed-extraction";
import { suggestFeedCandidatesDetailed } from "@/lib/page-feed-suggest-core";
import { buildPageDigest, type PageDigestOptions } from "@/lib/page-digest";
import {
  extractBySelector,
  probeSelectorText,
  removeSelectorsFromFragments,
  type RemoveSelectorsInput,
  type SelectorExtractInput,
  type SelectorTextInput,
} from "@/lib/selector-extract";
import { buildNewsletterBody, type NewsletterBodyInput } from "@/lib/newsletter-html";
import { sanitizeFeedItemsInProcess, type SanitizeFeedItemsInput } from "@/lib/feed-item-sanitize";
import { getSanitizer } from "@/lib/sanitize-html";
import { parseOpmlInProcess } from "@/lib/opml-parse-core";
import { extractCatalogOpmlEntries } from "@/lib/catalog-opml-core";
import { renderMarkdownToHtmlInProcess } from "@/lib/markdown-render-core";
import { parseTelegramPreview } from "@/lib/telegram-preview-core";
import { htmlToMarkdown } from "@/lib/html-to-markdown";

/**
 * The `__test*` tasks (busy loop, memory bomb) exist for the pool's own tests.
 * They run only with FEEDFERRET_HTML_WORKER_TEST_TASKS=1 and never when
 * NODE_ENV=production, so a production worker cannot be told to spin or
 * allocate by anything that can name a task.
 */
function assertTestTasksEnabled() {
  if (process.env.FEEDFERRET_HTML_WORKER_TEST_TASKS !== "1" || process.env.NODE_ENV === "production") {
    throw new Error("HTML worker test tasks are disabled");
  }
}

export const htmlTasks = {
  rewriteMedia: async (input: Parameters<typeof rewriteMediaInProcess>[0]) => {
    const sanitizer = await getSanitizer();
    const html = sanitizer.sanitize(input.html, { ADD_TAGS: ["iframe"], ADD_ATTR: ["src"] });
    return sanitizer.sanitize(rewriteMediaInProcess({ ...input, html }), { ADD_ATTR: ["target"] });
  },
  telegram: parseTelegramPreview,
  /** Loads the parsers and the sanitizer's window (boot warm-up). */
  async warm(_input: null): Promise<true> {
    const DOMPurify = await getSanitizer();
    DOMPurify.sanitize('<p style="width:1px">warm</p>');
    return true;
  },
  extractReadable: (input: { html: string; url: string }) => extractReadableContentInProcess(input.html, input.url),
  xpathArticles: (input: { html: string; url: string; config: FeedExtractionConfig; contentType: "text/html" | "text/xml" }) =>
    buildXPathArticles(input.html, input.url, input.config, input.contentType),
  xpathString: (input: { html: string; url: string; expression: string | undefined }) =>
    evaluateXPathStringInHtml(input.html, input.url, input.expression),
  suggestFeedCandidates: (input: { html: string; url: string; timeBudgetMs?: number; maxGroups?: number }) =>
    suggestFeedCandidatesDetailed(input.html, input.url, { timeBudgetMs: input.timeBudgetMs, maxGroups: input.maxGroups }),
  pageDigest: (input: { html: string; url: string; options?: PageDigestOptions }) =>
    buildPageDigest(input.html, input.url, input.options),
  selectorExtract: (input: SelectorExtractInput) => extractBySelector(input),
  selectorText: (input: SelectorTextInput) => probeSelectorText(input),
  newsletterBody: (input: NewsletterBodyInput) => buildNewsletterBody(input),
  sanitizeFeedItems: (input: SanitizeFeedItemsInput) => sanitizeFeedItemsInProcess(input),
  removeSelectors: (input: RemoveSelectorsInput) => removeSelectorsFromFragments(input),
  parseOpml: (input: string) => parseOpmlInProcess(input),
  catalogOpmlEntries: (input: string) => extractCatalogOpmlEntries(input),
  renderMarkdown: (input: string) => renderMarkdownToHtmlInProcess(input),
  htmlToMarkdown: (input: string) => htmlToMarkdown(input),
  /** Test-only probes for the pool's timeout / memory handling (refused unless enabled, never in production). */
  async __testBusyLoop(input: { ms: number }): Promise<number> {
    assertTestTasksEnabled();
    const until = Date.now() + input.ms;
    let n = 0;
    while (Date.now() < until) n++;
    return n;
  },
  async __testAllocate(input: { mb: number }): Promise<number> {
    assertTestTasksEnabled();
    const keep: string[][] = [];
    for (let i = 0; i < input.mb; i++) keep.push(Array.from({ length: 16_384 }, (_, j) => `${i}:${j}:${"x".repeat(24)}`));
    return keep.length;
  },
};

type Tasks = typeof htmlTasks;
export type HtmlTaskName = keyof Tasks;
export type HtmlTaskInput<K extends HtmlTaskName> = Parameters<Tasks[K]>[0];
export type HtmlTaskOutput<K extends HtmlTaskName> = Awaited<ReturnType<Tasks[K]>>;

export async function runHtmlTaskInProcess<K extends HtmlTaskName>(task: K, input: HtmlTaskInput<K>): Promise<HtmlTaskOutput<K>> {
  const fn = htmlTasks[task] as (input: HtmlTaskInput<K>) => HtmlTaskOutput<K> | Promise<HtmlTaskOutput<K>>;
  if (typeof fn !== "function") throw new Error(`Unknown HTML task: ${String(task)}`);
  return fn(input);
}
