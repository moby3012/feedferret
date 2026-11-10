export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { handleFreshRssUpload } from "@/lib/import/freshrss-upload";

// POST /api/import/freshrss[?dryRun=1]
// Body: the raw FreshRSS export (ZIP), an OPML file or an article JSON file.
// Session-authenticated (settings UI); API tokens use POST /api/v1/import/freshrss.
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: { message: "Unauthorized" } }, { status: 401 });
  return handleFreshRssUpload(request, session.user.id);
}
