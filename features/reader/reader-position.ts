// Per-article reading position (.pm/research-reeder.md: "restore position per
// article"). Stored as a ratio of the scrollable height, so a different font
// size / measure / viewport still lands on roughly the same passage. Entries
// expire after 24 h; at most MAX_ENTRIES are kept (oldest dropped).
//
// Which articles someone read (and how far) is account data: the entries live
// under a per-user key (the user the offline layer of this tab knows — set by
// <OfflineSync> while rendering, `null` after logout / revocation, then
// nothing is read or written) and `clearReaderPositions` drops storage + memory
// on logout, session revocation and account switch (lib/logout.ts,
// features/offline/offline-sync.tsx).
import { getOfflineUser } from "@/features/offline/session";

const KEY_PREFIX = "ff:reader-pos:";
/** Pre-scoping key (never shipped to prod, removed on clear). */
const LEGACY_KEY = "ff:reader-pos";
export const POSITION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 200;

type Entry = { r: number; t: number };
type Store = Record<string, Entry>;

let cache: { user: string; store: Store } | null = null;

const storageKey = (user: string) => KEY_PREFIX + user;

function load(user: string, now: number): Store {
  if (cache?.user === user) return cache.store;
  let raw: unknown = null;
  try {
    raw = JSON.parse(localStorage.getItem(storageKey(user)) ?? "null");
  } catch {
    /* unavailable / corrupt: start empty */
  }
  const store: Store = {};
  if (raw && typeof raw === "object") {
    for (const [id, e] of Object.entries(raw as Record<string, Entry>)) {
      if (e && typeof e.r === "number" && typeof e.t === "number" && now - e.t < POSITION_TTL_MS) store[id] = { r: e.r, t: e.t };
    }
  }
  cache = { user, store };
  return store;
}

function persist(user: string, store: Store) {
  const ids = Object.keys(store);
  if (ids.length > MAX_ENTRIES) {
    ids.sort((a, b) => store[a].t - store[b].t);
    for (const id of ids.slice(0, ids.length - MAX_ENTRIES)) delete store[id];
  }
  try {
    localStorage.setItem(storageKey(user), JSON.stringify(store));
  } catch {
    /* quota / private mode: memory only */
  }
}

/** Remembers `ratio` (0–1) for `id`; positions at the very top or the end are forgotten (open at top). */
export function saveReaderPosition(id: string, ratio: number, now = Date.now(), user = getOfflineUser()) {
  if (!user) return;
  const store = load(user, now);
  if (!(ratio > 0.01 && ratio < 0.98)) {
    if (!(id in store)) return;
    delete store[id];
  } else {
    store[id] = { r: Math.round(ratio * 10000) / 10000, t: now };
  }
  persist(user, store);
}

/** The remembered ratio when it is younger than 24 h, else null (also without a signed-in user). */
export function readReaderPosition(id: string, now = Date.now(), user = getOfflineUser()): number | null {
  if (!user) return null;
  const e = load(user, now)[id];
  if (!e || now - e.t >= POSITION_TTL_MS) return null;
  return e.r;
}

/**
 * Forgets reading positions in memory and storage — of every account on this
 * device, or of every account except `keepUser` (account switch: the new
 * account keeps its own).
 */
export function clearReaderPositions(keepUser?: string) {
  if (!keepUser || cache?.user !== keepUser) cache = null;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === LEGACY_KEY || (key?.startsWith(KEY_PREFIX) && (!keepUser || key !== storageKey(keepUser)))) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch {
    /* storage can be unavailable */
  }
}

/** Test hook: forget the in-memory copy (re-read storage on next access). */
export function resetReaderPositionCache() {
  cache = null;
}
