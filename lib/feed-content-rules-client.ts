import { guardHtml } from "./html-guard";
import { isTooComplexError, runHtmlTask, type RunOptions } from "./html-worker/pool";
import { sanitizeFeedItemBodies } from "./feed-item-sanitize-client";
import { logger } from "./logger";

const CHUNK_ITEMS = 50;
const CHUNK_CHARS = 512 * 1024;
const TASK_BUDGET_MS = 2000;
const FEED_BUDGET_MS = 8000;

/** Bounded batches; pathological rules fail open to DEFAULT-SANITIZED content,
 * never raw HTML. Busy/unavailable workers still fail sync for retry as on main.
 * A batch timeout is isolated item by item, within the remaining feed budget.
 */
export async function applyFeedContentRules(items: { title: string; html: string }[], rules?: string | null, removeSelectors?: string | null, run: RunOptions = {}) {
  const guarded = items.map(item => ({ title: item.title.slice(0, 4000), html: guardHtml(item.html).html }));
  const defaults = await sanitizeFeedItemBodies(guarded.map(item => item.html), { removeSelectors, run });
  const results = defaults.map(item => ({ ...item, defaultHtml: item.html, allowed: true, rulesSkipped: null as string | null }));
  const deadline = performance.now() + FEED_BUDGET_MS;
  const skip = (start: number, end: number, reason: string) => {
    logger.warn(`[feed-content-rules] rules skipped for ${end - start} item(s): ${reason}; using default-sanitized content (gates skipped)`);
    for (let i = start; i < end; i++) results[i].rulesSkipped = reason;
  };
  const evaluate = async (start: number, end: number) => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) { skip(start, end, "feed_budget"); return; }
    try {
      const output = await runHtmlTask("feedContentRules", { rules, removeSelectors, items: guarded.slice(start, end) }, { ...run, timeoutMs: Math.max(1, Math.min(TASK_BUDGET_MS, Math.floor(remaining))) });
      output.forEach((item, i) => Object.assign(results[start + i], item));
    } catch (error) {
      if (!isTooComplexError(error)) throw error;
      if (end - start === 1) skip(start, end, error.reason);
      else for (let i = start; i < end; i++) await evaluate(i, i + 1);
    }
  };
  for (let start = 0; start < guarded.length;) {
    let end = start;
    let chars = 0;
    while (end < guarded.length && end - start < CHUNK_ITEMS && (end === start || chars + guarded[end].html.length <= CHUNK_CHARS)) chars += guarded[end++].html.length;
    await evaluate(start, end);
    start = end;
  }
  return results;
}
