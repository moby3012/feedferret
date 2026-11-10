import type { ListKey } from "./scope";

// Query keys (.pm/spec-shell-design.md §2.3). Entity keys are unchanged so
// the settings pages keep sharing the same cache entries.
export const qk = {
  feeds: ["feeds"],
  categories: ["categories"],
  labels: ["labels"],
  savedSearches: ["saved-searches"],
  prefs: ["reading-preferences"],
  counts: ["counts"],
  /** Every article list (infinite queries of `ArticlePage`). */
  lists: ["list"],
  list: (k: ListKey) => ["list", k.scopeKey, k.show, k.sort] as const,
  listScope: (scopeKey: string) => ["list", scopeKey] as const,
  head: (k: ListKey) => ["head", k.scopeKey, k.show] as const,
  viewCount: (scopeKey: string) => ["view-count", scopeKey] as const,
  /** Every article detail. */
  articles: ["article"],
  article: (id: string) => ["article", id] as const,
} as const;
