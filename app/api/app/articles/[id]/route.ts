import { presentMedia } from "@/lib/media-proxy";
export const dynamic = "force-dynamic";

import { appError, appJson, resolveSessionUser } from "@/lib/api-auth";
import { getArticleDetail } from "@/server/articles/detail";
import { logger } from "@/lib/logger";

/**
 * GET /api/app/articles/:id — `ArticleDetail` (list fields + render-ready,
 * server-sanitized `html`) of one of the signed-in user's articles.
 * Session cookie only; another user's id is a plain 404.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await resolveSessionUser();
  if (!user) return appError("Unauthorized", 401);

  const { id } = await params;
  if (!id || id.length > 128) return appError("Not found", 404);

  try {
    const detail = await getArticleDetail(user.id, id);
    if (!detail) return appError("Not found", 404);
    return await appJson((await presentMedia([detail], user.id))[0], { request });
  } catch (error) {
    logger.error("[api/app/articles/:id] detail failed:", error);
    return appError("Could not load article", 500);
  }
}
