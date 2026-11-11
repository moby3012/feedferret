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
// bulkReadChunk() ids each, every one its own implicit transaction. Locks live
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
}

/**
 * Flips `isRead` for the user's own `ids` that do not hold the target value
 * yet (`readAt` stamped / cleared), chunked, without touching `updatedAt`.
 * Returns the ids it changed. A failure in the first chunk throws (nothing
 * changed); a later one returns the partial result with `complete: false`.
 */
export async function setReadStateByIds(userId: string, ids: readonly string[], isRead: boolean, now = new Date()): Promise<BulkReadResult> {
  const unique = [...new Set(ids)];
  const changed: string[] = [];
  const size = bulkReadChunk();
  for (let i = 0; i < unique.length; i += size) {
    const chunk = unique.slice(i, i + size);
    try {
      const rows = await db.$queryRaw<Array<{ id: string }>>(updateChunkSql(userId, chunk, isRead, isRead ? now : null));
      for (const row of rows) changed.push(row.id);
    } catch (error) {
      if (i === 0) throw error;
      logger.error("[bulk-read] chunk failed; partial result", { error, done: changed.length, total: unique.length });
      return { ids: changed, complete: false };
    }
  }
  return { ids: changed, complete: true };
}

function updateChunkSql(userId: string, ids: string[], isRead: boolean, readAt: Date | null): Prisma.Sql {
  // Same statement for both providers except the id-list binding: one array
  // parameter on Postgres, one JSON parameter on SQLite (no bound-variable limit).
  const idMatch =
    getDatabaseProvider() === "postgresql"
      ? Prisma.sql`"id" = ANY(${ids}::text[])`
      : Prisma.sql`"id" IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
  return Prisma.sql`UPDATE "Article" SET "isRead" = ${isRead}, "readAt" = ${readAt} WHERE "userId" = ${userId} AND "isRead" = ${!isRead} AND ${idMatch} RETURNING "id"`;
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
  const candidates = await db.article.findMany({ where: scoped, select: { id: true } });
  if (candidates.length === 0) return { ids: [], complete: true };
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
