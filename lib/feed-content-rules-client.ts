import { guardHtml } from "./html-guard";
import { runHtmlTask } from "./html-worker/pool";

/** Each item gets a hard two-second budget; timeouts fail sync closed for retry. */
export async function applyFeedContentRules(items: { title: string; html: string }[], rules?: string | null, removeSelectors?: string | null) {
  const results = [];
  for (const item of items) {
    results.push(...await runHtmlTask("feedContentRules", { rules, removeSelectors, items: [{ title: item.title.slice(0, 4000), html: guardHtml(item.html).html }] }, { timeoutMs: 2000 }));
  }
  return results;
}
