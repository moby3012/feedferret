"use client";

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useInfiniteQuery, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { shouldRetry } from "./api";
import { findCachedArticle, overlayPendingState, pruneReadRows } from "./cache";
import { qk } from "./keys";
import type { ListKey } from "./scope";
import type { ArticleDetail, ArticleListItem, ArticlePage } from "./types";
import { fetchDetailOrStored, fetchPageOrStored, recordOpened } from "@/features/offline/offline";

const DISABLED_KEY = ["list", "__disabled__"] as const;

/**
 * A bound list is a snapshot: it never refetches on its own (no focus /
 * reconnect / interval). Rebinding a key refetches only when its snapshot is
 * older than this or was marked stale (membership changed, server-side
 * change); otherwise the cached rows are reused as they are (spec §2.3).
 */
export const LIST_REBIND_STALE_MS = 10 * 60_000;

export interface ArticleListResult {
  items: ArticleListItem[];
  status: "pending" | "ready" | "error";
  /** Showing the previous key's rows (same scope, other show/sort) while the new one loads. */
  isPlaceholder: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  fetchMore(): void;
  refresh(): Promise<void>;
  /** Cursor-ish id of the newest row (head probe, PR 9). */
  newestCursor: string | null;
  retry(): void;
}

/**
 * One article list, 50 rows per page from `GET /api/app/articles`. Rows carry
 * no body. `active: false` keeps the cached pages but never fetches.
 *
 * Snapshot semantics: marking a row read patches it in place — it stays in
 * the list until the key is bound again (prune on rebind) or the list is
 * explicitly refreshed.
 */
export function useArticleList(key: ListKey | null, o: { active: boolean }): ArticleListResult {
  const qc = useQueryClient();
  const queryKey = (key ? qk.list(key) : DISABLED_KEY) as QueryKey;
  // Prune on rebind, before the observer reads the cache for this render (so
  // the first paint of the rebound list has no read rows). Runs once per bind.
  const boundRef = useRef<string | null>(null);
  const boundHash = key ? JSON.stringify(queryKey) : null;
  if (key && boundRef.current !== boundHash) {
    boundRef.current = boundHash;
    pruneReadRows(qc, key);
  }

  const query = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam, signal }) => {
      const page = await fetchPageOrStored(key!, pageParam, signal);
      return { ...page, items: page.items.map((item) => overlayPendingState(qc, item)) };
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: !!key && o.active,
    // Offline the query still runs: it answers from the offline store (or fails fast) instead of pausing forever.
    networkMode: "always",
    staleTime: LIST_REBIND_STALE_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: shouldRetry,
    // Previous rows only for a show/sort toggle of the same scope; another
    // scope without cache shows skeleton rows, never the old feed.
    placeholderData: (previous, previousQuery) =>
      key && previousQuery && previousQuery.queryKey[1] === key.scopeKey ? previous : undefined,
  });

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, refetch } = query;
  const items = useMemo(() => {
    if (!data) return [] as ArticleListItem[];
    const seen = new Set<string>();
    const out: ArticleListItem[] = [];
    for (const page of data.pages) {
      for (const item of page.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
      }
    }
    return out;
  }, [data]);

  const fetchMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  return {
    items,
    status: query.isError && !data ? "error" : data ? "ready" : "pending",
    isPlaceholder: query.isPlaceholderData,
    hasMore: !!hasNextPage,
    isFetchingMore: isFetchingNextPage,
    fetchMore,
    refresh,
    newestCursor: items[0]?.id ?? null,
    retry,
  };
}

export interface ArticleResult {
  /** The row as any list cache (or the detail) knows it — available before the body. */
  item: ArticleListItem | undefined;
  detail: ArticleDetail | undefined;
  status: "pending" | "ready" | "error";
  retry(): void;
}

const noopSubscribe = () => () => {};

/** One article: list data immediately (from any cached list), body on demand from `GET /api/app/articles/:id`. */
export function useArticle(id: string | null): ArticleResult {
  const qc = useQueryClient();
  const detailQuery = useQuery({
    queryKey: id ? qk.article(id) : ["article", "__none__"],
    queryFn: async ({ signal }) => overlayPendingState(qc, await fetchDetailOrStored(id!, signal)),
    enabled: !!id,
    networkMode: "always",
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    retry: shouldRetry,
  });
  const subscribe = useCallback((onChange: () => void) => qc.getQueryCache().subscribe(onChange), [qc]);
  const item = useSyncExternalStore(
    id ? subscribe : noopSubscribe,
    () => (id ? findCachedArticle(qc, id) : undefined),
    () => undefined,
  );
  const { refetch } = detailQuery;
  // Opened = kept for offline reading (last ~50, plus the flags the reader shows).
  const loaded = detailQuery.data;
  useEffect(() => {
    if (id && loaded && loaded.id === id) void recordOpened(loaded);
  }, [id, loaded]);
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  return {
    item,
    detail: detailQuery.data,
    status: detailQuery.data ? "ready" : detailQuery.isError ? "error" : "pending",
    retry,
  };
}
