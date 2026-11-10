export const dynamic = "force-dynamic";

import { appError, appJson, resolveSessionUser } from "@/lib/api-auth";
import { MAX_ID_LENGTH, parseListParams } from "@/features/articles/scope";
import { MAX_EXCLUDED_IDS } from "@/features/articles/new-items";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { probeHead } from "@/server/articles/head";
import { logger } from "@/lib/logger";

/**
 * GET /api/app/articles/head?<v|feed|cat|label|ss|q>&show=&sort=&since=<ms>[&x=<id>,<id>…]
 *
 * `HeadProbe` of one list: rows matching the list's scope and unread filter
 * that were created after `since` (the list snapshot's `snapshotAt`). Feeds
 * the "↑ N neu" pill; the list itself never changes until the user applies
 * it. `x`: loaded rows past the snapshot (≤ 50), not counted. Session
 * cookie only, user-scoped like the list; rate-limited per user (the client
 * probes about every 2 minutes).
 */
export async function GET(request: Request) {
  const user = await resolveSessionUser();
  if (!user) return appError("Unauthorized", 401);

  const sp = new URL(request.url).searchParams;
  const parsed = parseListParams(sp);
  if (!parsed.ok) return appError(parsed.error, 400);
  const limited = checkRateLimit(`user:${user.id}`, RATE_LIMITS.headProbe);
  if (!limited.success) return rateLimitResponse(limited);

  const sinceRaw = sp.get("since");
  const since = sinceRaw !== null && /^\d{1,15}$/.test(sinceRaw) ? Number(sinceRaw) : NaN;
  if (!Number.isSafeInteger(since)) return appError("Invalid since", 400);
  const exclude = (sp.get("x") ?? "").split(",").filter(Boolean);
  if (exclude.length > MAX_EXCLUDED_IDS || exclude.some((id) => id.length > MAX_ID_LENGTH)) return appError("Invalid x", 400);

  try {
    return await appJson(await probeHead(user.id, { scope: parsed.scope, show: parsed.show, sort: parsed.sort, since, exclude }), { request });
  } catch (error) {
    logger.error("[api/app/articles/head] failed:", error);
    return appError("Could not probe new articles", 500);
  }
}
