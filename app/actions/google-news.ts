"use server";

// G1: Google News keyword feeds — preview, subscribe, edit query.
// The client sends only {query, edition, when}; the server builds the URL
// (fixed origin), so these actions can never be used to fetch arbitrary URLs.

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { fetchFeedArticles } from "@/lib/feed-fetcher";
import { syncFeed } from "@/lib/rss-sync";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { pickFields } from "@/lib/pick-fields";
import { redactFeedForClient } from "@/lib/connector-secrets";
import { stripFeedSecrets } from "@/lib/feed-secrets";
import { cleanGoogleNewsTitle, googleNewsOrigin, isGoogleNewsFeedUrl, parseGoogleNewsFeedUrl } from "@/lib/google-news";
import {
  GOOGLE_NEWS_MAX_QUERY,
  GOOGLE_NEWS_WINDOWS,
  buildGoogleNewsSearchUrl,
  googleNewsFeedName,
  normalizeGoogleNewsQuery,
  type GoogleNewsWindow,
} from "@/lib/google-news-url";

export type GoogleNewsErrorCode = "invalidQuery" | "rateLimited" | "duplicate" | "fetchFailed" | "notFound" | "invalidCategory";

type SearchInput = { query: string; edition?: string; when?: string };

const SEARCH_FIELDS = ["query", "edition", "when"] as const;
const EDITION = /^[a-z]{2,3}-[A-Z]{2}$/;
const PREVIEW_ITEMS = 5;
/** Interactive add/edit: keep the dialog responsive; later syncs catch up. */
const INTERACTIVE_RESOLVE = { budgetMs: 5_000, maxNetwork: 10 };

/** Validates untrusted input and builds the feed URL on this instance's Google News origin. */
function buildFromInput(raw: unknown): { search: { query: string; edition: string; when: GoogleNewsWindow }; url: string } | null {
  const input = pickFields((raw ?? {}) as SearchInput, SEARCH_FIELDS);
  if (typeof input.query !== "string" || input.query.length > GOOGLE_NEWS_MAX_QUERY * 2) return null;
  const query = normalizeGoogleNewsQuery(input.query);
  if (!query) return null;
  const edition = typeof input.edition === "string" && EDITION.test(input.edition) ? input.edition : "de-DE";
  const when = (GOOGLE_NEWS_WINDOWS as readonly string[]).includes(input.when ?? "") ? (input.when as GoogleNewsWindow) : "";
  const url = buildGoogleNewsSearchUrl({ query, edition, when }, googleNewsOrigin());
  return url ? { search: { query, edition, when }, url } : null;
}

async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user.id;
}

export async function previewGoogleNewsFeed(raw: SearchInput) {
  const userId = await requireUser();
  const built = buildFromInput(raw);
  if (!built) return { success: false as const, error: "invalidQuery" as GoogleNewsErrorCode };
  if (!checkRateLimit(`user:${userId}`, RATE_LIMITS.urlDiscover).success) {
    return { success: false as const, error: "rateLimited" as GoogleNewsErrorCode };
  }
  try {
    const feed = await fetchFeedArticles({ url: built.url, fetchTimeoutSecs: 15 });
    const items = [...feed.articles]
      .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
      .slice(0, PREVIEW_ITEMS)
      .map((item) => ({
        title: cleanGoogleNewsTitle(item.title, item.sourceName),
        source: item.sourceName ?? null,
        publishedAt: item.publishedAt ? item.publishedAt.toISOString() : null,
      }));
    return {
      success: true as const,
      name: googleNewsFeedName(built.search.query),
      itemCount: feed.articles.length,
      items,
    };
  } catch (error) {
    logger.warn("[google-news] preview failed:", String(error).slice(0, 200));
    return { success: false as const, error: "fetchFailed" as GoogleNewsErrorCode };
  }
}

export async function addGoogleNewsFeed(raw: SearchInput & { categoryId?: string }) {
  const userId = await requireUser();
  const built = buildFromInput(raw);
  if (!built) return { success: false as const, error: "invalidQuery" as GoogleNewsErrorCode };

  const categoryId = typeof raw?.categoryId === "string" && raw.categoryId ? raw.categoryId : undefined;
  if (categoryId) {
    const category = await db.category.findFirst({ where: { id: categoryId, userId }, select: { id: true } });
    if (!category) return { success: false as const, error: "invalidCategory" as GoogleNewsErrorCode };
  }
  const existing = await db.feed.findFirst({ where: { userId, url: built.url }, select: { id: true } });
  if (existing) return { success: false as const, error: "duplicate" as GoogleNewsErrorCode };

  try {
    // Validate before creating: an unreachable/blocked search adds nothing.
    await fetchFeedArticles({ url: built.url, fetchTimeoutSecs: 15 });
  } catch (error) {
    logger.warn("[google-news] subscribe fetch failed:", String(error).slice(0, 200));
    return { success: false as const, error: "fetchFailed" as GoogleNewsErrorCode };
  }

  const feed = await db.feed.create({
    data: {
      url: built.url,
      name: googleNewsFeedName(built.search.query),
      userId,
      categoryId,
      lastStatus: "pending",
    },
  });
  await syncFeed(userId, feed.id, { googleNews: INTERACTIVE_RESOLVE });
  revalidatePath("/");
  const fresh = await db.feed.findUnique({ where: { id: feed.id } });
  return { success: true as const, feed: await redactFeedForClient(stripFeedSecrets(fresh ?? feed)) };
}

/** The editable search of a Google News feed (null when the feed is not one). */
export async function getGoogleNewsFeedSearch(feedId: string) {
  const userId = await requireUser();
  if (typeof feedId !== "string") return null;
  const feed = await db.feed.findFirst({ where: { id: feedId, userId }, select: { url: true } });
  return feed ? parseGoogleNewsFeedUrl(feed.url) : null;
}

export async function updateGoogleNewsFeedQuery(feedId: string, raw: SearchInput) {
  const userId = await requireUser();
  if (typeof feedId !== "string" || !feedId) return { success: false as const, error: "notFound" as GoogleNewsErrorCode };
  const built = buildFromInput(raw);
  if (!built) return { success: false as const, error: "invalidQuery" as GoogleNewsErrorCode };

  const feed = await db.feed.findFirst({ where: { id: feedId, userId }, select: { id: true, url: true, name: true } });
  if (!feed || !isGoogleNewsFeedUrl(feed.url)) return { success: false as const, error: "notFound" as GoogleNewsErrorCode };
  if (feed.url === built.url) return { success: true as const, changed: false };

  const clash = await db.feed.findFirst({ where: { userId, url: built.url, NOT: { id: feed.id } }, select: { id: true } });
  if (clash) return { success: false as const, error: "duplicate" as GoogleNewsErrorCode };

  const previous = parseGoogleNewsFeedUrl(feed.url);
  // Rename only an auto-generated name; a name the user chose stays.
  const autoNamed =
    !!previous &&
    (feed.name === googleNewsFeedName(previous.query) ||
      feed.name === `"${previous.query}" - Google News` ||
      feed.name === "New Feed");

  await db.feed.update({
    where: { id: feed.id, userId },
    data: {
      url: built.url,
      ...(autoNamed ? { name: googleNewsFeedName(built.search.query) } : {}),
      // New search = new resource: no stale conditional-GET validators, fetch now.
      etag: null,
      lastModifiedHeader: null,
      lastFetchedAt: null,
    },
  });
  await syncFeed(userId, feed.id, { googleNews: INTERACTIVE_RESOLVE });
  revalidatePath("/");
  return { success: true as const, changed: true };
}
