export const dynamic = "force-dynamic";

import { appError, appJson, resolveSessionUser } from "@/lib/api-auth";
import { parseListParams } from "@/features/articles/scope";
import { buildViewScope } from "@/server/articles/view-scope";
import { logger } from "@/lib/logger";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { isStatementTimeout, withStatementTimeout } from "@/lib/statement-timeout";

/**
 * GET /api/app/articles/count?<v|feed|cat|label|ss|q> — `{ unread }` of one
 * list scope, built by the same view scope as the list. The client only uses
 * it for saved searches and ad-hoc search; every other scope reads `Counts`.
 * Rate-limited per user (`articleCount`; not charged to `articleSearch`, the
 * list call of the same query already is) and run
 * under a Postgres statement timeout (N13).
 */
export async function GET(request: Request) {
  const user = await resolveSessionUser();
  if (!user) return appError("Unauthorized", 401);
  const parsed = parseListParams(new URL(request.url).searchParams);
  if (!parsed.ok) return appError(parsed.error, 400);
  const limited = checkRateLimit(`user:${user.id}`, RATE_LIMITS.articleCount);
  if (!limited.success) return rateLimitResponse(limited);
  // Read-only views have nothing unread to report.
  if (parsed.scope.kind === "recent" || parsed.scope.kind === "spoiler") return appJson({ unread: 0 }, { request });
  try {
    const { where } = await buildViewScope(user.id, parsed.scope);
    where.isRead = false;
    const unread = await withStatementTimeout((client) => client.article.count({ where }));
    return await appJson({ unread }, { request });
  } catch (error) {
    if (isStatementTimeout(error)) return appError("Search took too long, try a narrower query", 503);
    logger.error("[api/app/articles/count] failed:", error);
    return appError("Could not count articles", 500);
  }
}
