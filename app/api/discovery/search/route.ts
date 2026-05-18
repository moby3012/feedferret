import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  checkRateLimit,
  getClientIdentifier,
  rateLimitHeaders,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { discoverFeedsAtUrl } from "@/lib/feed-discovery";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

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

  if (query.length > 500) {
    return NextResponse.json(
      { error: "Query too long (max 500 characters)" },
      { status: 400, headers: rateLimitHeaders(rateCheck) }
    );
  }

  // Normalize query to URL format for Feedsearch.dev API
  // API requires a valid URL/domain - keywords won't work
  let searchUrl = query.trim();
  const looksLikeDomain = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+$/.test(searchUrl);
  const isUrl = searchUrl.startsWith("http://") || searchUrl.startsWith("https://");

  if (!isUrl && looksLikeDomain) {
    searchUrl = `https://${searchUrl}`;
  }

  // If query is not a valid URL/domain, skip external API and use local discovery only
  const canUseExternalApi = isUrl || looksLikeDomain;

  try {
    // For keywords (not URLs/domains): search local catalog
    if (!canUseExternalApi) {
      logger.log("[discovery/search] keyword search in local catalog:", query);

      const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length >= 2);
      if (keywords.length === 0) {
        return NextResponse.json(
          { feeds: [], source: "catalog" },
          { headers: rateLimitHeaders(rateCheck) }
        );
      }

      // Search catalog by title, description, category, url
      const catalogResults = await db.discoveryCatalogFeed.findMany({
        where: {
          enabled: true,
          OR: keywords.flatMap(keyword => [
            { title: { contains: keyword } },
            { description: { contains: keyword } },
            { category: { contains: keyword } },
            { url: { contains: keyword } },
          ]),
        },
        orderBy: { popularity: "desc" },
        take: 100,
      });

      const feeds = catalogResults.map((item) => ({
        url: item.url,
        title: item.title,
        description: item.description,
        siteUrl: null,
        iconUrl: item.iconUrl,
        type: "rss" as const,
      }));

      return NextResponse.json(
        { feeds, source: "catalog" },
        { headers: rateLimitHeaders(rateCheck) }
      );
    }

    // For URLs/domains: use Feedsearch.dev API
    const feedsearchUrl = `https://feedsearch.dev/api/v1/search?url=${encodeURIComponent(searchUrl)}`;
    logger.log("[discovery/search] querying feedsearch.dev:", feedsearchUrl);

    const response = await fetch(feedsearchUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "FeedFerret/1.0 (RSS Reader; +https://github.com/feedferret)",
      },
      signal: AbortSignal.timeout(15000),
    });

    logger.log("[discovery/search] response status:", response.status);

    if (!response.ok) {
      // Feedsearch might return 404 for no results
      if (response.status === 404) {
        return NextResponse.json(
          { feeds: [], source: "feedsearch" },
          { headers: rateLimitHeaders(rateCheck) }
        );
      }
      const errorText = await response.text().catch(() => "");
      logger.error("[discovery/search] API error:", response.status, errorText);
      throw new Error(`Feedsearch returned ${response.status}`);
    }

    const data: FeedsearchResult[] = await response.json();
    logger.log("[discovery/search] found feeds:", data.length);

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
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[discovery/search] feedsearch.dev error:", message);

    // Fallback: try local feed discovery if query looks like a URL
    if (searchUrl.startsWith("http")) {
      try {
        logger.log("[discovery/search] falling back to local discovery for:", searchUrl);
        const localFeeds = await discoverFeedsAtUrl(searchUrl);
        if (localFeeds.length > 0) {
          const feeds = localFeeds.map((f) => ({
            url: f.url,
            title: f.title,
            description: null,
            siteUrl: searchUrl,
            iconUrl: null,
            type: f.type,
          }));
          return NextResponse.json(
            { feeds, source: "local" },
            { headers: rateLimitHeaders(rateCheck) }
          );
        }
      } catch (localError) {
        logger.error("[discovery/search] local fallback also failed:", localError);
      }
    }

    return NextResponse.json(
      { error: `Search failed: ${message}`, feeds: [] },
      { status: 500, headers: rateLimitHeaders(rateCheck) }
    );
  }
}
