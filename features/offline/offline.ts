import { ApiError, fetchArticleDetail, fetchArticlePage } from "@/features/articles/api";
import type { ListKey } from "@/features/articles/scope";
import type { ArticleDetail, ArticleListItem, ArticlePage } from "@/features/articles/types";
import { isOnline } from "@/features/bootstrap/online";
import { getOfflineScope, getOfflineUser, isOfflineSessionExpired, whenOfflineScope } from "./session";
import { enforceLimits, getBody, listRows, saveArticle, touchArticle, type IndexRow } from "./store";

// Read-side glue between the article queries and the IndexedDB store.

/** Network down, request blocked, or the server unreachable behind a proxy (5xx). 4xx are real answers. */
export function isNetworkFailure(error: unknown): boolean {
  if (error instanceof ApiError) return error.status >= 500;
  return error instanceof Error && error.name !== "AbortError";
}

/** The account whose store may be read right now: known, and verified by the server recently enough (policy in store.ts). */
function readableUser(): string | null {
  const userId = getOfflineUser();
  return userId !== null && !isOfflineSessionExpired() ? userId : null;
}

/** Whether a list/detail request should be answered from the store instead of the network. */
export function shouldReadOffline(): boolean {
  return !isOnline() && readableUser() !== null;
}

// What was answered from the store: after reconnecting these cache entries are
// stale by definition (lists are otherwise snapshots that never refetch on reconnect).
const servedLists = new Map<string, ListKey>();
const servedDetails = new Set<string>();
const servedListeners = new Set<() => void>();

function served() {
  for (const listener of [...servedListeners]) listener();
}

/** Something was just answered from the store (offline, or the server was unreachable): recovery should be watched for. */
export function onServedOffline(listener: () => void): () => void {
  servedListeners.add(listener);
  return () => servedListeners.delete(listener);
}

/** Hands out (and forgets) the cache entries that were served from the store. */
export function takeServedOffline(): { lists: ListKey[]; details: string[] } {
  const out = { lists: [...servedLists.values()], details: [...servedDetails] };
  servedLists.clear();
  servedDetails.clear();
  return out;
}

export async function readStoredDetail(id: string): Promise<ArticleDetail | undefined> {
  const userId = readableUser();
  if (!userId) return undefined;
  const body = await getBody(userId, id);
  if (body) {
    servedDetails.add(id);
    const scope = getOfflineScope();
    if (scope) void touchArticle(scope, id);
    served();
  }
  return body;
}

/** The user opened an article: keep its body (LRU "last opened") and mirror its flags. */
export async function recordOpened(detail: ArticleDetail): Promise<void> {
  // The claim on the store may still be in flight when the very first article is opened.
  const scope = getOfflineScope() ?? (await whenOfflineScope());
  if (!scope) return;
  if ((await saveArticle(scope, detail, { opened: true, readLater: detail.isReadLater })) === "saved") await enforceLimits(scope);
}

function newest(a: ArticleListItem, b: ArticleListItem) {
  return b.publishedAt.localeCompare(a.publishedAt) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

/** Rows of `key`'s scope that the store can answer, or `null` when the scope cannot be derived offline. */
export function itemsForScope(rows: readonly IndexRow[], key: Pick<ListKey, "scopeKey" | "show" | "sort">): ArticleListItem[] | null {
  const [kind, ...rest] = key.scopeKey.split(":");
  const arg = rest.join(":");
  let items: ArticleListItem[];
  if (key.scopeKey === "v:recent") {
    // "Zuletzt gelesen offline": what was opened, last opened first.
    return rows
      .filter((r) => r.openedAt !== null)
      .sort((a, b) => b.openedAt! - a.openedAt!)
      .map((r) => r.item);
  } else if (key.scopeKey === "v:later") items = rows.filter((r) => r.readLater).map((r) => r.item);
  else if (key.scopeKey === "v:starred") items = rows.filter((r) => r.item.isStarred).map((r) => r.item);
  else if (key.scopeKey === "all") items = rows.map((r) => r.item);
  else if (kind === "feed" && arg) items = rows.filter((r) => r.item.feedId === arg).map((r) => r.item);
  else if (kind === "label" && arg) items = rows.filter((r) => r.item.labelIds.includes(arg)).map((r) => r.item);
  else return null;
  if (key.show === "unread") items = items.filter((i) => !i.isRead);
  items.sort(newest);
  return key.sort === "old" ? items.reverse() : items;
}

/** A single page with everything stored for `key` — `null` when there is nothing to show instead of the network. */
export async function readStoredPage(key: ListKey): Promise<ArticlePage | null> {
  const userId = readableUser();
  if (!userId) return null;
  const items = itemsForScope(await listRows(userId), key);
  if (!items) return null;
  // Nothing stored for a scope the store only holds a sample of (a feed, a
  // label, all): that is "not available offline", not an empty list — the
  // caller fails and the list shows its offline / error state (audit R1).
  // "Später lesen" and "Zuletzt gelesen" are stored in full: empty is true.
  if (items.length === 0 && key.scopeKey !== "v:later" && key.scopeKey !== "v:recent") return null;
  servedLists.set(key.id + key.sort, key);
  served();
  return { items, nextCursor: null };
}

/**
 * The network page; offline (or with the server unreachable) the first page
 * comes from the store when the scope can be derived from it (Read later,
 * recently read, starred, feed, label, all). Never a write path.
 */
export async function fetchPageOrStored(key: ListKey, cursor: string | null, signal?: AbortSignal): Promise<ArticlePage> {
  if (cursor === null && shouldReadOffline()) {
    const stored = await readStoredPage(key);
    if (stored) return stored;
  }
  try {
    return await fetchArticlePage(key, cursor, signal);
  } catch (error) {
    if (cursor === null && isNetworkFailure(error)) {
      const stored = await readStoredPage(key);
      if (stored) return stored;
    }
    throw error;
  }
}

export async function fetchDetailOrStored(id: string, signal?: AbortSignal): Promise<ArticleDetail> {
  if (shouldReadOffline()) {
    const stored = await readStoredDetail(id);
    if (stored) return stored;
  }
  try {
    return await fetchArticleDetail(id, signal);
  } catch (error) {
    if (isNetworkFailure(error)) {
      const stored = await readStoredDetail(id);
      if (stored) return stored;
    }
    throw error;
  }
}
