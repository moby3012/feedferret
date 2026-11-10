// Offline reading store: article bodies in IndexedDB (no dependency, idb-keyval-sized).
//
// Everything is scoped by user id — a record's key is `${userId}:${articleId}` and
// every public function takes the user — and bounded by count + bytes with LRU
// eviction. Owner decision: offline is READ-ONLY, this store is never a write queue.
//
// Layout (public/offline-reader.js reads the same DB — keep the constants in sync,
// tests/features/offline-reader-contract.test.ts guards that):
//   index  — light rows (list item + flags) so lists never deserialize bodies
//   bodies — the full ArticleDetail (sanitized HTML), out-of-line key
//   meta   — small key/values (`activeUser`)
import type { ArticleDetail, ArticleListItem } from "@/features/articles/types";

export const OFFLINE_DB_NAME = "feedferret-offline";
export const OFFLINE_DB_VERSION = 1;
export const INDEX_STORE = "index";
export const BODY_STORE = "bodies";
export const META_STORE = "meta";
export const ACTIVE_USER_KEY = "activeUser";

/** How many opened (not read-later) articles are kept. */
export const MAX_RECENT = 50;
/** Hard ceilings per user, read-later included. */
export const MAX_ENTRIES = 300;
export const MAX_BYTES = 50 * 1024 * 1024;
/** One body bigger than this is not worth the quota. */
export const MAX_ENTRY_BYTES = 4 * 1024 * 1024;

export interface OfflineLimits {
  maxRecent: number;
  maxEntries: number;
  maxBytes: number;
}
export const DEFAULT_LIMITS: OfflineLimits = { maxRecent: MAX_RECENT, maxEntries: MAX_ENTRIES, maxBytes: MAX_BYTES };

/** The light row. `lastAccess` drives LRU; `openedAt` drives "Zuletzt gelesen offline". */
export interface IndexRow {
  key: string;
  userId: string;
  id: string;
  item: ArticleListItem;
  readLater: boolean;
  savedAt: number;
  lastAccess: number;
  openedAt: number | null;
  bytes: number;
}

export interface StoreUsage {
  count: number;
  bytes: number;
}

export const rowKey = (userId: string, id: string) => `${userId}:${id}`;

/** The list-row part of a detail (bodies and AI fields stay out of the index). */
export function toListItem(detail: ArticleDetail): ArticleListItem {
  const { html, contentFormat, aiSummary, aiSummarizedAt, readAt, entities, originalTitle, ...item } = detail;
  return item;
}

type EvictionRow = Pick<IndexRow, "key" | "readLater" | "lastAccess" | "bytes">;

/**
 * Which keys to drop so the rows fit the limits. Pure.
 * 1. opened-but-not-read-later rows beyond `maxRecent` (oldest access first);
 * 2. while over count/bytes: remaining recent rows LRU first, then read-later rows LRU.
 */
export function planEviction(rows: readonly EvictionRow[], limits: OfflineLimits = DEFAULT_LIMITS): string[] {
  const drop = new Set<string>();
  const byAccess = (a: EvictionRow, b: EvictionRow) => a.lastAccess - b.lastAccess || a.key.localeCompare(b.key);
  const recent = rows.filter((r) => !r.readLater).sort(byAccess);
  for (const row of recent.slice(0, Math.max(0, recent.length - limits.maxRecent))) drop.add(row.key);

  let count = rows.length - drop.size;
  let bytes = rows.reduce((sum, r) => sum + (drop.has(r.key) ? 0 : r.bytes), 0);
  const order = [...recent.filter((r) => !drop.has(r.key)), ...rows.filter((r) => r.readLater).sort(byAccess)];
  for (const row of order) {
    if (count <= limits.maxEntries && bytes <= limits.maxBytes) break;
    drop.add(row.key);
    count -= 1;
    bytes -= row.bytes;
  }
  return [...drop];
}

// ---------------------------------------------------------------- IndexedDB plumbing

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    } catch {
      return resolve(null);
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      const index = db.createObjectStore(INDEX_STORE, { keyPath: "key" });
      index.createIndex("byUser", "userId");
      db.createObjectStore(BODY_STORE);
      db.createObjectStore(META_STORE);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/** Tests only: forget the cached connection. */
export async function resetOfflineDbForTests() {
  const db = await dbPromise;
  db?.close();
  dbPromise = null;
}

const done = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

function finished(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("aborted"));
  });
}

/** Runs `fn` against a transaction; any failure (no IDB, quota, private mode) resolves to `fallback`. */
async function withStores<T>(names: string[], mode: IDBTransactionMode, fallback: T, fn: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  try {
    const db = await openDb();
    if (!db) return fallback;
    const tx = db.transaction(names, mode);
    const completed = finished(tx);
    completed.catch(() => {}); // surfaced through the await below; avoid an unhandled rejection if `fn` throws first
    const result = await fn(tx);
    if (mode === "readwrite") await completed;
    return result;
  } catch {
    return fallback;
  }
}

async function userRows(tx: IDBTransaction, userId: string): Promise<IndexRow[]> {
  return done(tx.objectStore(INDEX_STORE).index("byUser").getAll(IDBKeyRange.only(userId))) as Promise<IndexRow[]>;
}

// ---------------------------------------------------------------- public API

export interface SaveOptions {
  readLater?: boolean;
  /** The user opened it: bumps `openedAt` / `lastAccess`. */
  opened?: boolean;
  now?: number;
}

/** Stores (or refreshes) one body. Returns false when it was not stored (too big, no IDB). */
export async function saveArticle(userId: string, detail: ArticleDetail, o: SaveOptions = {}): Promise<boolean> {
  const now = o.now ?? Date.now();
  const bytes = JSON.stringify(detail).length;
  if (bytes > MAX_ENTRY_BYTES) return false;
  const key = rowKey(userId, detail.id);
  return withStores([INDEX_STORE, BODY_STORE], "readwrite", false, async (tx) => {
    const index = tx.objectStore(INDEX_STORE);
    const previous = (await done(index.get(key))) as IndexRow | undefined;
    const row: IndexRow = {
      key,
      userId,
      id: detail.id,
      item: toListItem(detail),
      readLater: o.readLater ?? previous?.readLater ?? detail.isReadLater,
      savedAt: previous?.savedAt ?? now,
      lastAccess: o.opened ? now : (previous?.lastAccess ?? now),
      openedAt: o.opened ? now : (previous?.openedAt ?? null),
      bytes,
    };
    index.put(row);
    tx.objectStore(BODY_STORE).put(detail, key);
    return true;
  });
}

export async function getBody(userId: string, id: string): Promise<ArticleDetail | undefined> {
  return withStores([BODY_STORE], "readonly", undefined, async (tx) => {
    return (await done(tx.objectStore(BODY_STORE).get(rowKey(userId, id)))) as ArticleDetail | undefined;
  });
}

/** Light rows of one user, newest access first. */
export async function listRows(userId: string): Promise<IndexRow[]> {
  const rows = await withStores([INDEX_STORE], "readonly", [] as IndexRow[], (tx) => userRows(tx, userId));
  return rows.sort((a, b) => b.lastAccess - a.lastAccess);
}

export async function hasBody(userId: string, id: string): Promise<boolean> {
  return withStores([INDEX_STORE], "readonly", false, async (tx) => !!(await done(tx.objectStore(INDEX_STORE).getKey(rowKey(userId, id)))));
}

/** Bumps the LRU position (an open from the store). */
export async function touchArticle(userId: string, id: string, now = Date.now()): Promise<void> {
  const key = rowKey(userId, id);
  await withStores([INDEX_STORE], "readwrite", undefined, async (tx) => {
    const store = tx.objectStore(INDEX_STORE);
    const row = (await done(store.get(key))) as IndexRow | undefined;
    if (row) store.put({ ...row, lastAccess: now, openedAt: now });
  });
}

/** Mirrors server-side state changes (read / star / read-later) into the stored copy. */
export async function patchStored(userId: string, id: string, patch: Partial<Pick<ArticleListItem, "isRead" | "isStarred" | "isReadLater" | "labelIds">>): Promise<void> {
  const key = rowKey(userId, id);
  await withStores([INDEX_STORE, BODY_STORE], "readwrite", undefined, async (tx) => {
    const index = tx.objectStore(INDEX_STORE);
    const bodies = tx.objectStore(BODY_STORE);
    const row = (await done(index.get(key))) as IndexRow | undefined;
    if (!row) return;
    index.put({ ...row, item: { ...row.item, ...patch }, readLater: patch.isReadLater ?? row.readLater });
    const body = (await done(bodies.get(key))) as ArticleDetail | undefined;
    if (body) bodies.put({ ...body, ...patch }, key);
  });
}

export async function deleteArticles(userId: string, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  await withStores([INDEX_STORE, BODY_STORE], "readwrite", undefined, async (tx) => {
    for (const id of ids) {
      tx.objectStore(INDEX_STORE).delete(rowKey(userId, id));
      tx.objectStore(BODY_STORE).delete(rowKey(userId, id));
    }
  });
}

/** Applies the limits to one user's rows. Returns the evicted ids. */
export async function enforceLimits(userId: string, limits: OfflineLimits = DEFAULT_LIMITS): Promise<string[]> {
  return withStores([INDEX_STORE, BODY_STORE], "readwrite", [] as string[], async (tx) => {
    const rows = await userRows(tx, userId);
    const drop = planEviction(rows, limits);
    for (const key of drop) {
      tx.objectStore(INDEX_STORE).delete(key);
      tx.objectStore(BODY_STORE).delete(key);
    }
    const dropped = new Set(drop);
    return rows.filter((r) => dropped.has(r.key)).map((r) => r.id);
  });
}

export async function getUsage(userId: string): Promise<StoreUsage> {
  const rows = await withStores([INDEX_STORE], "readonly", [] as IndexRow[], (tx) => userRows(tx, userId));
  return { count: rows.length, bytes: rows.reduce((sum, r) => sum + r.bytes, 0) };
}

/** Everything of every user (logout). Never rejects. */
export async function clearAllOffline(): Promise<void> {
  await withStores([INDEX_STORE, BODY_STORE, META_STORE], "readwrite", undefined, async (tx) => {
    tx.objectStore(INDEX_STORE).clear();
    tx.objectStore(BODY_STORE).clear();
    tx.objectStore(META_STORE).clear();
  });
}

/** Account switch: every row that is not `userId`'s. */
export async function purgeOtherUsers(userId: string): Promise<void> {
  await withStores([INDEX_STORE, BODY_STORE], "readwrite", undefined, async (tx) => {
    const keys = (await done(tx.objectStore(INDEX_STORE).getAllKeys())) as string[];
    const prefix = `${userId}:`;
    for (const key of keys) {
      if (key.startsWith(prefix)) continue;
      tx.objectStore(INDEX_STORE).delete(key);
      tx.objectStore(BODY_STORE).delete(key);
    }
  });
}

export async function setActiveUser(userId: string): Promise<void> {
  await withStores([META_STORE], "readwrite", undefined, async (tx) => {
    tx.objectStore(META_STORE).put(userId, ACTIVE_USER_KEY);
  });
}

export async function getActiveUser(): Promise<string | undefined> {
  return withStores([META_STORE], "readonly", undefined, async (tx) => (await done(tx.objectStore(META_STORE).get(ACTIVE_USER_KEY))) as string | undefined);
}
