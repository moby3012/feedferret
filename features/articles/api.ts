import type { ArticleDetail, ArticlePage, ClusterDetail, HeadProbe } from "./types";
import { headUrl } from "./new-items";
import type { ListKey } from "./scope";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

/** 4xx are final (auth, validation, not found); 5xx and network errors may be retried. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < 2;
}

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin", headers: { accept: "application/json" }, cache: "no-store", signal });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (typeof body?.error?.message === "string") message = body.error.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export const PAGE_SIZE = 50;

/** `GET /api/app/articles` URL for a list key (+ page cursor). The key's canonical id carries the scope params. */
export function articlesUrl(key: ListKey, cursor?: string | null, limit = PAGE_SIZE): string {
  const params = new URLSearchParams(key.id.startsWith("/?") ? key.id.slice(2) : "");
  params.set("show", key.show);
  params.set("sort", key.sort);
  if (cursor) params.set("cursor", cursor);
  params.set("limit", String(limit));
  return `/api/app/articles?${params.toString()}`;
}

export function fetchArticlePage(key: ListKey, cursor: string | null, signal?: AbortSignal): Promise<ArticlePage> {
  return getJson<ArticlePage>(articlesUrl(key, cursor), signal);
}

export function fetchArticleDetail(id: string, signal?: AbortSignal): Promise<ArticleDetail> {
  return getJson<ArticleDetail>(`/api/app/articles/${encodeURIComponent(id)}`, signal);
}

/** `GET /api/app/articles/count` — unread of one scope (only used for saved searches and ad-hoc search). */
export function fetchViewCount(key: ListKey, signal?: AbortSignal): Promise<{ unread: number }> {
  const params = new URLSearchParams(key.id.startsWith("/?") ? key.id.slice(2) : "");
  params.delete("show");
  return getJson<{ unread: number }>(`/api/app/articles/count?${params.toString()}`, signal);
}

/** `GET /api/app/clusters/:id` — every visible source of one story (slim rows, oldest first). */
export function fetchCluster(id: string, signal?: AbortSignal): Promise<ClusterDetail> {
  return getJson<ClusterDetail>(`/api/app/clusters/${encodeURIComponent(id)}`, signal);
}

/** `GET /api/app/articles/head` — rows of the list created after `since` (the "↑ N neu" probe). */
export function fetchHead(key: ListKey, since: number, signal?: AbortSignal): Promise<HeadProbe> {
  return getJson<HeadProbe>(headUrl(key, since), signal);
}
