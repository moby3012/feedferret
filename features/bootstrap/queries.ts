"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchViewCount, shouldRetry } from "@/features/articles/api";
import { getStateBatcher } from "@/features/articles/batcher-registry";
import { qk } from "@/features/articles/keys";
import { listKeyOf, scopeKey, type Scope } from "@/features/articles/scope";
import { fetchCounts } from "./api";
import { EMPTY_COUNTS, type Counts } from "./types";

export { useOnline } from "./online";

/** Background reconcile interval of the counts (only while the tab is visible). */
export const COUNTS_POLL_MS = 120_000;

/**
 * `["counts"]` — every sidebar / header / badge number. Optimistic toggles
 * patch it in place; it reconciles on the 120 s poll and on focus. A refetch
 * never races pending writes: the query waits until the state batcher is idle
 * (and a toggle cancels a fetch in flight), so a response can never undo an
 * optimistic change.
 */
export function useCountsQuery(enabled = true, o: { poll?: boolean } = {}) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: qk.counts,
    queryFn: async ({ signal }) => {
      await getStateBatcher(qc)?.whenIdle();
      return fetchCounts(signal);
    },
    enabled,
    staleTime: 30_000,
    // Interval timers are per observer: only the owner (`useCounts` in the
    // shell) polls, so N readers never mean N requests per interval.
    refetchInterval: o.poll ? COUNTS_POLL_MS : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: shouldRetry,
  });
}

/** The shell's counts (the one polling observer). */
export function useCounts(enabled = true): Counts {
  return useCountsQuery(enabled, { poll: true }).data ?? EMPTY_COUNTS;
}

type FeedLike = { id: string; categoryId?: string | null };

/** Unread of a scope from `Counts` alone; `undefined` when it needs the server-side per-scope count. */
export function scopeUnreadFromCounts(counts: Counts, scope: Scope, feeds: ReadonlyArray<FeedLike>): number | undefined {
  switch (scope.kind) {
    case "all":
      return counts.unreadTotal;
    case "feed":
      return counts.byFeed[scope.id] ?? 0;
    case "category":
      return feeds.reduce((sum, f) => sum + (f.categoryId === scope.id ? counts.byFeed[f.id] ?? 0 : 0), 0);
    case "label":
      return counts.byLabel[scope.id] ?? 0;
    case "recent":
    case "spoiler":
      // Read-only views: nothing to mark read.
      return 0;
    default:
      return undefined;
  }
}

/**
 * Unread number of the list header for `scope`. From `Counts` where it can be
 * derived; saved searches, search and the Starred / Read-later views (unread
 * *within* the view) use `GET /api/app/articles/count`.
 */
export function useScopeUnread(scope: Scope | null, feeds: ReadonlyArray<FeedLike>, enabled = true): number | undefined {
  const countsQuery = useCountsQuery(enabled);
  const fromCounts = scope && countsQuery.data ? scopeUnreadFromCounts(countsQuery.data, scope, feeds) : undefined;
  const needsServer = !!scope && scopeUnreadFromCounts(EMPTY_COUNTS, scope, feeds) === undefined;
  const viewCount = useQuery({
    queryKey: scope ? qk.viewCount(scopeKey(scope)) : ["view-count", "__none__"],
    queryFn: ({ signal }) => fetchViewCount(listKeyOf(scope!, "all", "new"), signal),
    enabled: enabled && needsServer,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: shouldRetry,
  });
  return needsServer ? viewCount.data?.unread : fromCounts;
}
