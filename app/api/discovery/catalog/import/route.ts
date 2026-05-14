import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { JSDOM } from "jsdom";

export const runtime = "nodejs";

// Public OPML sources to import from
const OPML_SOURCES = [
  // awesome-rss-feeds - curated feeds by category
  {
    name: "Programming",
    url: "https://raw.githubusercontent.com/plenaryapp/awesome-rss-feeds/master/recommended/with_category/Programming.opml",
    defaultCategory: "dev",
  },
  {
    name: "Tech",
    url: "https://raw.githubusercontent.com/plenaryapp/awesome-rss-feeds/master/recommended/with_category/Tech.opml",
    defaultCategory: "tech",
  },
  {
    name: "News",
    url: "https://raw.githubusercontent.com/plenaryapp/awesome-rss-feeds/master/recommended/with_category/News.opml",
    defaultCategory: "news",
  },
  {
    name: "Science",
    url: "https://raw.githubusercontent.com/plenaryapp/awesome-rss-feeds/master/recommended/with_category/Science.opml",
    defaultCategory: "science",
  },
  {
    name: "Finance",
    url: "https://raw.githubusercontent.com/plenaryapp/awesome-rss-feeds/master/recommended/with_category/Finance.opml",
    defaultCategory: "business",
  },
  {
    name: "Entertainment",
    url: "https://raw.githubusercontent.com/plenaryapp/awesome-rss-feeds/master/recommended/with_category/Entertainment.opml",
    defaultCategory: "entertainment",
  },
  {
    name: "Gaming",
    url: "https://raw.githubusercontent.com/plenaryapp/awesome-rss-feeds/master/recommended/with_category/Gaming.opml",
    defaultCategory: "gaming",
  },
  {
    name: "Design",
    url: "https://raw.githubusercontent.com/plenaryapp/awesome-rss-feeds/master/recommended/with_category/Design.opml",
    defaultCategory: "design",
  },
  {
    name: "Lifestyle",
    url: "https://raw.githubusercontent.com/plenaryapp/awesome-rss-feeds/master/recommended/with_category/Lifestyle.opml",
    defaultCategory: "lifestyle",
  },
  // awesome-tech-rss
  {
    name: "Tech RSS",
    url: "https://raw.githubusercontent.com/tuan3w/awesome-tech-rss/main/feeds.opml",
    defaultCategory: "tech",
  },
];

interface ParsedFeed {
  url: string;
  title: string;
  description?: string;
  category: string;
}

function extractFeedsFromOpml(xml: string, defaultCategory: string): ParsedFeed[] {
  const feeds: ParsedFeed[] = [];

  try {
    const dom = new JSDOM(xml, { contentType: "text/xml" });
    const document = dom.window.document;
    const body = document.querySelector("body");
    if (!body) return feeds;

    function processOutline(element: Element, parentCategory?: string) {
      const xmlUrl = element.getAttribute("xmlUrl");
      const title = element.getAttribute("title") || element.getAttribute("text") || "";
      const description = element.getAttribute("description") || undefined;

      // If it has xmlUrl, it's a feed
      if (xmlUrl) {
        feeds.push({
          url: xmlUrl,
          title: title || xmlUrl,
          description,
          category: parentCategory || defaultCategory,
        });
      }

      // Process child outlines
      const children = element.querySelectorAll(":scope > outline");
      const categoryName = title;
      for (const child of children) {
        processOutline(child, categoryName ? mapCategory(categoryName) : parentCategory);
      }
    }

    // Process top-level outlines
    const topOutlines = body.querySelectorAll(":scope > outline");
    for (const outline of topOutlines) {
      processOutline(outline, defaultCategory);
    }
  } catch (e) {
    console.error("Error extracting feeds from OPML:", e);
  }

  return feeds;
}

// Map category names to our standard categories
function mapCategory(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("tech") || lower.includes("programming") || lower.includes("software") || lower.includes("developer")) return "dev";
  if (lower.includes("news") || lower.includes("world") || lower.includes("politics")) return "news";
  if (lower.includes("science") || lower.includes("space") || lower.includes("physics")) return "science";
  if (lower.includes("business") || lower.includes("finance") || lower.includes("economy")) return "business";
  if (lower.includes("game") || lower.includes("gaming") || lower.includes("esport")) return "gaming";
  if (lower.includes("design") || lower.includes("ux") || lower.includes("ui")) return "design";
  if (lower.includes("entertainment") || lower.includes("movie") || lower.includes("music")) return "entertainment";
  if (lower.includes("sport")) return "sports";
  if (lower.includes("lifestyle") || lower.includes("food") || lower.includes("health")) return "lifestyle";
  return "tech"; // default
}

// POST /api/discovery/catalog/import - Admin only: import from public OPML directories
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

  const results = {
    sources: [] as { name: string; fetched: number; added: number; error?: string }[],
    totalFetched: 0,
    totalAdded: 0,
    totalSkipped: 0,
  };

  for (const source of OPML_SOURCES) {
    try {
      console.log(`[discovery/import] fetching ${source.name} from ${source.url}`);

      const response = await fetch(source.url, {
        headers: { "User-Agent": "FeedFerret/1.0" },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        results.sources.push({ name: source.name, fetched: 0, added: 0, error: `HTTP ${response.status}` });
        continue;
      }

      const xml = await response.text();
      const feeds = extractFeedsFromOpml(xml, source.defaultCategory);

      let added = 0;
      for (const feed of feeds) {
        try {
          await db.discoveryCatalogFeed.upsert({
            where: { url: feed.url },
            create: {
              url: feed.url,
              title: feed.title,
              description: feed.description,
              category: feed.category,
              language: "en",
              popularity: 50,
            },
            update: {
              // Only update if not already set
            },
          });
          added++;
        } catch {
          // Skip duplicates
        }
      }

      results.sources.push({ name: source.name, fetched: feeds.length, added });
      results.totalFetched += feeds.length;
      results.totalAdded += added;
      results.totalSkipped += feeds.length - added;

      console.log(`[discovery/import] ${source.name}: ${feeds.length} feeds found, ${added} added`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      results.sources.push({ name: source.name, fetched: 0, added: 0, error: message });
      console.error(`[discovery/import] ${source.name} failed:`, message);
    }
  }

  // Get final count
  const totalCount = await db.discoveryCatalogFeed.count();

  return NextResponse.json({
    success: true,
    ...results,
    totalInCatalog: totalCount,
  });
}

// GET /api/discovery/catalog/import - Get import status/stats
export async function GET(request: Request) {
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

  const totalCount = await db.discoveryCatalogFeed.count();
  const byCategory = await db.discoveryCatalogFeed.groupBy({
    by: ["category"],
    _count: { id: true },
  });

  return NextResponse.json({
    totalFeeds: totalCount,
    byCategory: byCategory.map((c: { category: string; _count: { id: number } }) => ({
      category: c.category,
      count: c._count.id,
    })),
    sources: OPML_SOURCES.map((s) => s.name),
  });
}
