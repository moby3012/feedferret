import { handlers } from "@/auth";
import {
  checkRateLimit,
  getClientIdentifier,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = (req: NextRequest) => handlers.GET(req);

export async function POST(req: NextRequest): Promise<Response> {
  const identifier = getClientIdentifier(req);
  const pathname = req.nextUrl.pathname;

  // Magic link / email sign-in gets stricter rate limiting
  const config =
    pathname.includes("sendverificationrequest") || pathname.includes("email")
      ? RATE_LIMITS.authMagicLink
      : RATE_LIMITS.authSignIn;

  const result = checkRateLimit(identifier, config);
  if (!result.success) return rateLimitResponse(result);

  return handlers.POST(req);
}
