// Main-thread side of feed item sanitizing: bounds every body
// (lib/html-guard.ts), then sanitizes them in the HTML worker pool in chunks
// (each chunk has its own timeout, so a big feed never exceeds one task's
// budget). A chunk that times out or crashes is retried item by item; an item
// that still cannot be parsed is stored empty instead of failing the feed.

import { guardHtml } from "./html-guard";
import { isTooComplexError, runHtmlTask, type HtmlWorkerError, type RunOptions } from "./html-worker/pool";
import { logger } from "./logger";
import type { SanitizedFeedItem } from "./feed-item-sanitize";

/** Content characters per worker task. */
const CHUNK_CHARS = 512 * 1024;
const CHUNK_ITEMS = 50;

/**
 * Timeout / memory / worker crash: this content cannot be parsed in budget. A
 * saturated (`busy`) or missing (`unavailable`) pool is not that: those fail
 * the feed sync (retried next sync); unsanitized content is never stored.
 */
const tooComplex = isTooComplexError;

function dropped(error: HtmlWorkerError): SanitizedFeedItem {
  logger.warn(`[feed-items] item body too complex to sanitize (${error.reason}); stored empty`);
  return { excerpt: "", html: "" };
}

export type SanitizeFeedItemBodiesOptions = {
  /** Feed's remove-selector list (FreshRSS `cssContentFilter`), applied before sanitizing. */
  removeSelectors?: string | null;
  /** Excerpt from the sanitized HTML instead of the raw content. */
  excerptFromSanitized?: boolean;
  /** Known video-provider iframes become plain links (see SanitizeFeedItemsInput.embedLinks / SanitizedFeedItem.legacyHtml). */
  embedLinks?: boolean;
  /** Pool options (priority defaults to the async context's, see runAsBackgroundHtmlWork). */
  run?: RunOptions;
};

export async function sanitizeFeedItemBodies(contents: string[], options: SanitizeFeedItemBodiesOptions = {}): Promise<SanitizedFeedItem[]> {
  const removeSelectors = options.removeSelectors ?? null;
  const excerptFromSanitized = options.excerptFromSanitized ?? false;
  const embedLinks = options.embedLinks ?? false;
  const run = options.run ?? {};
  const guarded = contents.map((content) => guardHtml(content).html);
  const results: SanitizedFeedItem[] = new Array(guarded.length);
  let start = 0;
  while (start < guarded.length) {
    let end = start;
    let chars = 0;
    while (end < guarded.length && end - start < CHUNK_ITEMS && (end === start || chars + guarded[end].length <= CHUNK_CHARS)) {
      chars += guarded[end].length;
      end++;
    }
    const chunk = guarded.slice(start, end);
    try {
      const out = await runHtmlTask("sanitizeFeedItems", { items: chunk, removeSelectors, excerptFromSanitized, embedLinks }, run);
      out.forEach((item, i) => (results[start + i] = item));
    } catch (error) {
      if (!tooComplex(error)) throw error;
      if (chunk.length === 1) {
        results[start] = dropped(error);
      } else {
        for (let i = 0; i < chunk.length; i++) {
          try {
            results[start + i] = (await runHtmlTask("sanitizeFeedItems", { items: [chunk[i]], removeSelectors, excerptFromSanitized, embedLinks }, run))[0];
          } catch (itemError) {
            if (!tooComplex(itemError)) throw itemError;
            results[start + i] = dropped(itemError);
          }
        }
      }
    }
    start = end;
  }
  return results;
}
