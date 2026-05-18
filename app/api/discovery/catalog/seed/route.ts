import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { SEED_FEEDS } from "@/lib/discovery-catalog-seeds";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

// POST /api/discovery/catalog/seed - Admin only: seed the discovery catalog
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check admin role
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { role: true },
  });

  if (user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  try {
    let added = 0;
    let skipped = 0;

    for (const feed of SEED_FEEDS) {
      try {
        await db.discoveryCatalogFeed.upsert({
          where: { url: feed.url },
          create: feed,
          update: {
            title: feed.title,
            category: feed.category,
            language: feed.language,
            popularity: feed.popularity,
          },
        });
        added++;
      } catch {
        skipped++;
      }
    }

    return NextResponse.json({
      success: true,
      added,
      skipped,
      total: SEED_FEEDS.length,
    });
  } catch (error) {
    logger.error("[discovery/catalog/seed] error:", error);
    return NextResponse.json({ error: "Seeding failed" }, { status: 500 });
  }
}
