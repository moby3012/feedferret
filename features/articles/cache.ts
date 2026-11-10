import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import { qk } from "./keys";
import type { ArticleDetail, ArticleListItem, ArticlePage } from "./types";

// Cache helpers over the list (`["list", …]`, infinite `ArticlePage`s) and
// detail (`["article", id]`) entries. PR 2 of the shell spec replaces the
// legacy mutation hooks with an optimistic batcher on top of these.

type ListData = InfiniteData<ArticlePage, string | null>;
export type ArticlePatch = Partial<Pick<ArticleListItem, "isRead" | "isStarred" | "isReadLater" | "isSpoiler" | "labelIds" | "excerpt">>;
export type CacheSnapshot = Array<[QueryKey, unknown]>;

function isListData(value: unknown): value is ListData {
  return !!value && Array.isArray((value as ListData).pages);
}

/** The article as any cache currently knows it (detail first, then lists). */
export function findCachedArticle(qc: QueryClient, id: string): ArticleListItem | undefined {
  const detail = qc.getQueryData<ArticleDetail>(qk.article(id));
  if (detail) return detail;
  for (const [, data] of qc.getQueriesData<ListData>({ queryKey: qk.lists })) {
    if (!isListData(data)) continue;
    for (const page of data.pages) {
      const hit = page.items.find((item) => item.id === id);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Copies every list + detail entry (for rollback). */
export function snapshotArticleCaches(qc: QueryClient): CacheSnapshot {
  return [...qc.getQueriesData({ queryKey: qk.lists }), ...qc.getQueriesData({ queryKey: qk.articles })];
}

export function restoreArticleCaches(qc: QueryClient, snapshot: CacheSnapshot | undefined) {
  snapshot?.forEach(([key, data]) => qc.setQueryData(key, data));
}

function mapListItems(data: unknown, fn: (item: ArticleListItem) => ArticleListItem | null): unknown {
  if (!isListData(data)) return data;
  let changed = false;
  const pages = data.pages.map((page) => {
    let pageChanged = false;
    const items: ArticleListItem[] = [];
    for (const item of page.items) {
      const next = fn(item);
      if (next !== item) pageChanged = true;
      if (next) items.push(next);
    }
    if (!pageChanged) return page;
    changed = true;
    return { ...page, items };
  });
  return changed ? { ...data, pages } : data;
}

/** Applies a field patch to one article in every list page and its detail entry (new objects only where it changed). */
export function patchCachedArticle(qc: QueryClient, id: string, patch: ArticlePatch) {
  const apply = <T extends ArticleListItem>(item: T): T => {
    const keys = Object.keys(patch) as (keyof ArticlePatch)[];
    return keys.every((k) => item[k] === patch[k]) ? item : { ...item, ...patch };
  };
  qc.setQueriesData({ queryKey: qk.lists }, (data: unknown) => mapListItems(data, (item) => (item.id === id ? apply(item) : item)));
  qc.setQueryData<ArticleDetail>(qk.article(id), (detail) => (detail ? apply(detail) : detail));
}

/** Patches many articles' fields at once (bulk mark read / undo). */
export function patchCachedArticles(qc: QueryClient, ids: Iterable<string>, patch: ArticlePatch) {
  const set = new Set(ids);
  if (set.size === 0) return;
  qc.setQueriesData({ queryKey: qk.lists }, (data: unknown) =>
    mapListItems(data, (item) => (set.has(item.id) ? { ...item, ...patch } : item)),
  );
  for (const id of set) qc.setQueryData<ArticleDetail>(qk.article(id), (detail) => (detail ? { ...detail, ...patch } : detail));
}

/** Drops an article from every cached list page. */
export function removeCachedArticle(qc: QueryClient, id: string) {
  qc.setQueriesData({ queryKey: qk.lists }, (data: unknown) => mapListItems(data, (item) => (item.id === id ? null : item)));
}

/**
 * Carries rows the user acted on this session (`retain`, e.g. read in the
 * unread view) over a refetch that no longer returns them: the server filters
 * read rows out of `show=unread`, but the list must not reshuffle under the
 * reader. Each missing row goes back right after its nearest predecessor from
 * the previous data that is still present (keyset order is stable), or to the
 * top of the first page. Server cursors are untouched.
 */
export function mergeRetainedRows(previous: ListData | undefined, next: ListData, retain: ReadonlySet<string>): ListData {
  if (!previous || retain.size === 0 || next.pages.length === 0) return next;
  const present = new Set<string>();
  for (const page of next.pages) for (const item of page.items) present.add(item.id);
  const oldOrder = previous.pages.flatMap((page) => page.items);
  if (!oldOrder.some((item) => retain.has(item.id) && !present.has(item.id))) return next;

  const pages = next.pages.map((page) => ({ ...page, items: [...page.items] }));
  let anchor: string | null = null; // last row of the old order that is in `next`
  for (const item of oldOrder) {
    if (present.has(item.id)) {
      anchor = item.id;
      continue;
    }
    if (!retain.has(item.id)) continue;
    let placed = false;
    if (anchor) {
      for (const page of pages) {
        const at = page.items.findIndex((row) => row.id === anchor);
        if (at === -1) continue;
        page.items.splice(at + 1, 0, item);
        placed = true;
        break;
      }
    } else {
      pages[0].items.unshift(item);
      placed = true;
    }
    if (!placed) continue;
    present.add(item.id);
    anchor = item.id;
  }
  return { ...next, pages };
}

/** Stale-marks every list without refetching the visible one (it is patched in place). */
export function markListsStale(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: qk.lists, refetchType: "none" });
}

/** Removes a deleted label from every cached row. */
export function removeLabelFromCachedArticles(qc: QueryClient, labelId: string) {
  const strip = <T extends ArticleListItem>(item: T): T =>
    item.labelIds.includes(labelId) ? { ...item, labelIds: item.labelIds.filter((id) => id !== labelId) } : item;
  qc.setQueriesData({ queryKey: qk.lists }, (data: unknown) => mapListItems(data, strip));
  qc.setQueriesData({ queryKey: qk.articles }, (detail: ArticleDetail | undefined) => (detail?.labelIds ? strip(detail) : detail));
}

/**
 * Legacy "something about articles changed" invalidation: lists and the old
 * `["articles", …]` count keys refetch; details are only marked stale (their
 * flags are patched in place, and the body rarely changes).
 */
export function invalidateArticleQueries(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["articles"] });
  qc.invalidateQueries({ queryKey: qk.lists });
  qc.invalidateQueries({ queryKey: qk.articles, refetchType: "none" });
}
