export const dynamic = "force-dynamic";

import { appError, appJson, resolveSessionUser } from "@/lib/api-auth";
import { parseListParams } from "@/features/articles/scope";
import { probeHead } from "@/server/articles/head";
import { logger } from "@/lib/logger";

/**
 * GET /api/app/articles/head?<v|feed|cat|label|ss|q>&show=&sort=&since=<ms>
 *
 * `HeadProbe` of one list: rows matching the list's scope and unread filter
 * that were created after `since` (the list snapshot's `snapshotAt`). Feeds
 * the "↑ N neu" pill; the list itself never changes until the user applies
 * it. Session cookie only, user-scoped like the list.
 */
export async function GET(request: Request) {
  const user = await resolveSessionUser();
  if (!user) return appError("Unauthorized", 401);

  const sp = new URL(request.url).searchParams;
  const parsed = parseListParams(sp);
  if (!parsed.ok) return appError(parsed.error, 400);
  const sinceRaw = sp.get("since");
  const since = sinceRaw !== null && /^\d{1,15}$/.test(sinceRaw) ? Number(sinceRaw) : NaN;
  if (!Number.isSafeInteger(since)) return appError("Invalid since", 400);

  try {
    return await appJson(await probeHead(user.id, { scope: parsed.scope, show: parsed.show, sort: parsed.sort, since }), { request });
  } catch (error) {
    logger.error("[api/app/articles/head] failed:", error);
    return appError("Could not probe new articles", 500);
  }
}
