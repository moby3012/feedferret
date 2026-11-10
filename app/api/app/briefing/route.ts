export const dynamic = "force-dynamic";

import { appError, appJson, resolveSessionUser } from "@/lib/api-auth";
import { logger } from "@/lib/logger";
import { isSameOriginRequest } from "@/lib/same-origin";
import { BriefingNotFoundError, getBriefingState, startBriefing } from "@/lib/briefing/generate";
import { parseBriefingScope, type BriefingEvent } from "@/lib/briefing/types";

/**
 * K2 "catch me up" briefing of the signed-in user (session cookie only).
 *   GET  ?scope=new|cat:<id>|label:<id> → BriefingResponse (cached or headline digest; never calls a provider)
 *   POST ?scope=…[&force=1]             → NDJSON stream of BriefingEvent (generation, validated items only)
 * A scope the user does not own is a plain 404.
 */
export async function GET(request: Request) {
  const user = await resolveSessionUser();
  if (!user) return appError("Unauthorized", 401);
  const scope = parseBriefingScope(new URL(request.url).searchParams.get("scope"));
  if (!scope) return appError("Invalid scope", 400);
  try {
    return await appJson(await getBriefingState(user.id, scope), { request });
  } catch (error) {
    if (error instanceof BriefingNotFoundError) return appError("Not found", 404);
    logger.error("[api/app/briefing] GET failed:", error instanceof Error ? error.message : error);
    return appError("Could not load briefing", 500);
  }
}

export async function POST(request: Request) {
  // State-changing (spends tokens / moves the window): same-origin only.
  if (!isSameOriginRequest(request)) return appError("Forbidden", 403);
  const user = await resolveSessionUser();
  if (!user) return appError("Unauthorized", 401);
  const params = new URL(request.url).searchParams;
  const scope = parseBriefingScope(params.get("scope"));
  if (!scope) return appError("Invalid scope", 400);

  let events: AsyncGenerator<BriefingEvent>;
  try {
    events = await startBriefing(user.id, scope, { force: params.get("force") === "1", signal: request.signal });
  } catch (error) {
    if (error instanceof BriefingNotFoundError) return appError("Not found", 404);
    logger.error("[api/app/briefing] POST failed:", error instanceof Error ? error.message : error);
    return appError("Could not generate briefing", 500);
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await events.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
      } catch (error) {
        logger.error("[api/app/briefing] stream failed:", error instanceof Error ? error.message : error);
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", code: "provider_down" } satisfies BriefingEvent)}\n`));
        controller.close();
      }
    },
    async cancel() {
      await events.return(undefined);
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
