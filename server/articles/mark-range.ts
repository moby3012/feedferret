import { z } from "zod";
import { db } from "@/lib/db";
import { parseListParams, type Scope, type Sort } from "@/features/articles/scope";
import { keysetWhere } from "./list";
import { MAX_ID_LENGTH, MAX_MARK_IDS, markIdsRead } from "./state";
import { buildViewScope } from "./view-scope";

// "Alles bis hier als gelesen" (row context menu) as one server-side range of
// the bound list instead of an explicit id list: no 1000-id cap, one undo token.

/**
 * Upper bound of rows one "mark up to here" range may change, `extraIds`
 * included. The range only spans rows the client has loaded (keyset paging,
 * 50 per page), so a real list stays far below; above it the call fails whole
 * (nothing changes) — never a silent partial.
 */
export const MAX_RANGE_IDS = 20_000;

/** Thrown before anything changes; `limit` is the bound the call went over. */
export class RangeTooLargeError extends Error {
  constructor(readonly limit: number) {
    super("Range too large");
  }
}

export interface MarkRangeInput {
  scope: Scope;
  sort: Sort;
  /** First loaded row of the list (top of the range, inclusive). */
  fromId: string;
  /** Last row of the range in list order (inclusive). */
  toId: string;
  /**
   * Snapshot cutoff (ms): the server time the list's first page was loaded
   * (`ArticlePage.snapshotAt`), fixed for the list's lifetime. Only rows with
   * `createdAt <= maxCreatedAt` are in the range, so articles that arrived
   * later — also backdated ones inside an already loaded span — stay out.
   */
  maxCreatedAt: number;
  /**
   * Displayed rows the keyset range does not cover (story members fetched
   * for an expanded card, siblings folded under a card above `toId`, rows
   * newer than the snapshot the list shows). Counted against MAX_RANGE_IDS.
   */
  extraIds: string[];
}

const MarkRangeSchema = z
  .object({
    listKey: z.string().min(1).max(2048),
    sort: z.enum(["new", "old"]),
    fromId: z.string().min(1).max(MAX_ID_LENGTH),
    toId: z.string().min(1).max(MAX_ID_LENGTH),
    maxCreatedAt: z.number().finite(),
    extraIds: z.array(z.string().min(1).max(MAX_ID_LENGTH)).max(MAX_RANGE_IDS),
  })
  .strict();

/** Validates the wire shape; the scope comes from the canonical list key (`/?feed=…`) through the list endpoint's own parser. */
export function parseMarkRange(input: unknown): { ok: true; range: MarkRangeInput } | { ok: false; error: string } {
  const parsed = MarkRangeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid range" };
  const { listKey, sort, fromId, toId, maxCreatedAt, extraIds } = parsed.data;
  if (!listKey.startsWith("/")) return { ok: false, error: "Invalid list key" };
  const params = parseListParams(new URLSearchParams(listKey.split("?")[1] ?? ""));
  if (!params.ok) return { ok: false, error: params.error };
  return { ok: true, range: { scope: params.scope, sort, fromId, toId, maxCreatedAt, extraIds: [...new Set(extraIds)] } };
}

/**
 * "Alles bis hier als gelesen" as one server-side range: every unread row of
 * the view from the list's first loaded row down to `toId` (inclusive, in the
 * list's keyset order), plus `extraIds`. Same view `where` as the list
 * endpoint, user-scoped, bounded (MAX_RANGE_IDS), one transaction; returns
 * exactly the ids this call changed (the undo set, one token for all).
 */
export async function markRangeRead(userId: string, range: MarkRangeInput): Promise<string[]> {
  const { where, keyset } = await buildViewScope(userId, range.scope);
  const direction = range.sort === "old" ? "asc" : "desc";
  const reverse = direction === "desc" ? "asc" : "desc";
  const select = Object.fromEntries([...keyset, "id"].map((f) => [f, true]));
  const bounds = (await db.article.findMany({ where: { userId, id: { in: [range.fromId, range.toId] } }, select })) as Array<Record<string, unknown>>;
  const valuesOf = (id: string) => {
    const row = bounds.find((b) => b.id === id);
    if (!row) return null;
    const values = keyset.map((f) => (f === "id" ? row.id : row[f] instanceof Date ? (row[f] as Date).getTime() : null));
    return values.some((v) => v === null) ? null : (values as Array<string | number>);
  };
  const from = valuesOf(range.fromId);
  const to = valuesOf(range.toId);
  if (!from || !to) {
    if (range.extraIds.length > MAX_MARK_IDS) throw new RangeTooLargeError(MAX_MARK_IDS);
    return range.extraIds.length ? markIdsRead(userId, range.extraIds) : [];
  }

  where.isRead = false;
  where.AND = [
    ...(where.AND || []),
    // at or after `from` …
    { OR: [keysetWhere(keyset, from, direction), { id: range.fromId }] },
    // … and at or before `to` in list order,
    { OR: [keysetWhere(keyset, to, reverse), { id: range.toId }] },
    // never a row that arrived after the list was loaded.
    { createdAt: { lte: new Date(range.maxCreatedAt) } },
  ];

  const readAt = new Date();
  return db.$transaction(
    async (tx) => {
      const inRange = await tx.article.findMany({ where, select: { id: true }, take: MAX_RANGE_IDS + 1 });
      if (inRange.length > MAX_RANGE_IDS) throw new RangeTooLargeError(MAX_RANGE_IDS);
      const extra: Array<{ id: string }> = [];
      for (let i = 0; i < range.extraIds.length; i += 500) {
        extra.push(...(await tx.article.findMany({ where: { userId, id: { in: range.extraIds.slice(i, i + 500) }, isRead: false }, select: { id: true } })));
      }
      const candidates = [...new Set([...inRange, ...extra].map((a) => a.id))];
      if (candidates.length > MAX_RANGE_IDS) throw new RangeTooLargeError(MAX_RANGE_IDS);
      const changed: string[] = [];
      for (let i = 0; i < candidates.length; i += 500) {
        const chunk = candidates.slice(i, i + 500);
        const result = await tx.article.updateMany({ where: { userId, id: { in: chunk }, isRead: false }, data: { isRead: true, readAt } });
        if (result.count === chunk.length) changed.push(...chunk);
        else if (result.count > 0) {
          // Another writer got to some rows first: keep only the ones this call changed.
          const mine = await tx.article.findMany({ where: { userId, id: { in: chunk }, isRead: true, readAt }, select: { id: true } });
          changed.push(...mine.map((a) => a.id));
        }
      }
      return changed;
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}
