import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { discoverFeeds } from "@/lib/feed-discovery";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

// GET /api/discover?url=<url | @handle | r/sub | topic phrase>[&locale=de]
// `url` is kept for compatibility; plain phrases come back as `mode: "topic"`
// with search-engine feed candidates for the user to pick from.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = checkRateLimit(`user:${session.user.id}`, RATE_LIMITS.urlDiscover);
  if (!rl.success) return rateLimitResponse(rl);

  const url = (req.nextUrl.searchParams.get("url") ?? req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!url) {
    return NextResponse.json({ error: "Missing url parameter" }, { status: 400 });
  }
  if (url.length > 2000) {
    return NextResponse.json({ error: "Input too long" }, { status: 400 });
  }
  const locale = req.nextUrl.searchParams.get("locale")?.slice(0, 10) || null;

  try {
    const { mode, feeds, hint, hintPlatform, partial } = await discoverFeeds(url, { locale });
    return NextResponse.json({ feeds, mode, hint, ...(hintPlatform ? { hintPlatform } : {}), ...(partial ? { partial } : {}) });
  } catch (error) {
    return NextResponse.json({ feeds: [], mode: "url", error: String(error) });
  }
}
