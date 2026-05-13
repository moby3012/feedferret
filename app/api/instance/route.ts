import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const settings = await db.globalSettings.findUnique({
    where: { id: "global" },
    select: {
      instanceName: true,
      instanceIconDataUrl: true,
    },
  });

  return NextResponse.json({
    instanceName: settings?.instanceName || "FeedFerret",
    instanceIconDataUrl: settings?.instanceIconDataUrl || null,
  });
}
