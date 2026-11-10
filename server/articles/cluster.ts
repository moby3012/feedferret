import { db } from "@/lib/db";
import type { ClusterDetail } from "@/features/articles/types";
import { getCleanTitlesSetting, LIST_SELECT, toListItem, type ListRow } from "./list";
import { buildViewScope } from "./view-scope";

/** Hard cap of members returned (a cluster is capped at 50 by the engine). */
export const MAX_CLUSTER_MEMBERS = 100;

/**
 * All sources of one story cluster of `userId` as slim list rows (no body),
 * oldest first. `null` for an unknown id, another user's cluster, or a cluster
 * none of whose members is visible. Members follow the list's visibility rules
 * (the "all feeds" view): feeds / categories hidden from all feeds, known
 * duplicates (when the user hides them) and spoilers are left out, and `size`
 * is the number of members actually visible — not the stored cluster size.
 */
export async function getClusterDetail(userId: string, id: string): Promise<ClusterDetail | null> {
  const cluster = await db.storyCluster.findFirst({
    where: { id, userId },
    select: { id: true, leadArticleId: true },
  });
  if (!cluster) return null;
  const { where: viewWhere } = await buildViewScope(userId, { kind: "all" });
  const where = { AND: [viewWhere, { clusterId: cluster.id }] };
  const [rows, visible] = await Promise.all([
    db.article.findMany({
      where,
      select: LIST_SELECT,
      orderBy: [{ publishedAt: "asc" }, { id: "asc" }],
      take: MAX_CLUSTER_MEMBERS,
    }) as Promise<ListRow[]>,
    db.article.count({ where }),
  ]);
  if (rows.length === 0) return null;
  const cleanTitles = await getCleanTitlesSetting(userId);
  return {
    id: cluster.id,
    size: visible,
    // the representative may itself be hidden: fall back to the oldest visible source
    leadId: rows.some((r) => r.id === cluster.leadArticleId) ? cluster.leadArticleId : rows[0].id,
    members: rows.map((row) => toListItem(row, { cleanTitles })),
  };
}
