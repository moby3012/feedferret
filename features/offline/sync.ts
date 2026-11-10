import { fetchArticleDetail, fetchArticlePage } from "@/features/articles/api";
import { listKeyOf } from "@/features/articles/scope";
import type { ArticleDetail, ArticlePage } from "@/features/articles/types";
import { MAX_BYTES, MAX_ENTRIES, MAX_RECENT, enforceLimits, getUsage, listRows, patchStored, saveArticle, type OfflineScope } from "./store";

// Background prefetch of the Read-later bodies (read-only offline: the server
// stays the source of truth, the store only mirrors it).

/** Read-later rows kept at most; the rest of MAX_ENTRIES is the "last opened" budget. */
export const MAX_LATER = MAX_ENTRIES - MAX_RECENT;
/** Bodies fetched per run — the next trigger continues. */
export const BODIES_PER_RUN = 25;
/** Stop prefetching when the store is this full (otherwise eviction and refetch would chase each other). */
const FULL_RATIO = 0.9;

export interface ReconcileDeps {
  fetchPage(cursor: string | null, signal?: AbortSignal): Promise<ArticlePage>;
  fetchDetail(id: string, signal?: AbortSignal): Promise<ArticleDetail>;
  /** Waits between two body fetches (throttle). */
  pause(): Promise<void>;
  saveData(): boolean;
  /** Offline, unmounted, signed out or the account changed: stop (the in-flight response is dropped). */
  stopped(): boolean;
  /** Aborted on logout / account change / unmount so pending requests end instead of answering into a dead session. */
  signal?: AbortSignal;
}

export interface ReconcileResult {
  /** Bodies stored in this run. */
  saved: number;
  /** Stored rows that are no longer Read later. */
  demoted: number;
  /** Read-later articles still without a body (next run). */
  missing: number;
  /** The server list could not be read: nothing was changed. */
  failed: boolean;
  /** The browser refused a write (storage full) even after evicting older entries. */
  quota?: boolean;
}

/** `requestIdleCallback`-paced delay: never competes with input, never hammers the server. */
export function idlePause(ms = 400): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: 2000 });
      else resolve();
    }, ms);
  });
}

export function prefersSavedData(): boolean {
  return (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
}

export function networkDeps(stopped: () => boolean, signal?: AbortSignal): ReconcileDeps {
  const key = listKeyOf({ kind: "later" }, "all", "new");
  return {
    fetchPage: (cursor, s) => fetchArticlePage(key, cursor, s),
    fetchDetail: (id, s) => fetchArticleDetail(id, s),
    pause: () => idlePause(),
    saveData: prefersSavedData,
    stopped,
    signal,
  };
}

/**
 * One mirror pass for `scope`. Cancellation: every await below is followed by a `stopped()` check, requests carry
 * `deps.signal`, and every store write re-checks the session generation inside its IndexedDB transaction — a pass
 * that is still running when the session ends cannot leave anything behind.
 */
export async function reconcileReadLater(scope: OfflineScope, deps: ReconcileDeps, bodiesPerRun = BODIES_PER_RUN): Promise<ReconcileResult> {
  const { userId } = scope;
  const result: ReconcileResult = { saved: 0, demoted: 0, missing: 0, failed: false };

  // 1. The server's Read-later list (slim rows, newest first).
  const later = new Map<string, ArticlePage["items"][number]>();
  let complete = false;
  try {
    let cursor: string | null = null;
    while (later.size < MAX_LATER) {
      const page: ArticlePage = await deps.fetchPage(cursor, deps.signal);
      if (deps.stopped()) return { ...result, failed: true };
      for (const item of page.items) later.set(item.id, item);
      cursor = page.nextCursor;
      if (!cursor) {
        complete = true;
        break;
      }
    }
  } catch {
    return { ...result, failed: true };
  }

  // 2. Mirror: dropped from Read later → demoted to "recently opened" (LRU decides how long it stays);
  //    flags of kept rows follow the server.
  const rows = await listRows(userId);
  const stored = new Map(rows.map((r) => [r.id, r]));
  for (const row of rows) {
    if (deps.stopped()) return { ...result, failed: true };
    const fresh = later.get(row.id);
    if (!fresh) {
      if (row.readLater && complete) {
        await patchStored(scope, row.id, { isReadLater: false });
        result.demoted += 1;
      }
    } else if (!row.readLater || row.item.isRead !== fresh.isRead || row.item.isStarred !== fresh.isStarred) {
      await patchStored(scope, row.id, { isReadLater: true, isRead: fresh.isRead, isStarred: fresh.isStarred });
    }
  }

  // 3. Bodies we do not have yet.
  const todo = [...later.keys()].filter((id) => !stored.has(id));
  result.missing = todo.length;
  if (deps.saveData() || deps.stopped()) return result;
  let usage = await getUsage(userId);
  for (const id of todo.slice(0, bodiesPerRun)) {
    if (deps.stopped() || usage.bytes >= MAX_BYTES * FULL_RATIO) break;
    await deps.pause();
    if (deps.stopped()) break;
    try {
      const detail = await deps.fetchDetail(id, deps.signal);
      // The response may arrive after logout / an account switch: drop it (the store would refuse it too).
      if (deps.stopped()) break;
      const outcome = await saveArticle(scope, detail, { readLater: true });
      if (outcome === "saved") {
        result.saved += 1;
        result.missing -= 1;
        usage = { count: usage.count + 1, bytes: usage.bytes + JSON.stringify(detail).length };
      } else if (outcome === "quota") {
        result.quota = true; // storage is full: stop hammering, the settings line reports it
        break;
      } else if (outcome === "stale") {
        break; // the session this pass belongs to is gone
      }
    } catch {
      break; // offline again or server unhappy: the next trigger resumes
    }
  }
  await enforceLimits(scope);
  return result;
}
