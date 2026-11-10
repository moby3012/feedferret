import { hydrate, type DehydratedState, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { overlayPendingState } from "@/features/articles/cache";
import type { ArticlePage } from "@/features/articles/types";

type Row = Parameters<typeof overlayPendingState>[1];

/** Rows of a list page / an article detail with the batcher's not-yet-sent writes on top. */
function withPendingWrites(qc: QueryClient, key: readonly unknown[], data: unknown): unknown {
  if (!data) return data;
  if (key[0] === "list") {
    const list = data as InfiniteData<ArticlePage>;
    return { ...list, pages: list.pages.map((page) => ({ ...page, items: page.items.map((item) => overlayPendingState(qc, item)) })) };
  }
  if (key[0] === "article") return overlayPendingState(qc, data as Row);
  return data;
}

/**
 * Writes a server snapshot (cold-start bootstrap, spec §2.5) into the client
 * cache — but only the keys the client does not have yet. An existing entry is
 * never touched, whatever the snapshot's age: it may hold optimistic state
 * (a toggle still in the state batcher, an applied-but-unconfirmed patch) that
 * the server has not seen, and the client's own queries keep it fresh anyway.
 * Rows of a newly hydrated list / detail still get the pending writes overlaid.
 *
 * On a document load the cache is empty, so everything is hydrated; on a
 * router refresh / soft navigation back to `/` it is (mostly) a no-op.
 * Returns the hydrated query hashes.
 */
export function hydrateMissing(qc: QueryClient, state: DehydratedState | null | undefined): string[] {
  if (!state) return [];
  const cache = qc.getQueryCache();
  const queries = state.queries
    .filter((q) => !cache.get(q.queryHash))
    .map((q) => ({ ...q, state: { ...q.state, data: withPendingWrites(qc, q.queryKey, q.state.data) } }));
  if (queries.length > 0) hydrate(qc, { mutations: [], queries });
  return queries.map((q) => q.queryHash);
}
