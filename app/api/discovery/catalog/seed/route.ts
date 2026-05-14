import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// Initial curated feeds for the discovery catalog
const SEED_FEEDS = [
  // Tech
  { url: "https://news.ycombinator.com/rss", title: "Hacker News", category: "tech", language: "en", popularity: 100 },
  { url: "https://www.theverge.com/rss/index.xml", title: "The Verge", category: "tech", language: "en", popularity: 95 },
  { url: "https://techcrunch.com/feed/", title: "TechCrunch", category: "tech", language: "en", popularity: 90 },
  { url: "https://www.wired.com/feed/rss", title: "Wired", category: "tech", language: "en", popularity: 85 },
  { url: "https://arstechnica.com/feed/", title: "Ars Technica", category: "tech", language: "en", popularity: 88 },
  { url: "https://www.heise.de/rss/heise-atom.xml", title: "Heise Online", category: "tech", language: "de", popularity: 80 },
  { url: "https://www.golem.de/rss.php?feed=RSS2.0", title: "Golem.de", category: "tech", language: "de", popularity: 75 },

  // News
  { url: "https://feeds.bbci.co.uk/news/rss.xml", title: "BBC News", category: "news", language: "en", popularity: 100 },
  { url: "https://www.theguardian.com/international/rss", title: "The Guardian", category: "news", language: "en", popularity: 95 },
  { url: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", title: "New York Times", category: "news", language: "en", popularity: 90 },
  { url: "https://feeds.reuters.com/reuters/topNews", title: "Reuters", category: "news", language: "en", popularity: 88 },
  { url: "https://www.spiegel.de/schlagzeilen/tops/index.rss", title: "Spiegel Online", category: "news", language: "de", popularity: 85 },
  { url: "https://www.tagesschau.de/xml/rss2/", title: "Tagesschau", category: "news", language: "de", popularity: 90 },

  // Dev
  { url: "https://css-tricks.com/feed/", title: "CSS-Tricks", category: "dev", language: "en", popularity: 90 },
  { url: "https://dev.to/feed", title: "DEV Community", category: "dev", language: "en", popularity: 85 },
  { url: "https://www.smashingmagazine.com/feed/", title: "Smashing Magazine", category: "dev", language: "en", popularity: 88 },
  { url: "https://changelog.com/feed", title: "The Changelog", category: "dev", language: "en", popularity: 80 },
  { url: "https://blog.rust-lang.org/feed.xml", title: "Rust Blog", category: "dev", language: "en", popularity: 75 },
  { url: "https://react.dev/rss.xml", title: "React Blog", category: "dev", language: "en", popularity: 82 },

  // Science
  { url: "https://www.nasa.gov/rss/dyn/breaking_news.rss", title: "NASA Breaking News", category: "science", language: "en", popularity: 95 },
  { url: "https://www.quantamagazine.org/feed/", title: "Quanta Magazine", category: "science", language: "en", popularity: 90 },
  { url: "https://www.scientificamerican.com/feed/", title: "Scientific American", category: "science", language: "en", popularity: 85 },
  { url: "https://www.nature.com/nature.rss", title: "Nature", category: "science", language: "en", popularity: 88 },

  // Business
  { url: "https://www.economist.com/finance-and-economics/rss.xml", title: "The Economist - Finance", category: "business", language: "en", popularity: 90 },
  { url: "https://feeds.bloomberg.com/markets/news.rss", title: "Bloomberg Markets", category: "business", language: "en", popularity: 85 },
  { url: "https://www.ft.com/rss/home", title: "Financial Times", category: "business", language: "en", popularity: 88 },

  // Gaming
  { url: "https://kotaku.com/rss", title: "Kotaku", category: "gaming", language: "en", popularity: 90 },
  { url: "https://www.polygon.com/rss/index.xml", title: "Polygon", category: "gaming", language: "en", popularity: 85 },
  { url: "https://www.ign.com/rss/articles", title: "IGN", category: "gaming", language: "en", popularity: 88 },
  { url: "https://www.rockpapershotgun.com/feed", title: "Rock Paper Shotgun", category: "gaming", language: "en", popularity: 80 },

  // Design
  { url: "https://alistapart.com/main/feed/", title: "A List Apart", category: "design", language: "en", popularity: 85 },
  { url: "https://uxdesign.cc/feed", title: "UX Collective", category: "design", language: "en", popularity: 80 },
  { url: "https://www.nngroup.com/feed/rss/", title: "Nielsen Norman Group", category: "design", language: "en", popularity: 88 },

  // Entertainment
  { url: "https://www.hollywoodreporter.com/feed/", title: "Hollywood Reporter", category: "entertainment", language: "en", popularity: 85 },
  { url: "https://variety.com/feed/", title: "Variety", category: "entertainment", language: "en", popularity: 83 },

  // Sports
  { url: "https://www.espn.com/espn/rss/news", title: "ESPN", category: "sports", language: "en", popularity: 90 },
  { url: "https://www.kicker.de/rss/news", title: "Kicker", category: "sports", language: "de", popularity: 85 },

  // Lifestyle
  { url: "https://lifehacker.com/rss", title: "Lifehacker", category: "lifestyle", language: "en", popularity: 80 },
  { url: "https://www.apartmenttherapy.com/main.rss", title: "Apartment Therapy", category: "lifestyle", language: "en", popularity: 75 },
];

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
    console.error("[discovery/catalog/seed] error:", error);
    return NextResponse.json({ error: "Seeding failed" }, { status: 500 });
  }
}
