import { randomBytes } from "node:crypto";

/**
 * Server-side "Undo" tokens for bulk mark-as-read.
 *
 * `markAllAsRead` stores the exact article ids it changed under a random,
 * user-scoped token; the client undoes with the token only, so it can never
 * send arbitrary ids to the server (no id lists to validate, dedupe or cap).
 *
 * In-memory on purpose: FeedFerret runs as a single Next.js process (one
 * container), tokens live ~10 minutes and an Undo that outlives a restart just
 * reports "could not undo". The map hangs off `globalThis` so dev HMR and
 * separately bundled server-action chunks share one store. If FeedFerret ever
 * runs several replicas, move this to the database.
 */

export const UNDO_TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_TOKENS_PER_USER = 10;
/** Upper bound for all stored ids together (~tens of MB worst case). */
const MAX_TOTAL_IDS = 500_000;

export const UNDO_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;

interface UndoEntry {
  userId: string;
  ids: string[];
  expiresAt: number;
}

const globalStore = globalThis as unknown as { __feedferretUndoTokens?: Map<string, UndoEntry> };
const store = (globalStore.__feedferretUndoTokens ??= new Map<string, UndoEntry>());

function prune(now: number) {
  for (const [token, entry] of store) {
    if (entry.expiresAt <= now) store.delete(token);
  }
}

function evictOldest(predicate: (entry: UndoEntry) => boolean, limitReached: () => boolean) {
  // Map iteration order is insertion order, i.e. oldest first.
  for (const [token, entry] of store) {
    if (!limitReached()) return;
    if (predicate(entry)) store.delete(token);
  }
}

export function createUndoToken(userId: string, ids: string[], now = Date.now()): string {
  prune(now);
  const countFor = () => [...store.values()].filter((e) => e.userId === userId).length;
  evictOldest((e) => e.userId === userId, () => countFor() >= MAX_TOKENS_PER_USER);
  const totalIds = () => [...store.values()].reduce((sum, e) => sum + e.ids.length, 0);
  evictOldest(() => true, () => totalIds() + ids.length > MAX_TOTAL_IDS);

  const token = randomBytes(24).toString("base64url"); // 32 chars, 192 bit
  store.set(token, { userId, ids: [...new Set(ids)], expiresAt: now + UNDO_TOKEN_TTL_MS });
  return token;
}

/** Returns the ids for a live token owned by `userId`, without consuming it. */
export function peekUndoToken(userId: string, token: unknown, now = Date.now()): string[] | null {
  if (typeof token !== "string" || !UNDO_TOKEN_PATTERN.test(token)) return null;
  const entry = store.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    store.delete(token);
    return null;
  }
  // A foreign user's token is indistinguishable from an unknown one.
  if (entry.userId !== userId) return null;
  return entry.ids;
}

export function discardUndoToken(token: string) {
  store.delete(token);
}

/** Test helper. */
export function clearUndoTokens() {
  store.clear();
}
