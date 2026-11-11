// Google News keyword feeds (G1): ingest pre-pass run by syncFeed before the
// normal article mapping. Resolves Google redirect links to publisher URLs so
// full-text extraction, favicons and cross-feed dedupe (contentHash of the
// link) see the real article.
//
// Rules:
// - Identity never changes: `externalId` stays Google's guid, so the dedupe
//   key is the same whether or not the link was resolved.
// - Already-stored rows keep their stored link and title (no churn, no
//   Article.updatedAt bump). A recent row still on a Google link may be
//   resolved on a later sync; that rewrite is flagged cosmetic so the batch
//   upsert keeps updatedAt.
// - Bounded: one time budget per sync (newest items first), global
//   concurrency, cache and 429 backoff live in lib/google-news.ts.

import { db } from "./db";
import { buildDedupeKey } from "./dedupe-key";
import type { FetchedFeedArticle } from "./feed-fetcher";
import { cleanGoogleNewsTitle, extractGoogleNewsArticleId, isGoogleNewsArticleLink, parseGoogleNewsFeedUrl, resolveGoogleNewsLinks, type ResolveOptions } from "./google-news";
import { logger } from "./logger";

export type GoogleNewsPreparedArticle = FetchedFeedArticle & {
  /**
   * The row identity, computed ONCE here from the raw item and used verbatim
   * by syncFeed — never re-derived from the resolved link / cleaned title.
   */
  dedupeKey?: string;
  /** Link-only rewrite of an existing row (resolution caught up): keep updatedAt. */
  linkCosmetic?: boolean;
};

/**
 * Stable identity of a Google News item, independent of the feed's
 * unicityCriteria and of link resolution / title cleanup: the guid, else the
 * Google article id, else the raw link. Google News feeds always use it
 * (a link- or title-based key would change once the link resolves or the
 * " - Publisher" suffix is stripped, re-creating the article as unread).
 */
export function googleNewsStableKey(item: { externalId?: string | null; link?: string | null; title?: string | null }): string {
  return item.externalId || extractGoogleNewsArticleId(item.link) || item.link || item.title || "";
}

/** How long after creation a row still on a Google link is retried. */
const RETRY_WINDOW_MS = 48 * 60 * 60_000;

export async function prepareGoogleNewsArticles(
  feed: { id: string; url: string; unicityCriteria?: string | null },
  userId: string,
  articles: FetchedFeedArticle[],
  options: ResolveOptions = {},
): Promise<GoogleNewsPreparedArticle[]> {
  // Identity first, from the raw items, so even the fallback path is stable.
  const prepared: GoogleNewsPreparedArticle[] = articles.map((item) => {
    // Pin identity to the guid / original Google link before the link changes.
    const pinned = { ...item, externalId: item.externalId || item.link || null };
    // Title-less items: identity uses the pre-synthesis placeholder, not the
    // synthesized display title (lib/title-synthesis.ts).
    return { ...pinned, dedupeKey: googleNewsStableKey({ ...pinned, title: item.identityTitle ?? item.title }) };
  });
  // Rows stored before keys were forced stable (feed with link/title
  // criteria) keep their old key: computed exactly as the old sync did.
  const legacyKeys = prepared.map((item) => buildDedupeKey(feed, { ...item, title: item.identityTitle ?? item.title }, item.externalId ?? null));
  try {
    const edition = parseGoogleNewsFeedUrl(feed.url)?.edition;
    const keys = prepared.map((item) => item.dedupeKey!);

    const existing = await db.article.findMany({
      where: { userId, feedId: feed.id, dedupeKey: { in: [...new Set([...keys, ...legacyKeys])] } },
      select: { dedupeKey: true, link: true, title: true, author: true, createdAt: true },
    });
    const byKey = new Map(existing.map((row) => [row.dedupeKey as string, row] as const));

    const fresh: GoogleNewsPreparedArticle[] = [];
    const retry: GoogleNewsPreparedArticle[] = [];
    const cutoff = Date.now() - RETRY_WINDOW_MS;
    prepared.forEach((item, index) => {
      let row = byKey.get(keys[index]);
      if (!row && legacyKeys[index] !== keys[index]) {
        row = byKey.get(legacyKeys[index]);
        if (row) item.dedupeKey = legacyKeys[index];
      }
      if (!row) {
        item.title = cleanGoogleNewsTitle(item.title, item.sourceName);
        if (!item.author && item.sourceName) item.author = item.sourceName;
        if (isGoogleNewsArticleLink(item.link)) fresh.push(item);
        return;
      }
      // Stored rows: keep what is stored, so a re-fetch changes nothing.
      item.link = row.link;
      item.title = row.title;
      item.author = row.author;
      if (isGoogleNewsArticleLink(row.link) && row.createdAt.getTime() >= cutoff) retry.push(item);
    });

    const byNewest = (a: GoogleNewsPreparedArticle, b: GoogleNewsPreparedArticle) =>
      (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0);
    const queue = [...fresh.sort(byNewest), ...retry.sort(byNewest)];
    if (queue.length === 0) return prepared;

    const resolved = await resolveGoogleNewsLinks(queue.map((item) => item.link), { edition, ...options });
    for (const item of queue) {
      const url = resolved.get(item.link);
      if (!url) continue;
      if (retry.includes(item)) item.linkCosmetic = true;
      item.link = url;
    }
    return prepared;
  } catch (error) {
    // Never fail a sync over link resolution: fall back to the Google links.
    logger.warn("[google-news] link pre-pass failed:", String(error).slice(0, 200));
    return prepared;
  }
}
