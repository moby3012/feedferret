import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseStarterPacksJson } from "@/lib/starter-packs";

export const dynamic = "force-dynamic";

export async function GET() {
  const settings = await db.globalSettings.findUnique({
    where: { id: "global" },
    select: { starterPacksJson: true },
  });

  return NextResponse.json({
    packs: parseStarterPacksJson(settings?.starterPacksJson).filter((pack) => pack.enabled),
  });
}
