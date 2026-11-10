"use client";

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData, type QueryKey } from "@tanstack/react-query";
import { fetchArticlePage, fetchCluster, fetchHead, shouldRetry } from "./api";
import { findCachedArticle, overlayPendingState, pruneReadRows, trackRowRewrites, waitForArticleWrites } from "./cache";
import { qk } from "./keys";
import type { ListKey } from "./scope";
import { appliedListData, EMPTY_HEAD, isCountsFetch, probeApplies, type ProbeWindow } from "./new-items";
import type { ArticleDetail, ArticleListItem, ArticlePage, HeadProbe } from "./types";
import { fetchDetailOrStored, fetchPageOrStored, recordOpened } from "@/features/offline/offline";
import { useOnline } from "@/features/bootstrap/online";

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
  /** Server time of the first page (`ArticlePage.snapshotAt`); renewed only when the list is refetched. */
  snapshotAt: number | null;
  /** `status: "error"` and a retry is on the wire. */
  isRetrying: boolean;
  retry(): void;
  /** The rows came from the offline store (offline, or the server unreachable) — see `ArticlePage.fromStore`. */
  fromStore: "full" | "sample" | null;
  /** A refetch of the whole list is on the wire (retry of a store-sourced list). */
  isRefetching: boolean;
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
    snapshotAt: data?.pages[0]?.snapshotAt ?? null,
    isRetrying: query.isError && !data && query.isFetching,
    retry,
    fromStore: data?.pages[0]?.fromStore ?? null,
    isRefetching: query.isFetching && !isFetchingNextPage,
  };
}

export interface NewItemsProbe {
  /** Rows of the bound list created after its snapshot (capped at 100; stories in grouped lists). */
  count: number;
  /**
   * Replaces the snapshot with a fresh first page (new rows on top; read rows
   * of an unread list drop out, later pages page in again). Unsettled article
   * writes are awaited first, and rewrites made while the page is on the wire
   * are replayed onto it. `canCommit` is asked right before the write: false
   * keeps the old snapshot (and the buffer). Resolves true when applied. The
   * caller scrolls.
   */
  apply(canCommit?: () => boolean): Promise<boolean>;
  /** One probe now (shared with one already on the wire); the new count, 0 when the list is not probed. */
  recheck(): Promise<number>;
}

/**
 * "↑ N neu" probe of the bound list (spec §2.3 `head`, §4.8). Piggybacks on
 * the counts poll instead of a timer of its own: one `GET …/head` follows
 * every counts response (120 s poll while visible, focus, reconnect, after a
 * sync), only for the active pane, only online. No request on bind: a fresh
 * snapshot has nothing newer yet. Hidden tab → counts do not poll → neither
 * does the probe; offline → paused.
 *
 * The window is `probeWindow`: a fixed `since` (the snapshot) plus the loaded
 * rows past it, which are sent as "already shown" (read when the probe runs,
 * not part of the cache key — paging in such a row does not reset the count).
 */
export function useNewItemsProbe(key: ListKey | null, probeWin: ProbeWindow, o: { active: boolean }): NewItemsProbe {
  const qc = useQueryClient();
  const online = useOnline();
  const { since } = probeWin;
  const probeKey = probeApplies(key) && since != null ? key : null;
  const enabled = !!probeKey && o.active && online;
  const exclude = useRef(probeWin.exclude);
  exclude.current = probeWin.exclude;
  const query = useQuery<HeadProbe>({
    queryKey: probeKey ? [...qk.head(probeKey), since] : ["head", "__none__"],
    queryFn: ({ signal }) => fetchHead(probeKey!, since!, exclude.current, signal),
    enabled,
    // Seeded "nothing new" for a fresh snapshot; only the counts-driven refetch below asks the server.
    initialData: EMPTY_HEAD,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });

  const live = useRef({ enabled, refetch: query.refetch });
  live.current = { enabled, refetch: query.refetch };
  useEffect(
    () =>
      qc.getQueryCache().subscribe((event) => {
        // Joins a probe already on the wire (e.g. `recheck` after a refresh) instead of restarting it.
        if (live.current.enabled && isCountsFetch(event)) void live.current.refetch({ cancelRefetch: false });
      }),
    [qc],
  );

  const recheck = useCallback(async () => {
    if (!live.current.enabled) return 0;
    const result = await live.current.refetch({ cancelRefetch: false });
    return result.data?.count ?? 0;
  }, []);

  const apply = useCallback(
    async (canCommit?: () => boolean) => {
      if (!key) return false;
      const listKey = qk.list(key);
      // Every row rewrite from here on is replayed onto the fetched page…
      const rewrites = trackRowRewrites(qc, listKey);
      try {
        // …which is read only once every earlier write has settled.
        await waitForArticleWrites(qc);
        const page = await fetchArticlePage(key, null);
        if (canCommit && !canCommit()) return false;
        await qc.cancelQueries({ queryKey: listKey, exact: true });
        if (canCommit && !canCommit()) return false;
        const items = page.items.map((item) => overlayPendingState(qc, item));
        qc.setQueryData(listKey, rewrites.replay(appliedListData({ ...page, items })));
        return true;
      } finally {
        rewrites.stop();
      }
    },
    [key, qc],
  );

  return { count: enabled ? query.data.count : 0, apply, recheck };
}

export interface ArticleResult {
  /** The row as any list cache (or the detail) knows it — available before the body. */
  item: ArticleListItem | undefined;
  detail: ArticleDetail | undefined;
  status: "pending" | "ready" | "error";
  /** `status: "error"` and a retry is on the wire. */
  isRetrying: boolean;
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
    isRetrying: !detailQuery.data && detailQuery.isError && detailQuery.isFetching,
    retry,
  };
}

export interface ClusterMembersResult {
  items: ArticleListItem[];
  status: "pending" | "ready" | "error";
  retry(): void;
}

/**
 * The sources of one story cluster (story card "+N Quellen"), fetched when
 * the card is expanded. Cached as a one-page list (`qk.cluster`) so toggles on
 * member rows go through the same optimistic patch as every list row.
 */
const NO_MEMBERS: ArticleListItem[] = [];

export function useClusterMembers(clusterId: string | null): ClusterMembersResult {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: clusterId ? qk.cluster(clusterId) : ["list", "__no-cluster__"],
    queryFn: async ({ signal }): Promise<InfiniteData<ArticlePage, string | null>> => {
      const detail = await fetchCluster(clusterId!, signal);
      const items = detail.members.map((item) => overlayPendingState(qc, item));
      return { pages: [{ items, nextCursor: null }], pageParams: [null] };
    },
    enabled: !!clusterId,
    // Offline: fail fast into the retry state instead of pausing with skeletons forever (like the list / detail queries).
    networkMode: "always",
    staleTime: LIST_REBIND_STALE_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: shouldRetry,
  });
  const { refetch } = query;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  return {
    items: query.data?.pages[0]?.items ?? NO_MEMBERS,
    status: query.data ? "ready" : query.isError ? "error" : "pending",
    retry,
  };
}
