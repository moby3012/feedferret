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
 * Legacy "something about articles changed" invalidation: lists and the old
 * `["articles", …]` count keys refetch; details are only marked stale (their
 * flags are patched in place, and the body rarely changes).
 */
export function invalidateArticleQueries(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["articles"] });
  qc.invalidateQueries({ queryKey: qk.lists });
  qc.invalidateQueries({ queryKey: qk.articles, refetchType: "none" });
}
