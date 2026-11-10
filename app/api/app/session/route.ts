export const dynamic = "force-dynamic";

import { appError, appJson, resolveSessionUser } from "@/lib/api-auth";

/**
 * GET /api/app/session — who the session cookie belongs to (`{ userId }`), 401 without a live session.
 * Tiny on purpose: the offline layer (open tabs and the static offline page) calls it to confirm that the
 * data it holds still belongs to the signed-in account. Session cookie only; never cached.
 */
export async function GET(request: Request) {
  const user = await resolveSessionUser();
  if (!user) return appError("Unauthorized", 401);
  return appJson({ userId: user.id }, { request });
}
