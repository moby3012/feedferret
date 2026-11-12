// Parse-free types of the page → feed suggestion engine
// (lib/page-feed-suggest-core.ts, HTML worker only), for UI / API code.

import type { FetchedFeedArticle } from "./feed-item-fields";
import type { ItemIssue, PreviewNote, PreviewReviewReason, PreviewRejectReason } from "./page-feed-quality";

export type SuggestedFieldConfig = {
  xPathItem: string;
  xPathItemTitle?: string;
  xPathItemUri?: string;
  xPathItemContent?: string;
  xPathItemTimestamp?: string;
  /** PHP `DateTime::createFromFormat` format of the timestamp text (FreshRSS `xPathItemTimeFormat`). */
  xPathItemTimeFormat?: string;
  xPathItemThumbnail?: string;
};

export type CandidateQuality = {
  /** "ok" = plausible entry list; "review" = offered, but the UI must ask the user to check. */
  verdict: "ok" | "review";
  reasons: PreviewReviewReason[];
  /** Informational (e.g. "missingDates"): shown in the preview, never a review label. */
  notes: PreviewNote[];
  /** Distinct items that look like real entries (≥ 3 by construction). */
  plausibleItems: number;
};

export type FeedCandidate = {
  config: SuggestedFieldConfig;
  score: number;
  itemCount: number;
  sampleTitles: string[];
  previewArticles: FetchedFeedArticle[];
  /** Per preview item: why it looks like a non-entry (null = plausible), aligned with previewArticles. */
  previewIssues: Array<ItemIssue | null>;
  quality: CandidateQuality;
};

export type SuggestionResult = {
  candidates: FeedCandidate[];
  /** Structurally valid candidates dropped by the preview quality gate. */
  rejected: { count: number; reasons: Partial<Record<PreviewRejectReason, number>> };
  /** Work-bound diagnostics of the single-page run (absent on merged multi-fetch results). */
  work?: SuggestionWork;
};

export type SuggestionWork = {
  /** Repeating groups found on the page, before the cap. */
  groupsFound: number;
  /** Groups actually validated (after the MAX_GROUPS cap and within the time budget). */
  groupsEvaluated: number;
  /**
   * True when the time budget stopped validation before every capped group was visited: the candidates are
   * the best of what was evaluated (largest groups first), not necessarily of the whole page.
   */
  budgetExhausted: boolean;
};

export type SuggestOptions = {
  /** Injectable clock (ms), so the time budget can be tested without wall-clock timing. */
  now?: () => number;
  /** Soft time budget in ms (default {@link SUGGEST_TIME_BUDGET_MS}); `Infinity` = unlimited (deterministic fixtures). */
  timeBudgetMs?: number;
  /**
   * Largest repeating groups validated at most (default {@link MAX_GROUPS}). With
   * `timeBudgetMs: Infinity` this is a deterministic work bound: the result then
   * depends only on the page, not on the machine's speed or load.
   */
  maxGroups?: number;
};

