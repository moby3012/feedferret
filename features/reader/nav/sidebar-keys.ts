// Bridge between the pre-shell sidebar / palette selection strings and the
// `Scope` union. Categories are addressed by ID end to end (`Category:<id>`):
// two folders with the same name under different parents are different
// scopes (a by-name lookup resolved both to the first one).
import type { MarkViewScope } from "@/features/articles/mutations";
import type { Scope } from "@/features/articles/scope";

export const CATEGORY_PREFIX = "Category:";
export const LABEL_PREFIX = "Label:";
export const SAVED_SEARCH_PREFIX = "Search:";

export function categoryKey(id: string): string {
  return `${CATEGORY_PREFIX}${id}`;
}

/** Sidebar `onSelectCategory` value (sentinel, `Label:`, `Search:`, `Category:` + id) → Scope. */
export function scopeFromSidebarKey(key: string): Scope {
  switch (key) {
    case "Starred":
      return { kind: "starred" };
    case "Read Later":
      return { kind: "later" };
    case "Spoiler":
      return { kind: "spoiler" };
    case "Recently Read":
      return { kind: "recent" };
  }
  if (key.startsWith(LABEL_PREFIX)) return { kind: "label", id: key.slice(LABEL_PREFIX.length) };
  if (key.startsWith(SAVED_SEARCH_PREFIX)) return { kind: "saved-search", id: key.slice(SAVED_SEARCH_PREFIX.length) };
  if (key.startsWith(CATEGORY_PREFIX)) return { kind: "category", id: key.slice(CATEGORY_PREFIX.length) };
  return { kind: "all" };
}

/** Scope → the sidebar's `selectedFeed` / `selectedCategory` highlight props. */
export function sidebarSelectionOf(scope: Scope | null): { selectedFeed: string | null; selectedCategory: string } {
  if (!scope) return { selectedFeed: null, selectedCategory: "" };
  switch (scope.kind) {
    case "all":
      return { selectedFeed: null, selectedCategory: "All" };
    case "feed":
      return { selectedFeed: scope.id, selectedCategory: "All" };
    case "starred":
      return { selectedFeed: null, selectedCategory: "Starred" };
    case "later":
      return { selectedFeed: null, selectedCategory: "Read Later" };
    case "spoiler":
      return { selectedFeed: null, selectedCategory: "Spoiler" };
    case "recent":
      return { selectedFeed: null, selectedCategory: "Recently Read" };
    case "label":
      return { selectedFeed: null, selectedCategory: `${LABEL_PREFIX}${scope.id}` };
    case "saved-search":
      return { selectedFeed: null, selectedCategory: `${SAVED_SEARCH_PREFIX}${scope.id}` };
    case "category":
      return { selectedFeed: null, selectedCategory: categoryKey(scope.id) };
    case "query":
      return { selectedFeed: null, selectedCategory: "" };
  }
}

/** "Mark all read" applies (read-only views have nothing to mark). */
export function canMarkAll(scope: Scope | null): boolean {
  return !!scope && scope.kind !== "recent" && scope.kind !== "spoiler";
}

/** Scope → the `markAllAsRead` action's (legacy) view description; categories by id. */
export function markViewScopeOf(scope: Scope): MarkViewScope {
  switch (scope.kind) {
    case "feed":
      return { feedId: scope.id, category: null };
    case "category":
      // Any non-sentinel name plus the id selects the category by id on the server.
      return { feedId: null, category: CATEGORY_PREFIX, categoryId: scope.id };
    case "query":
      return { feedId: null, category: "All Articles", search: scope.q };
    case "starred":
      return { feedId: null, category: "Starred" };
    case "later":
      return { feedId: null, category: "Read Later" };
    case "spoiler":
      return { feedId: null, category: "Spoiler" };
    case "recent":
      return { feedId: null, category: "Recently Read" };
    case "label":
      return { feedId: null, category: `${LABEL_PREFIX}${scope.id}` };
    case "saved-search":
      return { feedId: null, category: `${SAVED_SEARCH_PREFIX}${scope.id}` };
    case "all":
      return { feedId: null, category: "All" };
  }
}
