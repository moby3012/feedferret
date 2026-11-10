import { db } from "@/lib/db";
import type { Scope, Show, Sort } from "@/features/articles/scope";
import { showApplies } from "@/features/articles/scope";
import type { HeadProbe } from "@/features/articles/types";
import { buildViewScope } from "./view-scope";

/** The pill never counts past this ("99+" in the UI; one more row tells "more than 99"). */
export const HEAD_COUNT_CAP = 100;

/**
 * Scopes whose list is not a "newest first" timeline of arrivals: "Recently
 * read" is ordered by `readAt`, search is a result set. They never get a pill.
 */
export function headApplies(scope: Scope, sort: Sort): boolean {
  return sort === "new" && scope.kind !== "recent" && scope.kind !== "query";
}

export interface HeadParams {
  scope: Scope;
  show: Show;
  sort: Sort;
  /** Server time (ms) of the bound list's snapshot: rows created after it are "new". */
  since: number;
}

/**
 * "↑ N neu" probe (spec §2.1 / §4.8): how many rows of the bound list
 * (same view scope and unread filter as `listArticles`) were created after
 * the list's snapshot. Cheap on Postgres: `userId = ? AND createdAt > ?` is a
 * short range on `(userId, createdAt DESC, id DESC)` — only rows that arrived
 * since the snapshot are visited — and the count stops at `HEAD_COUNT_CAP + 1`.
 *
 * `newestCursor` = createdAt (ms, as a string) of the newest of them: the
 * client can tell a changed answer from a repeated one without comparing ids.
 */
export async function probeHead(userId: string, params: HeadParams): Promise<HeadProbe> {
  if (!headApplies(params.scope, params.sort)) return { count: 0, newestCursor: null };
  const { where } = await buildViewScope(userId, params.scope);
  if (params.show === "unread" && showApplies(params.scope)) where.isRead = false;
  where.createdAt = { gt: new Date(params.since) };

  const [count, newest] = await Promise.all([
    db.article.count({ where, take: HEAD_COUNT_CAP + 1 }),
    db.article.findFirst({ where, select: { createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
  ]);
  return {
    count: Math.min(count, HEAD_COUNT_CAP),
    newestCursor: newest ? String(newest.createdAt.getTime()) : null,
  };
}
