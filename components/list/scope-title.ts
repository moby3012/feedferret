import type { Scope } from "@/features/articles/scope";

type Named = { id: string; name: string };
type Translate = (key: string) => string;

/** List top-bar title of a scope (`sidebar` namespace). Categories resolve by ID. */
export function scopeTitle(
  scope: Scope,
  data: { feeds: Named[]; categories: Named[]; labels: Named[]; savedSearches: Named[] },
  t: Translate,
): string {
  switch (scope.kind) {
    case "all":
      return t("allArticles");
    case "starred":
      return t("starred");
    case "later":
      return t("readLater");
    case "spoiler":
      return t("spoiler");
    case "recent":
      return t("recentlyRead");
    case "feed":
      return data.feeds.find((f) => f.id === scope.id)?.name || t("feedFallback");
    case "category":
      return data.categories.find((c) => c.id === scope.id)?.name || t("feedFallback");
    case "label":
      return data.labels.find((l) => l.id === scope.id)?.name || t("labelFallback");
    case "saved-search":
      return data.savedSearches.find((s) => s.id === scope.id)?.name || t("savedSearchFallback");
    case "query":
      return scope.q;
  }
}
