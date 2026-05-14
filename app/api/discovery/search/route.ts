import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  checkRateLimit,
  getClientIdentifier,
  rateLimitHeaders,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export const runtime = "nodejs";

interface FeedsearchResult {
  url: string;
  title?: string;
  description?: string;
  site_url?: string;
  favicon?: string;
  content_type?: string;
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const identifier = getClientIdentifier(request, session.user.id);
  const rateCheck = checkRateLimit(identifier, RATE_LIMITS.discoverySearch);

  if (!rateCheck.success) {
    return NextResponse.json(
      {
        error: "Rate limit exceeded",
        retryAfter: rateCheck.retryAfterSecs,
      },
      {
        status: 429,
        headers: rateLimitHeaders(rateCheck),
      }
    );
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q");

  if (!query || query.length < 2) {
    return NextResponse.json(
      { error: "Query must be at least 2 characters" },
      { status: 400, headers: rateLimitHeaders(rateCheck) }
    );
  }

  try {
    // Feedsearch.dev API - searches for RSS feeds at a given URL or domain
    const feedsearchUrl = `https://feedsearch.dev/api/v1/search?url=${encodeURIComponent(query)}`;

    const response = await fetch(feedsearchUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "FeedFerret/1.0 (RSS Reader; +https://github.com/feedferret)",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      // Feedsearch might return 404 for no results
      if (response.status === 404) {
        return NextResponse.json(
          { feeds: [], source: "feedsearch" },
          { headers: rateLimitHeaders(rateCheck) }
        );
      }
      throw new Error(`Feedsearch returned ${response.status}`);
    }

    const data: FeedsearchResult[] = await response.json();

    // Transform to our format
    const feeds = (Array.isArray(data) ? data : []).map((item) => ({
      url: item.url,
      title: item.title || item.url,
      description: item.description || null,
      siteUrl: item.site_url || null,
      iconUrl: item.favicon || null,
      type: item.content_type?.includes("atom")
        ? "atom"
        : item.content_type?.includes("json")
          ? "json"
          : "rss",
    }));

    return NextResponse.json(
      { feeds, source: "feedsearch" },
      { headers: rateLimitHeaders(rateCheck) }
    );
  } catch (error) {
    console.error("[discovery/search] error:", error);
    return NextResponse.json(
      { error: "Search failed", feeds: [] },
      { status: 500, headers: rateLimitHeaders(rateCheck) }
    );
  }
}
