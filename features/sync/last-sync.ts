// Browser-side "last completed boot sync" per signed-in user (spec §2.5.4).
// Keyed by user id: on a shared browser one account's sync says nothing about
// another's feeds. Cleared on sign-out (lib/logout.ts).

const PREFIX = "lastSync:";
/** Pre-per-user key (one value for whoever was signed in). */
const LEGACY_KEY = "lastSync";

/** `localStorage`, or null where even touching it throws (blocked site data). */
export function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export const lastSyncKey = (userId: string) => `${PREFIX}${userId}`;

/** Whether this user's last confirmed sync finished less than `withinMs` ago. */
export function syncedWithin(storage: Storage | null, userId: string, withinMs: number, now = Date.now()): boolean {
  if (!storage) return false;
  try {
    const last = Date.parse(storage.getItem(lastSyncKey(userId)) ?? "");
    return Number.isFinite(last) && now - last >= 0 && now - last < withinMs;
  } catch {
    return false;
  }
}

/**
 * Stamps the sync only when the server confirms it ran for this user
 * (`{ success: true }`). `already_syncing` means another sync — possibly of
 * another user on the same instance — holds the lock; nothing ran for us.
 * Returns whether it stamped.
 */
export function recordSyncResult(storage: Storage | null, userId: string, body: unknown, now = new Date()): boolean {
  if (!storage || !body || typeof body !== "object" || (body as { success?: unknown }).success !== true) return false;
  try {
    storage.setItem(lastSyncKey(userId), now.toISOString());
    return true;
  } catch {
    return false;
  }
}

/** Removes every user's stamp (and the legacy shared one). */
export function clearLastSync(storage: Storage) {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && (key === LEGACY_KEY || key.startsWith(PREFIX))) keys.push(key);
  }
  keys.forEach((key) => storage.removeItem(key));
}
