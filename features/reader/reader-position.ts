// Per-article reading position (.pm/research-reeder.md: "restore position per
// article"). Stored as a ratio of the scrollable height, so a different font
// size / measure / viewport still lands on roughly the same passage. Entries
// expire after 24 h; at most MAX_ENTRIES are kept (oldest dropped).

const STORAGE_KEY = "ff:reader-pos";
export const POSITION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 200;

type Entry = { r: number; t: number };
type Store = Record<string, Entry>;

let cache: Store | null = null;

function load(now: number): Store {
  if (cache) return cache;
  let raw: unknown = null;
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    /* unavailable / corrupt: start empty */
  }
  const store: Store = {};
  if (raw && typeof raw === "object") {
    for (const [id, e] of Object.entries(raw as Record<string, Entry>)) {
      if (e && typeof e.r === "number" && typeof e.t === "number" && now - e.t < POSITION_TTL_MS) store[id] = { r: e.r, t: e.t };
    }
  }
  cache = store;
  return store;
}

function persist(store: Store) {
  const ids = Object.keys(store);
  if (ids.length > MAX_ENTRIES) {
    ids.sort((a, b) => store[a].t - store[b].t);
    for (const id of ids.slice(0, ids.length - MAX_ENTRIES)) delete store[id];
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* quota / private mode: memory only */
  }
}

/** Remembers `ratio` (0–1) for `id`; positions at the very top or the end are forgotten (open at top). */
export function saveReaderPosition(id: string, ratio: number, now = Date.now()) {
  const store = load(now);
  if (!(ratio > 0.01 && ratio < 0.98)) {
    if (!(id in store)) return;
    delete store[id];
  } else {
    store[id] = { r: Math.round(ratio * 10000) / 10000, t: now };
  }
  persist(store);
}

/** The remembered ratio when it is younger than 24 h, else null. */
export function readReaderPosition(id: string, now = Date.now()): number | null {
  const e = load(now)[id];
  if (!e || now - e.t >= POSITION_TTL_MS) return null;
  return e.r;
}

/** Test hook: forget the in-memory copy (re-read storage on next access). */
export function resetReaderPositionCache() {
  cache = null;
}
