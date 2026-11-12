import { presentMedia } from "@/lib/media-proxy";
export const dynamic = "force-dynamic";

import { appError, appJson, clampInt, resolveSessionUser } from "@/lib/api-auth";
import { parseListParams } from "@/features/articles/scope";
import { DEFAULT_PAGE_SIZE, InvalidCursorError, MAX_PAGE_SIZE, listArticles } from "@/server/articles/list";
import { logger } from "@/lib/logger";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { isStatementTimeout, withStatementTimeout } from "@/lib/statement-timeout";

/**
 * GET /api/app/articles?<v|feed|cat|label|ss|q>&show=unread|all&sort=new|old&cursor=&limit=50
 *
 * One page of the signed-in user's article list (`ArticlePage`): list fields
 * only, no `content`. Session cookie only. `show=unread` (default) is applied
 * on the server for all/feed/cat/label/ss; ignored for `v=*` and `q`.
 * Ad-hoc search (`q`) is rate-limited per user (`articleSearch`); search and
 * saved searches run under a Postgres statement timeout (N13).
 */
export async function GET(request: Request) {
  const user = await resolveSessionUser();
  if (!user) return appError("Unauthorized", 401);

  const sp = new URL(request.url).searchParams;
  const parsed = parseListParams(sp);
  if (!parsed.ok) return appError(parsed.error, 400);
  const cursor = sp.get("cursor");
  if (cursor !== null && (cursor.length === 0 || cursor.length > 512)) return appError("Invalid cursor", 400);
  if (parsed.scope.kind === "query") {
    const limited = checkRateLimit(`user:${user.id}`, RATE_LIMITS.articleSearch);
    if (!limited.success) return rateLimitResponse(limited);
  }

  try {
    const params = {
      scope: parsed.scope,
      show: parsed.show,
      sort: parsed.sort,
      cursor,
      limit: clampInt(sp.get("limit") ?? undefined, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
    };
    const isSearch = parsed.scope.kind === "query" || parsed.scope.kind === "saved-search";
    const page = isSearch
      ? await withStatementTimeout((client) => listArticles(user.id, params, client))
      : await listArticles(user.id, params);
    return await appJson({ ...page, items: await presentMedia(page.items, user.id) }, { request });
  } catch (error) {
    if (error instanceof InvalidCursorError) return appError("Invalid cursor", 400);
    if (isStatementTimeout(error)) return appError("Search took too long, try a narrower query", 503);
    logger.error("[api/app/articles] list failed:", error);
    return appError("Could not load articles", 500);
  }
}
