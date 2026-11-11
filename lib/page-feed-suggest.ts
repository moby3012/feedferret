// Page → feed candidate suggestions: SSRF-safe fetch (+ render-sidecar
// fallback) around the pure heuristic in lib/page-feed-suggest-core.ts, which
// runs in the HTML worker pool so a hostile page cannot block the event loop.

import type { PreviewRejectReason } from "./page-feed-quality";
import { fetchTextWithSsrfProtection, isTrustedFeedFetchingAllowed } from "./ssrf";
import { renderViaSidecar } from "./render-sidecar";
import { runInHtmlWorker } from "./html-worker";
import type { FeedCandidate, SuggestionResult } from "./page-feed-suggest-types";

// Types only: the heuristic itself (lib/page-feed-suggest-core.ts) runs in the HTML worker pool.
export type { CandidateQuality, FeedCandidate, SuggestionResult, SuggestionWork, SuggestOptions, SuggestedFieldConfig } from "./page-feed-suggest-types";

/** Runs the heuristic off the main thread on the guarded (size/depth-bounded) page. */
export async function suggestFeedCandidatesOffThread(rawHtml: string, url: string): Promise<SuggestionResult> {
  return runInHtmlWorker({ task: "suggestFeed", html: rawHtml, url });
}

/** SSRF-safe wrapper: fetch the URL, then suggest candidates. Fetch errors propagate. */
export async function fetchAndSuggestFeedCandidates(url: string): Promise<FeedCandidate[]> {
  return (await fetchAndSuggestFeedCandidatesDetailed(url)).candidates;
}

/** Like `fetchAndSuggestFeedCandidates`, plus how many candidates the quality gate dropped. */
export async function fetchAndSuggestFeedCandidatesDetailed(url: string): Promise<SuggestionResult> {
  let directError: unknown = null;
  const rejected: SuggestionResult["rejected"] = { count: 0, reasons: {} };
  const mergeRejected = (other: SuggestionResult["rejected"]) => {
    rejected.count += other.count;
    for (const [reason, n] of Object.entries(other.reasons) as Array<[PreviewRejectReason, number]>) {
      rejected.reasons[reason] = (rejected.reasons[reason] ?? 0) + n;
    }
  };
  try {
    const html = await fetchTextWithSsrfProtection(
      url,
      {},
      {
        allowInternal: await isTrustedFeedFetchingAllowed(),
        context: "Page feed",
        impersonate: true,
        maxBytes: 2 * 1024 * 1024,
        maxRedirects: 5,
        timeoutMs: 12_000,
      },
    );
    const result = await suggestFeedCandidatesOffThread(html, url);
    if (result.candidates.length > 0) return result;
    mergeRejected(result.rejected);
  } catch (error) {
    directError = error; // hard block — the sidecar may still succeed.
  }

  // Fallback for genuinely client-only listing pages (the item list is rendered
  // in the browser and never reaches our static fetch): if an admin configured
  // a browser-render sidecar (M7-T2), render the page there and re-run the
  // heuristic on the rendered DOM.
  const rendered = await renderViaSidecar(url, { context: "Page feed" });
  if (rendered) {
    const result = await suggestFeedCandidatesOffThread(rendered, url);
    if (result.candidates.length > 0) return result;
    mergeRejected(result.rejected);
  }

  if (directError) throw directError;
  return { candidates: [], rejected };
}
