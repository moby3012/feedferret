import { NextResponse } from "next/server";
import { escapeXml, getPublicBaseUrl, getSharedSavedSearch, stripHtml } from "@/lib/saved-search-sharing";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await getSharedSavedSearch(token, 100);
  if (!result) return new NextResponse("Not found", { status: 404 });

  const { savedSearch, articles } = result;
  const baseUrl = getPublicBaseUrl();
  const pageUrl = `${baseUrl}/shared/search/${token}`;

  const items = articles.map((article) => {
    const link = article.link || pageUrl;
    const description = article.excerpt || stripHtml(article.content).slice(0, 500);
    return `
    <item>
      <title>${escapeXml(article.title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="false">${escapeXml(article.id)}</guid>
      <pubDate>${article.publishedAt.toUTCString()}</pubDate>
      <source>${escapeXml(article.feed.name)}</source>
      <description>${escapeXml(description)}</description>
    </item>`;
  }).join("");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(`FeedFerret: ${savedSearch.name}`)}</title>
    <link>${escapeXml(pageUrl)}</link>
    <description>${escapeXml(`Shared saved search: ${savedSearch.query}`)}</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>${items}
  </channel>
</rss>`;

  return new NextResponse(xml, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=300, stale-while-revalidate=600",
    },
  });
}
