import { db } from "@/lib/db";
import { buildAdvancedSearchWhere } from "@/lib/search";
import type { Scope } from "@/features/articles/scope";

/**
 * Scopes the legacy string-based actions (`markAllAsRead`, `getViewUnreadCount`)
 * can express on top of the public `Scope` union: a category addressed by
 * NAME (sidebar/palette today) and the "New Articles" pseudo-category.
 */
export type ViewScopeInput = Scope | { kind: "category-name"; name: string } | { kind: "unread-only" };

/** Keyset columns (all non-null in the scoped set), most significant first; `id` is always last. */
export type KeysetField = "publishedAt" | "createdAt" | "readAt" | "id";

export interface ViewScope {
  // Prisma `ArticleWhereInput`; kept loose like the original builder because it
  // is assembled incrementally and extended by callers (`isRead`, keyset).
  where: any;
  keyset: KeysetField[];
}

/**
 * Builds the Prisma `where` for an article view (feed, category, label, saved
 * search, smart view, search). Shared by the list endpoint, the header unread
 * count and "mark all read", so all three always describe exactly the same set
 * of articles. Every branch is scoped to `userId`: ids of other users' feeds,
 * categories, labels or saved searches simply match nothing.
 *
 * `search` is an extra free-text filter AND-ed onto any scope (legacy callers);
 * `{kind:"query"}` is the same search over every feed.
 */
export async function buildViewScope(userId: string, scope: ViewScopeInput, search?: string | null): Promise<ViewScope> {
  const userPrefs = await db.user.findUnique({
    where: { id: userId },
    select: { hideDuplicates: true },
  });

  const where: any = { userId };
  const and = (clause: unknown) => {
    where.AND = [...(where.AND || []), clause];
  };

  // Hide duplicates that have a known canonical article
  if (userPrefs?.hideDuplicates ?? true) {
    and({ NOT: { isDuplicate: true, duplicateOf: { not: null } } });
  }

  const query = scope.kind === "query" ? scope.q : search ?? undefined;
  const advancedSearchWhere = await buildAdvancedSearchWhere(userId, query);
  if (Object.keys(advancedSearchWhere).length) and(advancedSearchWhere);

  // Stable tiebreaker: feeds whose items lack a parseable date all share the
  // same sync-time fallback publishedAt, so without a secondary sort they'd
  // fall back to undefined DB order. createdAt surfaces newer-synced articles
  // on top; id is the final deterministic key (and makes the keyset unique).
  let keyset: KeysetField[] = ["publishedAt", "createdAt", "id"];
  let isSpoilerView = false;
  const isSearching = !!query?.trim();

  switch (scope.kind) {
    case "feed":
      where.feedId = scope.id;
      break;
    case "all":
      // Exclude feeds and categories marked as hidden from the all-feeds view.
      // Not while searching: global search spans every feed the user owns.
      if (!isSearching) {
        and({
          feed: {
            hideFromAllFeeds: false,
            OR: [{ categoryId: null }, { category: { hideFromAllFeeds: false } }],
          },
        });
      }
      break;
    case "query":
      break;
    case "starred":
      where.isStarred = true;
      break;
    case "later":
      where.isReadLater = true;
      break;
    case "spoiler":
      isSpoilerView = true;
      where.isSpoiler = true;
      break;
    case "recent":
      where.isRead = true;
      where.readAt = { not: null };
      keyset = ["readAt", "id"];
      break;
    case "unread-only":
      where.isRead = false;
      break;
    case "label":
      where.labels = { some: { labelId: scope.id, userId } };
      break;
    case "saved-search": {
      const savedSearch = await db.savedSearch.findUnique({ where: { id: scope.id, userId } });
      if (savedSearch) {
        and(await buildAdvancedSearchWhere(userId, savedSearch.query));
      } else {
        // Unknown (or another user's) saved search: an empty view, never "everything".
        where.id = { in: [] };
      }
      break;
    }
    case "category":
      where.feed = { categoryId: scope.id };
      break;
    case "category-name":
      where.feed = { category: { name: scope.name } };
      break;
  }

  // Spoiler flag is opt-in: filter spoilers out of every view that is not the
  // dedicated Spoiler view so users do not accidentally read them.
  if (!isSpoilerView && where.isSpoiler !== true) and({ isSpoiler: false });

  return { where, keyset };
}

/** Maps the legacy `(feedId, category)` pair used by the old actions and sidebar menus. */
export function legacyViewScopeInput(feedId?: string | null, category?: string | null): ViewScopeInput {
  if (feedId) return { kind: "feed", id: feedId };
  if (!category || category === "All" || category === "All Articles") return { kind: "all" };
  if (category === "Starred") return { kind: "starred" };
  if (category === "Read Later") return { kind: "later" };
  if (category === "Spoiler") return { kind: "spoiler" };
  if (category === "Recently Read") return { kind: "recent" };
  if (category === "New Articles") return { kind: "unread-only" };
  if (category.startsWith("Label:")) return { kind: "label", id: category.slice("Label:".length) };
  if (category.startsWith("Search:")) return { kind: "saved-search", id: category.slice("Search:".length) };
  return { kind: "category-name", name: category };
}
