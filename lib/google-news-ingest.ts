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
import { cleanGoogleNewsTitle, isGoogleNewsArticleLink, parseGoogleNewsFeedUrl, resolveGoogleNewsLinks, type ResolveOptions } from "./google-news";
import { logger } from "./logger";

export type GoogleNewsPreparedArticle = FetchedFeedArticle & {
  /** Link-only rewrite of an existing row (resolution caught up): keep updatedAt. */
  linkCosmetic?: boolean;
};

/** How long after creation a row still on a Google link is retried. */
const RETRY_WINDOW_MS = 48 * 60 * 60_000;

export async function prepareGoogleNewsArticles(
  feed: { id: string; url: string; unicityCriteria?: string | null },
  userId: string,
  articles: FetchedFeedArticle[],
  options: ResolveOptions = {},
): Promise<GoogleNewsPreparedArticle[]> {
  try {
    const edition = parseGoogleNewsFeedUrl(feed.url)?.edition;
    const prepared: GoogleNewsPreparedArticle[] = articles.map((item) => ({
      ...item,
      // Pin identity to the guid / original Google link before the link changes.
      externalId: item.externalId || item.link || null,
    }));
    const keyOf = (item: GoogleNewsPreparedArticle) => buildDedupeKey(feed, { ...item, link: item.link }, item.externalId ?? null);
    const keys = prepared.map(keyOf);

    const existing = await db.article.findMany({
      where: { userId, feedId: feed.id, dedupeKey: { in: keys } },
      select: { dedupeKey: true, link: true, title: true, author: true, createdAt: true },
    });
    const byKey = new Map(existing.map((row) => [row.dedupeKey as string, row] as const));

    const fresh: GoogleNewsPreparedArticle[] = [];
    const retry: GoogleNewsPreparedArticle[] = [];
    const cutoff = Date.now() - RETRY_WINDOW_MS;
    prepared.forEach((item, index) => {
      const row = byKey.get(keys[index]);
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
    return articles;
  }
}
