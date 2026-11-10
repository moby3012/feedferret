import { db } from "@/lib/db";
import type { ClusterDetail } from "@/features/articles/types";
import { LIST_SELECT, toListItem, type ListRow } from "./list";

/** Hard cap of members returned (a cluster is capped at 50 by the engine). */
export const MAX_CLUSTER_MEMBERS = 100;

/**
 * All sources of one story cluster of `userId` as slim list rows (no body),
 * oldest first. `null` for an unknown id or another user's cluster.
 */
export async function getClusterDetail(userId: string, id: string): Promise<ClusterDetail | null> {
  const cluster = await db.storyCluster.findFirst({
    where: { id, userId },
    select: { id: true, size: true, leadArticleId: true },
  });
  if (!cluster) return null;
  const rows = (await db.article.findMany({
    where: { userId, clusterId: cluster.id },
    select: LIST_SELECT,
    orderBy: [{ publishedAt: "asc" }, { id: "asc" }],
    take: MAX_CLUSTER_MEMBERS,
  })) as ListRow[];
  return {
    id: cluster.id,
    size: cluster.size,
    leadId: cluster.leadArticleId,
    members: rows.map(toListItem),
  };
}
