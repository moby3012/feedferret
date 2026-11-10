import type { QueryClient } from "@tanstack/react-query";
import { fetchArticleDetail, fetchArticlePage, shouldRetry } from "./api";
import { qk } from "./keys";
import type { ListKey } from "./scope";
import type { ArticlePage } from "./types";

// Prefetch on intent (spec §2.4): cheap, idempotent, never refetches what is cached.

/** Article body (detail) — row pointerdown, focus move, next ids after opening the reader. */
export function prefetchArticle(qc: QueryClient, id: string) {
  void qc.prefetchQuery({
    queryKey: qk.article(id),
    queryFn: ({ signal }) => fetchArticleDetail(id, signal),
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    retry: shouldRetry,
  });
}

/** First page of a list, only if nothing is cached for the key. */
export function prefetchList(qc: QueryClient, key: ListKey) {
  if (qc.getQueryData(qk.list(key)) !== undefined) return;
  void qc.prefetchInfiniteQuery({
    queryKey: qk.list(key),
    queryFn: ({ pageParam, signal }) => fetchArticlePage(key, pageParam as string | null, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last: ArticlePage) => last.nextCursor,
    retry: shouldRetry,
  });
}
