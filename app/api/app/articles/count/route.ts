export const dynamic = "force-dynamic";

import { appError, appJson, resolveSessionUser } from "@/lib/api-auth";
import { parseListParams } from "@/features/articles/scope";
import { buildViewScope } from "@/server/articles/view-scope";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * GET /api/app/articles/count?<v|feed|cat|label|ss|q> — `{ unread }` of one
 * list scope, built by the same view scope as the list. The client only uses
 * it for saved searches and ad-hoc search; every other scope reads `Counts`.
 */
export async function GET(request: Request) {
  const user = await resolveSessionUser();
  if (!user) return appError("Unauthorized", 401);
  const parsed = parseListParams(new URL(request.url).searchParams);
  if (!parsed.ok) return appError(parsed.error, 400);
  // Read-only views have nothing unread to report.
  if (parsed.scope.kind === "recent" || parsed.scope.kind === "spoiler") return appJson({ unread: 0 }, { request });
  try {
    const { where } = await buildViewScope(user.id, parsed.scope);
    where.isRead = false;
    return await appJson({ unread: await db.article.count({ where }) }, { request });
  } catch (error) {
    logger.error("[api/app/articles/count] failed:", error);
    return appError("Could not count articles", 500);
  }
}
