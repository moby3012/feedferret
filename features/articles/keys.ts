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
  /** The sidebar's notification list (hooks/use-rss-data.ts#useNotifications). */
  notifications: ["notifications"],
  /** Every article list (infinite queries of `ArticlePage`). */
  lists: ["list"],
  list: (k: ListKey) => ["list", k.scopeKey, k.show, k.sort] as const,
  listScope: (scopeKey: string) => ["list", scopeKey] as const,
  /**
   * Members of one story cluster. Lives under `["list", …]` in list-page shape
   * (one page) so optimistic patches, rollbacks and counts treat the member
   * rows exactly like rows of any other list.
   */
  cluster: (id: string) => ["list", `cluster:${id}`, "all", "new"] as const,
  head: (k: ListKey) => ["head", k.scopeKey, k.show] as const,
  viewCount: (scopeKey: string) => ["view-count", scopeKey] as const,
  /** Every article detail. */
  articles: ["article"],
  article: (id: string) => ["article", id] as const,
} as const;

/** Mutation key of bulk mark-read (view / ids / range). */
export const MARK_VIEW_READ_KEY = ["mark-view-read"] as const;
