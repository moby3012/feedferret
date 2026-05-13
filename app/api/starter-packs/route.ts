import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { DEFAULT_STARTER_PACKS } from "@/lib/starter-packs";
import { getStarterPacksFromSettings, hydrateStarterPackFiles } from "@/lib/starter-packs.server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("defaults") === "1") {
    const packs = await hydrateStarterPackFiles(DEFAULT_STARTER_PACKS);
    return NextResponse.json({ packs });
  }

  const settings = await db.globalSettings.findUnique({
    where: { id: "global" },
    select: { starterPacksJson: true },
  });

  const packs = await getStarterPacksFromSettings(settings?.starterPacksJson);

  return NextResponse.json({ packs: packs.filter((pack) => pack.enabled) });
}
