import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import {
  checkRateLimit,
  getClientIdentifier,
  rateLimitHeaders,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export const runtime = "nodejs";

export const DISCOVERY_CATEGORIES = [
  { id: "tech", name: "Technology", icon: "💻" },
  { id: "news", name: "News", icon: "📰" },
  { id: "dev", name: "Developer", icon: "👨‍💻" },
  { id: "science", name: "Science", icon: "🔬" },
  { id: "business", name: "Business", icon: "💼" },
  { id: "gaming", name: "Gaming", icon: "🎮" },
  { id: "entertainment", name: "Entertainment", icon: "🎬" },
  { id: "sports", name: "Sports", icon: "⚽" },
  { id: "design", name: "Design", icon: "🎨" },
  { id: "lifestyle", name: "Lifestyle", icon: "🌿" },
] as const;

export type DiscoveryCategory = (typeof DISCOVERY_CATEGORIES)[number];

// GET /api/discovery/catalog - list categories or feeds in a category
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const identifier = getClientIdentifier(request, session.user.id);
  const rateCheck = checkRateLimit(identifier, RATE_LIMITS.discoveryCatalog);

  if (!rateCheck.success) {
    return NextResponse.json(
      { error: "Rate limit exceeded", retryAfter: rateCheck.retryAfterSecs },
      { status: 429, headers: rateLimitHeaders(rateCheck) }
    );
  }

  const { searchParams } = new URL(request.url);
  const category = searchParams.get("category");
  const language = searchParams.get("language"); // "en", "de", "multi", or null for all

  // If no category specified, return categories with feed counts
  if (!category) {
    const counts = await db.discoveryCatalogFeed.groupBy({
      by: ["category"],
      where: { enabled: true },
      _count: { id: true },
    });

    const countMap = new Map(counts.map((c: { category: string; _count: { id: number } }) => [c.category, c._count.id]));

    const categories = DISCOVERY_CATEGORIES.map((cat) => ({
      ...cat,
      feedCount: countMap.get(cat.id) || 0,
    }));

    return NextResponse.json(
      { categories },
      { headers: rateLimitHeaders(rateCheck) }
    );
  }

  // Fetch feeds for the category
  const feeds = await db.discoveryCatalogFeed.findMany({
    where: {
      category,
      enabled: true,
      ...(language ? { language } : {}),
    },
    orderBy: [{ popularity: "desc" }, { title: "asc" }],
    take: 50,
  });

  return NextResponse.json(
    { feeds, category },
    { headers: rateLimitHeaders(rateCheck) }
  );
}

// DELETE /api/discovery/catalog - Admin only: clear the catalog
export async function DELETE(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { role: true },
  });

  if (user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  await db.discoveryCatalogFeed.deleteMany({});

  return NextResponse.json({ success: true });
}
