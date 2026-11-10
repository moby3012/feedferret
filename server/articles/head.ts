import { db } from "@/lib/db";
import type { Scope, Show, Sort } from "@/features/articles/scope";
import { groupsStories, showApplies } from "@/features/articles/scope";
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

/** Story counting reads at most this many new rows (a sync rarely brings more; the count is capped anyway). */
export const HEAD_STORY_SCAN = 500;

export interface HeadParams {
  scope: Scope;
  show: Show;
  sort: Sort;
  /** Server time (ms) of the bound list's snapshot: rows created after it are "new". */
  since: number;
  /** Loaded rows created after `since` (already on screen): never counted. */
  exclude?: string[];
}

/**
 * "↑ N neu" probe (spec §2.1 / §4.8): how many rows of the bound list
 * (same view scope and unread filter as `listArticles`) were created after
 * the list's snapshot, minus the ones the client already shows (`exclude`).
 * Cheap on Postgres: `userId = ? AND createdAt > ?` is a short range on
 * `(userId, createdAt DESC, id DESC)` — only rows that arrived since the
 * snapshot are visited.
 *
 * The number is what the list will show: in lists that fold story clusters
 * into one card (`groupsStories`) it counts stories — rows of one cluster
 * (size ≥ 2, like `groupStories`) count once — elsewhere articles.
 *
 * `newestCursor` = createdAt (ms, as a string) of the newest of them: the
 * client can tell a changed answer from a repeated one without comparing ids.
 */
export async function probeHead(userId: string, params: HeadParams): Promise<HeadProbe> {
  if (!headApplies(params.scope, params.sort)) return { count: 0, newestCursor: null };
  const { where } = await buildViewScope(userId, params.scope);
  if (params.show === "unread" && showApplies(params.scope)) where.isRead = false;
  where.createdAt = { gt: new Date(params.since) };
  if (params.exclude?.length) where.AND = [...(where.AND || []), { id: { notIn: params.exclude } }];
  const orderBy = [{ createdAt: "desc" as const }, { id: "desc" as const }];

  if (groupsStories(params.scope)) {
    const rows = await db.article.findMany({
      where,
      select: { id: true, createdAt: true, clusterId: true, cluster: { select: { size: true } } },
      orderBy,
      take: HEAD_STORY_SCAN,
    });
    const stories = new Set<string>();
    for (const row of rows) {
      stories.add(row.clusterId && (row.cluster?.size ?? 0) >= 2 ? `c:${row.clusterId}` : `a:${row.id}`);
      if (stories.size > HEAD_COUNT_CAP) break;
    }
    return {
      count: Math.min(stories.size, HEAD_COUNT_CAP),
      newestCursor: rows[0] ? String(rows[0].createdAt.getTime()) : null,
    };
  }

  const [count, newest] = await Promise.all([
    db.article.count({ where, take: HEAD_COUNT_CAP + 1 }),
    db.article.findFirst({ where, select: { createdAt: true }, orderBy }),
  ]);
  return {
    count: Math.min(count, HEAD_COUNT_CAP),
    newestCursor: newest ? String(newest.createdAt.getTime()) : null,
  };
}
