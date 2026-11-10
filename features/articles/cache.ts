import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import { qk } from "./keys";
import type { ArticleDetail, ArticleListItem, ArticlePage } from "./types";
import type { ListKey } from "./scope";
import type { Counts } from "@/features/bootstrap/types";
import type { StateField, StateOp } from "./state-batcher";

// Cache helpers over the list (`["list", …]`, infinite `ArticlePage`s), detail
// (`["article", id]`) and counts (`["counts"]`) entries. The TanStack cache is
// the ONLY owner of article entity state (isRead / isStarred / isReadLater /
// labelIds): components never keep article copies (spec §0.4).

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

/**
 * Rewrites cached list rows in place. Unlike `setQueriesData` it keeps each
 * query's `dataUpdatedAt` and `isInvalidated`: an optimistic patch is not a
 * fresh server snapshot, so it must neither restart the rebind staleness
 * clock nor clear a "membership changed, refetch on rebind" mark.
 */
function updateListRows(qc: QueryClient, fn: (item: ArticleListItem) => ArticleListItem | null, queryKey: QueryKey = qk.lists) {
  for (const query of qc.getQueryCache().findAll({ queryKey })) {
    const data = query.state.data;
    const next = mapListItems(data, fn);
    if (next === data) continue;
    const { dataUpdatedAt, isInvalidated } = query.state;
    qc.setQueryData(query.queryKey, next, { updatedAt: dataUpdatedAt });
    if (isInvalidated) void qc.invalidateQueries({ queryKey: query.queryKey, exact: true, refetchType: "none" });
  }
}

/** Applies a field patch to one article in every list page and its detail entry (new objects only where it changed). */
export function patchCachedArticle(qc: QueryClient, id: string, patch: ArticlePatch) {
  const apply = <T extends ArticleListItem>(item: T): T => {
    const keys = Object.keys(patch) as (keyof ArticlePatch)[];
    return keys.every((k) => item[k] === patch[k]) ? item : { ...item, ...patch };
  };
  updateListRows(qc, (item) => (item.id === id ? apply(item) : item));
  qc.setQueryData<ArticleDetail>(qk.article(id), (detail) => (detail ? apply(detail) : detail));
}

/** Patches many articles' fields at once (bulk mark read / undo). */
export function patchCachedArticles(qc: QueryClient, ids: Iterable<string>, patch: ArticlePatch) {
  const set = new Set(ids);
  if (set.size === 0) return;
  updateListRows(qc, (item) => (set.has(item.id) ? { ...item, ...patch } : item));
  for (const id of set) qc.setQueryData<ArticleDetail>(qk.article(id), (detail) => (detail ? { ...detail, ...patch } : detail));
}

/** Drops an article from every cached list page. */
export function removeCachedArticle(qc: QueryClient, id: string) {
  updateListRows(qc, (item) => (item.id === id ? null : item));
}

/** Stale-marks every list without refetching the visible one (it is patched in place). */
export function markListsStale(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: qk.lists, refetchType: "none" });
}

/** Removes a deleted label from every cached row. */
export function removeLabelFromCachedArticles(qc: QueryClient, labelId: string) {
  const strip = <T extends ArticleListItem>(item: T): T =>
    item.labelIds.includes(labelId) ? { ...item, labelIds: item.labelIds.filter((id) => id !== labelId) } : item;
  updateListRows(qc, strip);
  qc.setQueriesData({ queryKey: qk.articles }, (detail: ArticleDetail | undefined) => (detail?.labelIds ? strip(detail) : detail));
}

/**
 * "Something about articles changed on the server" (refresh, retention, rules,
 * bulk spoiler release): lists and counts refetch; details are only marked
 * stale (their flags are patched in place, and the body rarely changes).
 */
export function invalidateArticleQueries(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: qk.lists });
  invalidateCounts(qc);
  qc.invalidateQueries({ queryKey: qk.articles, refetchType: "none" });
}

/** One counts refetch (+ the server-side per-scope counts of saved searches / search). */
export function invalidateCounts(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: qk.counts });
  qc.invalidateQueries({ queryKey: ["view-count"] });
}

// ─── Optimistic state patches (spec §2.4) ────────────────────────────────────

export type StatePatch = Partial<Record<StateField, boolean>>;

type FeedVisibility = { id: string; hideFromAllFeeds?: boolean; category?: { hideFromAllFeeds?: boolean } | null };

/** Feed (or its category) is hidden from "All articles": its unread rows do not count towards `unreadTotal`. */
export function isHiddenFromAll(qc: QueryClient, feedId: string): boolean {
  const feeds = qc.getQueryData<FeedVisibility[]>(qk.feeds);
  const feed = Array.isArray(feeds) ? feeds.find((f) => f.id === feedId) : undefined;
  return !!(feed?.hideFromAllFeeds || feed?.category?.hideFromAllFeeds);
}

const bump = (value: number | undefined, delta: number) => Math.max(0, (value ?? 0) + delta);

/**
 * Counts after `item` changed from its current flags to `changed` (pure).
 * Mirrors the server rules (server/bootstrap.ts#getCounts): spoilers never
 * count; unread moves `byFeed`, `byLabel` and — unless the feed is hidden from
 * "All articles" — `unreadTotal`; star / later move their totals.
 */
export function adjustCounts(counts: Counts, item: Pick<ArticleListItem, "feedId" | "labelIds" | "isSpoiler" | StateField>, changed: StatePatch, hiddenFromAll: boolean): Counts {
  if (item.isSpoiler) return counts;
  let next = counts;
  if (changed.isRead !== undefined && changed.isRead !== item.isRead) {
    const d = changed.isRead ? -1 : 1;
    const byLabel = { ...next.byLabel };
    for (const labelId of item.labelIds) byLabel[labelId] = bump(byLabel[labelId], d);
    next = {
      ...next,
      byFeed: { ...next.byFeed, [item.feedId]: bump(next.byFeed[item.feedId], d) },
      byLabel,
      unreadTotal: hiddenFromAll ? next.unreadTotal : bump(next.unreadTotal, d),
    };
  }
  if (changed.isStarred !== undefined && changed.isStarred !== item.isStarred) {
    next = { ...next, starred: bump(next.starred, changed.isStarred ? 1 : -1) };
  }
  if (changed.isReadLater !== undefined && changed.isReadLater !== item.isReadLater) {
    next = { ...next, later: bump(next.later, changed.isReadLater ? 1 : -1) };
  }
  return next;
}

/** Label membership change of an (unread, non-spoiler) article moves `byLabel` (pure). */
export function adjustLabelCounts(counts: Counts, item: Pick<ArticleListItem, "labelIds" | "isRead" | "isSpoiler">, labelIds: string[]): Counts {
  if (item.isRead || item.isSpoiler) return counts;
  const before = new Set(item.labelIds);
  const after = new Set(labelIds);
  const byLabel = { ...counts.byLabel };
  for (const id of before) if (!after.has(id)) byLabel[id] = bump(byLabel[id], -1);
  for (const id of after) if (!before.has(id)) byLabel[id] = bump(byLabel[id], 1);
  return { ...counts, byLabel };
}

/** Membership lists whose content a field change affects; marked stale, never edited (rows stay until rebind). */
const MEMBERSHIP_SCOPE: Record<StateField, string> = { isRead: "v:recent", isStarred: "v:starred", isReadLater: "v:later" };

/** Scope keys of the cached lists that contain `id`. */
function scopesContaining(qc: QueryClient, id: string): Set<string> {
  const out = new Set<string>();
  for (const [key, data] of qc.getQueriesData<ListData>({ queryKey: qk.lists })) {
    if (!isListData(data)) continue;
    if (data.pages.some((page) => page.items.some((item) => item.id === id))) out.add(String(key[1]));
  }
  return out;
}

/**
 * Server-counted header numbers (`["view-count", scope]`: unread within saved
 * searches, search, Starred, Read later) that this change moves.
 */
function adjustViewCounts(qc: QueryClient, before: ArticleListItem, changed: StatePatch) {
  if (before.isSpoiler) return;
  const move = (scope: string, d: number) =>
    qc.setQueryData<{ unread: number }>(qk.viewCount(scope), (c) => (c ? { unread: bump(c.unread, d) } : c));
  if (changed.isRead !== undefined) {
    const d = changed.isRead ? -1 : 1;
    if (before.isStarred) move("v:starred", d);
    if (before.isReadLater) move("v:later", d);
    for (const scope of scopesContaining(qc, before.id)) if (scope.startsWith("ss:") || scope.startsWith("q:")) move(scope, d);
  }
  const unread = changed.isRead === undefined ? !before.isRead : !changed.isRead;
  if (unread && changed.isStarred !== undefined) move("v:starred", changed.isStarred ? 1 : -1);
  if (unread && changed.isReadLater !== undefined) move("v:later", changed.isReadLater ? 1 : -1);
}

/**
 * The optimistic toggle (spec §2.4 steps 1–5): cancels in-flight counts /
 * detail fetches (their response would overwrite the patch), patches the
 * article in every list page + detail, moves the counts and stale-marks the
 * membership lists. Returns the article as it was and the fields that really
 * changed, or `null` when the article is unknown or nothing changes
 * (idempotent). Synchronous: the UI flips in the same frame.
 */
export function applyArticlePatch(qc: QueryClient, id: string, patch: StatePatch): { before: ArticleListItem; changed: StatePatch } | null {
  const before = findCachedArticle(qc, id);
  if (!before) return null;
  const changed: StatePatch = {};
  for (const field of Object.keys(patch) as StateField[]) {
    if (patch[field] !== undefined && patch[field] !== before[field]) changed[field] = patch[field];
  }
  if (Object.keys(changed).length === 0) return null;

  void qc.cancelQueries({ queryKey: qk.counts });
  void qc.cancelQueries({ queryKey: qk.article(id) });

  patchCachedArticle(qc, id, changed);
  const hidden = isHiddenFromAll(qc, before.feedId);
  qc.setQueryData<Counts>(qk.counts, (counts) => (counts ? adjustCounts(counts, before, changed, hidden) : counts));
  adjustViewCounts(qc, before, changed);
  for (const field of Object.keys(changed) as StateField[]) {
    qc.invalidateQueries({ queryKey: qk.listScope(MEMBERSHIP_SCOPE[field]), refetchType: "none" });
  }
  return { before, changed };
}

/**
 * Prune on rebind (spec §2.3): before a list key is bound again, read rows
 * are dropped from its cached unread snapshot. Never while bound.
 */
export function pruneReadRows(qc: QueryClient, key: ListKey) {
  if (key.show !== "unread") return;
  updateListRows(qc, (item) => (item.isRead ? null : item), qk.list(key));
}

/**
 * Per-field rollback of writes the server did not apply: the inverse patch
 * (cache + counts) only where the field still holds the value the failed
 * write set — a newer toggle, sent or still queued, wins. Returns the ops
 * that were reverted.
 */
export function rollbackFailedOps(qc: QueryClient, failed: StateOp[], hasPending: (id: string, field: StateField) => boolean): StateOp[] {
  const reverted: StateOp[] = [];
  for (const op of failed) {
    if (hasPending(op.id, op.field)) continue;
    const current = findCachedArticle(qc, op.id);
    if (!current || current[op.field] !== op.value) continue;
    applyArticlePatch(qc, op.id, { [op.field]: !op.value });
    reverted.push(op);
  }
  return reverted;
}
