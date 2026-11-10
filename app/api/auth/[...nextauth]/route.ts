import { handlers } from "@/auth";
import {
  authRateLimitFor,
  checkRateLimit,
  getClientIdentifier,
  rateLimitResponse,
} from "@/lib/rate-limit";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = (req: NextRequest) => handlers.GET(req);

export async function POST(req: NextRequest): Promise<Response> {
  const identifier = getClientIdentifier(req);
  const pathname = req.nextUrl.pathname;

  // Magic link / email sign-in gets stricter rate limiting; sign-out has its own budget
  // (it is not a credential guess and must not be starved by sign-in attempts).
  const config = authRateLimitFor(pathname);

  const result = checkRateLimit(identifier, config);
  if (!result.success) return rateLimitResponse(result);

  return handlers.POST(req);
}
