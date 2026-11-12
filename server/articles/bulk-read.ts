import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getDatabaseProvider } from "@/lib/db-provider";
import { logger } from "@/lib/logger";

// Set-based bulk read-state writes ("mark all read" of a feed / folder / view,
// GReader `mark-all-as-read`, Fever `mark=feed|group`, REST v1 / MCP, Undo).
//
// Why not one `updateMany` (or one transaction) over the whole scope:
//  * Postgres: flipping `isRead` / `readAt` can never be a HOT update (both are
//    indexed), so every row writes a new tuple into EVERY Article index —
//    ~26 of them, five of them pg_trgm GIN indexes over title / content.
//    45 k rows took ~5 s in one statement / transaction, and every row lock
//    was held until the end: a feed sync updating one of those articles
//    waited the whole time (or deadlocked against the chunk order).
//  * SQLite: one writer at a time — a long write transaction stalls every
//    other write (the sync) until it commits.
//  * Prisma's `@updatedAt` stamps `updatedAt` on every `updateMany` row. Read
//    state is user state, not content: it must not move `Article.updatedAt`
//    (GReader `updated` / ot-nt clock; a 45 k mark-all would otherwise make
//    every client re-download 45 k items). Hence raw SQL below.
//
// So: one read-only SELECT of the candidate ids (scope + `isRead = false` +
// `createdAt <= cutoff`), then short UPDATE … RETURNING statements of
// bulkReadChunk() ids each, every one its own transaction. Locks live
// for one chunk only; RETURNING yields exactly the rows this call changed (the
// Undo set) even while other writers touch the same rows.

/**
 * Rows per UPDATE statement (and per implicit transaction): bounds how long a
 * concurrent sync waits for a row lock (Postgres, ~0.1–0.5 ms per row with the
 * pg_trgm indexes) or the database write lock (SQLite, ~20 µs per row, but a
 * noticeable per-statement cost — 45 k rows: 1.46 s at 1 000 vs 1.03 s at 5 000).
 */
export const BULK_READ_CHUNK = { postgresql: 1000, sqlite: 5000 } as const;

export function bulkReadChunk(): number {
  return BULK_READ_CHUNK[getDatabaseProvider()];
}

export interface BulkReadResult {
  /** Ids this call actually changed (unread → read, or back for Undo). */
  ids: string[];
  /** False when a later chunk failed: `ids` holds what was changed before the failure. */
  complete: boolean;
  /** With `complete: false`: the ids of the failed chunk and every chunk after it (not attempted / rolled back). */
  remaining: string[];
}

/** Thrown by protocol handlers that have no partial-success semantics: some chunks committed, retry the request. */
export class PartialBulkWriteError extends Error {
  constructor(readonly done: number, readonly remaining: number) {
    super(`Bulk read-state write partially applied (${done} done, ${remaining} left); retry`);
  }
}

/** Attempts per chunk when the database picks it as a deadlock / serialization victim (or SQLite stays busy). */
export const CHUNK_ATTEMPTS = 4;

/** Deadlock (40P01), serialization failure (40001), Prisma's write-conflict code (P2034), SQLite busy. */
export function isRetryableDbError(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    const err = e as { code?: unknown; message?: unknown; meta?: { code?: unknown; message?: unknown }; cause?: unknown };
    const codes = [err.code, err.meta?.code].filter((c): c is string => typeof c === "string");
    if (codes.some((c) => c === "40P01" || c === "40001" || c === "P2034" || c === "SQLITE_BUSY")) return true;
    const text = [err.message, err.meta?.message].filter((m): m is string => typeof m === "string").join(" ");
    if (/deadlock detected|could not serialize access|database is locked|SQLITE_BUSY/i.test(text)) return true;
    e = err.cause;
  }
  return false;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= CHUNK_ATTEMPTS || !isRetryableDbError(error)) throw error;
      logger.warn("[bulk-read] chunk aborted as deadlock / serialization victim; retrying", { attempt });
      // Jittered backoff so two victims of the same deadlock do not collide again.
      await sleep(attempt * 25 + Math.floor(Math.random() * 50));
    }
  }
}

/**
 * Flips `isRead` for the user's own `ids` that do not hold the target value
 * yet (`readAt` stamped / cleared), chunked in id order, without touching
 * `updatedAt`. Returns the ids it changed. A chunk the database aborts as a
 * deadlock / serialization victim is retried (CHUNK_ATTEMPTS, jittered). A
 * failure in the first chunk throws (nothing changed); a later one returns the
 * partial result with `complete: false` and the unprocessed ids in `remaining`.
 */
export async function setReadStateByIds(userId: string, ids: readonly string[], isRead: boolean, now = new Date()): Promise<BulkReadResult> {
  const unique = [...new Set(ids)].sort();
  const changed: string[] = [];
  const size = bulkReadChunk();
  for (let i = 0; i < unique.length; i += size) {
    const chunk = unique.slice(i, i + size);
    try {
      const rows = await withRetry(() => writeChunk(userId, chunk, isRead, isRead ? now : null));
      for (const row of rows) changed.push(row.id);
    } catch (error) {
      if (i === 0) throw error;
      logger.error("[bulk-read] chunk failed; partial result", { error, done: changed.length, total: unique.length });
      return { ids: changed, complete: false, remaining: unique.slice(i) };
    }
  }
  return { ids: changed, complete: true, remaining: [] };
}

/**
 * One chunk. Postgres: its own transaction that first locks the chunk's rows
 * in id order (`SELECT … ORDER BY id FOR UPDATE`), then updates them — two
 * overlapping bulk writes (or a bulk write and a sync touching the same rows)
 * always queue on the same row first instead of deadlocking on each other.
 * SQLite has one database-wide write lock (no row locks, no lock-order
 * deadlocks): a single UPDATE … RETURNING.
 */
async function writeChunk(userId: string, ids: string[], isRead: boolean, readAt: Date | null): Promise<Array<{ id: string }>> {
  if (getDatabaseProvider() === "postgresql") {
    return db.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Article" WHERE "id" = ANY(${ids}::text[]) AND "userId" = ${userId} ORDER BY "id" FOR UPDATE`);
      return tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`UPDATE "Article" SET "isRead" = ${isRead}, "readAt" = ${readAt} WHERE "userId" = ${userId} AND "isRead" = ${!isRead} AND "id" = ANY(${ids}::text[]) RETURNING "id"`,
      );
    }, { timeout: 30_000, maxWait: 10_000 });
  }
  return db.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`UPDATE "Article" SET "isRead" = ${isRead}, "readAt" = ${readAt} WHERE "userId" = ${userId} AND "isRead" = ${!isRead} AND "id" IN (SELECT value FROM json_each(${JSON.stringify(ids)})) RETURNING "id"`,
  );
}

/** For handlers without partial semantics (GReader, Fever, MCP): a partial write becomes a retryable error. */
export function assertComplete(result: BulkReadResult): BulkReadResult {
  if (!result.complete) throw new PartialBulkWriteError(result.ids.length, result.remaining.length);
  return result;
}

/**
 * Marks every unread article of `where` read. `where` must already be the
 * caller's user-scoped view filter (it is AND-ed with `userId` again anyway).
 * `cutoff`: only articles that arrived (`createdAt`) at or before it — the
 * list snapshot / GReader `ts` / Fever `before` — so items a sync inserts
 * while the user looks at the list (or while this runs) stay unread.
 */
export async function markWhereRead(userId: string, where: Prisma.ArticleWhereInput, options: { cutoff?: Date | null; now?: Date } = {}): Promise<BulkReadResult> {
  const now = options.now ?? new Date();
  const scoped: Prisma.ArticleWhereInput = {
    AND: [where, { userId, isRead: false }, ...(options.cutoff ? [{ createdAt: { lte: options.cutoff } }] : [])],
  };
  const candidates = await db.article.findMany({ where: scoped, select: { id: true }, orderBy: { id: "asc" } });
  if (candidates.length === 0) return { ids: [], complete: true, remaining: [] };
  return setReadStateByIds(userId, candidates.map((a) => a.id), true, now);
}

/**
 * Parses a client / protocol cutoff in epoch milliseconds. Missing → null (no
 * cutoff: everything up to now). Future values are clamped to `now` — a client
 * clock ahead of the server must not reach into items that arrive later.
 */
export function parseCutoffMs(value: unknown, now = Date.now()): Date | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return new Date(Math.min(value, now));
}
