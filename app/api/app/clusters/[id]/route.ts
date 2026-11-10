export const dynamic = "force-dynamic";

import { appError, appJson, resolveSessionUser } from "@/lib/api-auth";
import { getClusterDetail } from "@/server/articles/cluster";
import { logger } from "@/lib/logger";

/**
 * GET /api/app/clusters/:id — `ClusterDetail` (all sources of one story as
 * slim list rows, oldest first) of one of the signed-in user's clusters.
 * Session cookie only; another user's id is a plain 404.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await resolveSessionUser();
  if (!user) return appError("Unauthorized", 401);

  const { id } = await params;
  if (!id || id.length > 128) return appError("Not found", 404);

  try {
    const detail = await getClusterDetail(user.id, id);
    if (!detail) return appError("Not found", 404);
    return await appJson(detail, { request });
  } catch (error) {
    logger.error("[api/app/clusters/:id] detail failed:", error);
    return appError("Could not load cluster", 500);
  }
}
