import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { discoverFeedsAtUrl } from "@/lib/feed-discovery";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "Missing url parameter" }, { status: 400 });
  }

  try {
    const feeds = await discoverFeedsAtUrl(url);
    return NextResponse.json({ feeds });
  } catch (error) {
    return NextResponse.json({ feeds: [], error: String(error) });
  }
}
