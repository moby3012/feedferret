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
//   meta   — small key/values: `session` ({userId, gen, verifiedAt}), `status` (quota)
//
// Session policy (the offline page and every tab rely on it):
//   * `session` is the single record that says whose data the store holds. `gen` is a random
//     generation id that changes whenever the device's account changes or the session ends.
//   * EVERY write is bound to (userId, gen) and re-checks `session` inside its own IndexedDB
//     transaction — a stale tab / an in-flight fetch that answers after logout writes nothing.
//   * `verifiedAt` = last time the server confirmed the session (page render or GET /api/app/session).
//     Data older than OFFLINE_MAX_AGE_MS since then is not shown any more and is cleared.
import type { ArticleDetail, ArticleListItem } from "@/features/articles/types";

export const OFFLINE_DB_NAME = "feedferret-offline";
export const OFFLINE_DB_VERSION = 1;
export const INDEX_STORE = "index";
export const BODY_STORE = "bodies";
export const META_STORE = "meta";
export const SESSION_KEY = "session";
export const STATUS_KEY = "status";

/**
 * How long the stored data may be shown without the server confirming the session again.
 * Mirrors the NextAuth JWT session lifetime (30 days, sliding): older than that, the cookie is
 * dead anyway, so the offline copy must not outlive it. public/offline-reader.js repeats this value.
 */
export const OFFLINE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** A `verifiedAt` this far in the future means the clock was turned back: do not trust it. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

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

/** Whose data this tab may write, and in which session generation. */
export interface OfflineScope {
  userId: string;
  gen: string;
}

export interface OfflineSession extends OfflineScope {
  verifiedAt: number;
}

/** Persisted so the settings page (another page load) can report what happened during syncing. */
export interface OfflineStatus {
  /** The last save failed even after evicting older entries (browser storage full). */
  quotaFailed: boolean;
  quotaAt: number;
  /** Entries evicted to make room. */
  evicted: number;
}

export type SaveOutcome = "saved" | "too-big" | "unavailable" | "stale" | "quota";

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

/**
 * Which keys to drop after the browser refused a write (QuotaExceededError). Pure.
 * Oldest first, "recently opened" rows before Read-later rows (those are re-fetched by the sync, so they
 * go last); frees at least twice the size of what is being stored and at least `minDrop` rows so the
 * retry has real room.
 */
export function planQuotaEviction(rows: readonly EvictionRow[], neededBytes: number, minDrop = 3): string[] {
  const byAccess = (a: EvictionRow, b: EvictionRow) => a.lastAccess - b.lastAccess || a.key.localeCompare(b.key);
  const order = [...rows.filter((r) => !r.readLater).sort(byAccess), ...rows.filter((r) => r.readLater).sort(byAccess)];
  const drop: string[] = [];
  let freed = 0;
  for (const row of order) {
    if (drop.length >= minDrop && freed >= neededBytes * 2) break;
    drop.push(row.key);
    freed += row.bytes;
  }
  return drop;
}

/** Whether stored data verified at `verifiedAt` may still be shown at `now`. Pure. */
export function isSessionFresh(verifiedAt: number | undefined, now = Date.now()): boolean {
  if (typeof verifiedAt !== "number" || !Number.isFinite(verifiedAt)) return false;
  return now - verifiedAt <= OFFLINE_MAX_AGE_MS && verifiedAt - now <= CLOCK_SKEW_MS;
}

export function isQuotaError(error: unknown): boolean {
  const e = error as { name?: string; code?: number } | null | undefined;
  return !!e && (e.name === "QuotaExceededError" || e.code === 22);
}

function newGeneration(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* insecure context */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
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

/**
 * Runs `fn` against a transaction; any failure (no IDB, quota, private mode) resolves to `fallback`.
 * `rethrowQuota`: a QuotaExceededError is thrown instead, for callers that can make room and retry.
 */
async function withStores<T>(names: string[], mode: IDBTransactionMode, fallback: T, fn: (tx: IDBTransaction) => Promise<T>, rethrowQuota = false): Promise<T> {
  let tx: IDBTransaction | undefined;
  try {
    const db = await openDb();
    if (!db) return fallback;
    tx = db.transaction(names, mode);
    const completed = finished(tx);
    completed.catch(() => {}); // surfaced through the await below; avoid an unhandled rejection if `fn` throws first
    const result = await fn(tx);
    if (mode === "readwrite") await completed;
    return result;
  } catch (error) {
    try {
      tx?.abort(); // never let a half-written transaction commit
    } catch {
      /* already finished */
    }
    if (rethrowQuota && isQuotaError(error)) throw error;
    return fallback;
  }
}

async function userRows(tx: IDBTransaction, userId: string): Promise<IndexRow[]> {
  return done(tx.objectStore(INDEX_STORE).index("byUser").getAll(IDBKeyRange.only(userId))) as Promise<IndexRow[]>;
}

async function readSessionIn(tx: IDBTransaction): Promise<OfflineSession | undefined> {
  return (await done(tx.objectStore(META_STORE).get(SESSION_KEY))) as OfflineSession | undefined;
}

/** The write gate, evaluated INSIDE the writing transaction: still the session this scope was issued for? */
async function sessionMatches(tx: IDBTransaction, scope: OfflineScope): Promise<boolean> {
  const session = await readSessionIn(tx);
  return !!session && session.userId === scope.userId && session.gen === scope.gen;
}

/** A readwrite transaction that does nothing (returns `fallback`) unless `scope` is still the live session. */
function writeAs<T>(scope: OfflineScope, names: string[], fallback: T, fn: (tx: IDBTransaction) => Promise<T>, rethrowQuota = false): Promise<T> {
  return withStores([...names, META_STORE], "readwrite", fallback, async (tx) => ((await sessionMatches(tx, scope)) ? fn(tx) : fallback), rethrowQuota);
}

// ---------------------------------------------------------------- session

/**
 * This tab (signed in as `userId` per the server) takes over the store. Same account → the generation is kept
 * (several tabs share it); anything else (other account, ended session, first use) → everything stored is
 * dropped and a NEW generation is issued, which turns every writer of the previous one into a rejected stale writer.
 * `null` = no IndexedDB (the offline layer stays inert).
 */
export async function claimSession(userId: string, now = Date.now()): Promise<{ gen: string; changed: boolean } | null> {
  return withStores([INDEX_STORE, BODY_STORE, META_STORE], "readwrite", null, async (tx) => {
    const meta = tx.objectStore(META_STORE);
    const current = await readSessionIn(tx);
    if (current && current.userId === userId) {
      meta.put({ ...current, verifiedAt: now }, SESSION_KEY);
      return { gen: current.gen, changed: false };
    }
    tx.objectStore(INDEX_STORE).clear();
    tx.objectStore(BODY_STORE).clear();
    meta.clear();
    const gen = newGeneration();
    meta.put({ userId, gen, verifiedAt: now } satisfies OfflineSession, SESSION_KEY);
    return { gen, changed: true };
  });
}

/** The server confirmed the session just now. No-op for a stale scope. */
export async function markVerified(scope: OfflineScope, now = Date.now()): Promise<void> {
  await writeAs(scope, [], undefined, async (tx) => {
    const session = await readSessionIn(tx);
    if (session) tx.objectStore(META_STORE).put({ ...session, verifiedAt: now }, SESSION_KEY);
  });
}

export async function readSession(): Promise<OfflineSession | undefined> {
  return withStores([META_STORE], "readonly", undefined, readSessionIn);
}

export async function getActiveUser(): Promise<string | undefined> {
  return (await readSession())?.userId;
}

export async function readStatus(): Promise<OfflineStatus | undefined> {
  return withStores([META_STORE], "readonly", undefined, async (tx) => (await done(tx.objectStore(META_STORE).get(STATUS_KEY))) as OfflineStatus | undefined);
}

// ---------------------------------------------------------------- public API

export interface SaveOptions {
  readLater?: boolean;
  /** The user opened it: bumps `openedAt` / `lastAccess`. */
  opened?: boolean;
  now?: number;
}

/**
 * Stores (or refreshes) one body. When the browser refuses ("quota"), older entries are evicted and the write
 * is retried once; a second refusal is recorded in the status line of the settings. Never throws.
 */
export async function saveArticle(scope: OfflineScope, detail: ArticleDetail, o: SaveOptions = {}): Promise<SaveOutcome> {
  const now = o.now ?? Date.now();
  const bytes = JSON.stringify(detail).length;
  if (bytes > MAX_ENTRY_BYTES) return "too-big";
  const key = rowKey(scope.userId, detail.id);
  const attempt = () =>
    writeAs<SaveOutcome>(
      scope,
      [INDEX_STORE, BODY_STORE],
      "stale",
      async (tx) => {
        const index = tx.objectStore(INDEX_STORE);
        const previous = (await done(index.get(key))) as IndexRow | undefined;
        const row: IndexRow = {
          key,
          userId: scope.userId,
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
        return "saved";
      },
      true,
    );
  try {
    const outcome = await attempt();
    if (outcome === "saved") await clearQuotaFlag(scope);
    return outcome;
  } catch {
    // Quota: make room (oldest first), then one more try.
    const evicted = await evictForQuota(scope, bytes);
    try {
      const outcome = await attempt();
      if (outcome === "saved") await recordStatus(scope, { quotaFailed: false, quotaAt: Date.now(), evicted });
      return outcome;
    } catch {
      await recordStatus(scope, { quotaFailed: true, quotaAt: Date.now(), evicted });
      return "quota";
    }
  }
}

async function evictForQuota(scope: OfflineScope, neededBytes: number): Promise<number> {
  return writeAs(scope, [INDEX_STORE, BODY_STORE], 0, async (tx) => {
    const drop = planQuotaEviction(await userRows(tx, scope.userId), neededBytes);
    for (const key of drop) {
      tx.objectStore(INDEX_STORE).delete(key);
      tx.objectStore(BODY_STORE).delete(key);
    }
    return drop.length;
  });
}

async function recordStatus(scope: OfflineScope, status: OfflineStatus): Promise<void> {
  await writeAs(scope, [], undefined, async (tx) => {
    tx.objectStore(META_STORE).put(status, STATUS_KEY);
  });
}

async function clearQuotaFlag(scope: OfflineScope): Promise<void> {
  const status = await readStatus();
  if (!status?.quotaFailed) return;
  await writeAs(scope, [], undefined, async (tx) => {
    tx.objectStore(META_STORE).delete(STATUS_KEY);
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
export async function touchArticle(scope: OfflineScope, id: string, now = Date.now()): Promise<void> {
  const key = rowKey(scope.userId, id);
  await writeAs(scope, [INDEX_STORE], undefined, async (tx) => {
    const store = tx.objectStore(INDEX_STORE);
    const row = (await done(store.get(key))) as IndexRow | undefined;
    if (row) store.put({ ...row, lastAccess: now, openedAt: now });
  });
}

/** Mirrors server-side state changes (read / star / read-later) into the stored copy. */
export async function patchStored(scope: OfflineScope, id: string, patch: Partial<Pick<ArticleListItem, "isRead" | "isStarred" | "isReadLater" | "labelIds">>): Promise<void> {
  const key = rowKey(scope.userId, id);
  await writeAs(scope, [INDEX_STORE, BODY_STORE], undefined, async (tx) => {
    const index = tx.objectStore(INDEX_STORE);
    const bodies = tx.objectStore(BODY_STORE);
    const row = (await done(index.get(key))) as IndexRow | undefined;
    if (!row) return;
    index.put({ ...row, item: { ...row.item, ...patch }, readLater: patch.isReadLater ?? row.readLater });
    const body = (await done(bodies.get(key))) as ArticleDetail | undefined;
    if (body) bodies.put({ ...body, ...patch }, key);
  });
}

export async function deleteArticles(scope: OfflineScope, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  await writeAs(scope, [INDEX_STORE, BODY_STORE], undefined, async (tx) => {
    for (const id of ids) {
      tx.objectStore(INDEX_STORE).delete(rowKey(scope.userId, id));
      tx.objectStore(BODY_STORE).delete(rowKey(scope.userId, id));
    }
  });
}

/** Applies the limits to one user's rows. Returns the evicted ids. */
export async function enforceLimits(scope: OfflineScope, limits: OfflineLimits = DEFAULT_LIMITS): Promise<string[]> {
  return writeAs(scope, [INDEX_STORE, BODY_STORE], [] as string[], async (tx) => {
    const rows = await userRows(tx, scope.userId);
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

/** Everything of every user AND the session record (logout, login page). Later writes of any scope are rejected. Never rejects. */
export async function clearAllOffline(): Promise<void> {
  await withStores([INDEX_STORE, BODY_STORE, META_STORE], "readwrite", undefined, async (tx) => {
    tx.objectStore(INDEX_STORE).clear();
    tx.objectStore(BODY_STORE).clear();
    tx.objectStore(META_STORE).clear();
  });
}

/**
 * The server says this scope's session is dead: clear everything — but only if the store still belongs to that
 * session. (A 401 that answers after another account claimed the device must not wipe the new account's data.)
 */
export async function clearIfSessionCurrent(scope: OfflineScope): Promise<boolean> {
  return withStores([INDEX_STORE, BODY_STORE, META_STORE], "readwrite", false, async (tx) => {
    if (!(await sessionMatches(tx, scope))) return false;
    tx.objectStore(INDEX_STORE).clear();
    tx.objectStore(BODY_STORE).clear();
    tx.objectStore(META_STORE).clear();
    return true;
  });
}

/** Settings "clear offline data": the stored articles go, the session (and with it syncing) stays. */
export async function clearOfflineArticles(): Promise<void> {
  await withStores([INDEX_STORE, BODY_STORE, META_STORE], "readwrite", undefined, async (tx) => {
    tx.objectStore(INDEX_STORE).clear();
    tx.objectStore(BODY_STORE).clear();
    tx.objectStore(META_STORE).delete(STATUS_KEY);
  });
}
