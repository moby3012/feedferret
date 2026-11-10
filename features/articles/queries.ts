"use client";

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { replaceEqualDeep, useInfiniteQuery, useQuery, useQueryClient, type InfiniteData, type QueryKey } from "@tanstack/react-query";
import { fetchArticleDetail, fetchArticlePage, shouldRetry } from "./api";
import { findCachedArticle, mergeRetainedRows } from "./cache";
import { qk } from "./keys";
import type { ListKey } from "./scope";
import type { ArticleDetail, ArticleListItem, ArticlePage } from "./types";

const DISABLED_KEY = ["list", "__disabled__"] as const;
const NO_IDS: ReadonlySet<string> = new Set();

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
 * `retainIds`: rows a refetch must not drop (read this session in the unread
 * view) — they stay in the cache at their previous position.
 */
export function useArticleList(key: ListKey | null, o: { active: boolean; retainIds?: ReadonlySet<string> }): ArticleListResult {
  const retainRef = useRef<ReadonlySet<string>>(o.retainIds ?? NO_IDS);
  useEffect(() => {
    retainRef.current = o.retainIds ?? NO_IDS;
  }, [o.retainIds]);

  const query = useInfiniteQuery({
    queryKey: (key ? qk.list(key) : DISABLED_KEY) as QueryKey,
    queryFn: ({ pageParam, signal }) => fetchArticlePage(key!, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: !!key && o.active,
    staleTime: 30_000,
    // No refetch behind the reader's back until the optimistic batcher (shell
    // PR 2): a focus refetch would re-page the list while the user reads it.
    refetchOnWindowFocus: false,
    structuralSharing: (previous, next) =>
      replaceEqualDeep(
        previous,
        mergeRetainedRows(
          previous as InfiniteData<ArticlePage, string | null> | undefined,
          next as InfiniteData<ArticlePage, string | null>,
          retainRef.current,
        ),
      ),
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
    queryFn: ({ signal }) => fetchArticleDetail(id!, signal),
    enabled: !!id,
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
