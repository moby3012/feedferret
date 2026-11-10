export const dynamic = "force-dynamic";

import { appError, appJson, readJson, resolveSessionUser } from "@/lib/api-auth";
import { logger } from "@/lib/logger";
import { isSameOriginRequest } from "@/lib/same-origin";
import { markBriefingSeen } from "@/lib/briefing/generate";

/** POST {briefingId} — marks one of the user's briefings seen (idempotent; moves the next window). */
export async function POST(request: Request) {
  // State-changing (spends tokens / moves the window): same-origin only.
  if (!isSameOriginRequest(request)) return appError("Forbidden", 403);
  const user = await resolveSessionUser();
  if (!user) return appError("Unauthorized", 401);
  const body = await readJson<{ briefingId?: unknown }>(request);
  const id = body?.briefingId;
  if (typeof id !== "string" || !id || id.length > 128) return appError("Invalid briefingId", 400);
  try {
    if (!(await markBriefingSeen(user.id, id))) return appError("Not found", 404);
    return await appJson({ ok: true });
  } catch (error) {
    logger.error("[api/app/briefing/seen] failed:", error instanceof Error ? error.message : error);
    return appError("Could not update briefing", 500);
  }
}
