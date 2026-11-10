export const dynamic = "force-dynamic";

import { appError, appJson, resolveSessionUser } from "@/lib/api-auth";
import { getCounts } from "@/server/bootstrap";
import { logger } from "@/lib/logger";

/**
 * GET /api/app/counts — `Counts` of the signed-in user (sidebar, header and
 * app badge numbers in one response). Session cookie only.
 */
export async function GET(request: Request) {
  const user = await resolveSessionUser();
  if (!user) return appError("Unauthorized", 401);
  try {
    return await appJson(await getCounts(user.id), { request });
  } catch (error) {
    logger.error("[api/app/counts] failed:", error);
    return appError("Could not load counts", 500);
  }
}
