import { db } from "./db";
import { applyAutoReadRules } from "./auto-read-rules";
import { applyKeywordAlerts } from "./keyword-alerts";
import { queueNewArticleNotifications } from "./notifications";
import { fetchFeedArticles, type FetchedFeedArticle } from "./feed-fetcher";
import { syncDynamicOpmlCategories } from "./dynamic-opml";
import { fetchTextWithSsrfProtection, isTrustedFeedFetchingAllowed } from "./ssrf";
import { computeContentHash } from "./content-hash";
import { decryptIfValue } from "./crypto";
import type { AiConfig } from "./ai-summary";
import { logger } from "./logger";
import { getSanitizer } from "./sanitize-html";
import { resolveFullTextMode } from "./full-text-mode";
import { fetchAndExtractReadable } from "./readability-extract";

const MAX_AUTO_SUMMARIES_PER_SYNC = 3;

export interface ArticleSyncInput {
    feedId: string;
    userId: string;
    title: string;
    link: string;
    externalId: string | null;
    dedupeKey: string;
    contentHash: string | null;
    content: string;
    excerpt: string;
    author: string | null;
    publishedAt: Date;
    imageUrl?: string | null;
}

export interface ArticleSyncResult {
    upsertedIds: string[];
    createdArticleIds: string[];
}

// The fields the original per-article `upsert.update` clause overwrote on an existing
// row. Kept as a single list so the "did anything actually change" comparison and the
// update payload can't drift apart.
function updatableFields(article: ArticleSyncInput) {
    return {
        title: article.title,
        link: article.link,
        externalId: article.externalId,
        content: article.content,
        excerpt: article.excerpt,
        author: article.author,
        publishedAt: article.publishedAt,
        imageUrl: article.imageUrl ?? null,
    };
}

/**
 * Folds articles that share a dedupe key within the same batch down to one entry,
 * mirroring what a sequential `upsert` loop over the same array would leave in the
 * DB: the first occurrence's identity (id-defining fields: dedupeKey/contentHash) is
 * kept, but the overwritable fields end up with the *last* occurrence's values,
 * since each subsequent upsert in the original loop would overwrite them again.
 * This also sidesteps a `createMany` unique-constraint violation when a feed's
 * `unicityCriteria` is loose enough to produce duplicate keys within one fetch.
 */
function foldByDedupeKey(articles: ArticleSyncInput[]): ArticleSyncInput[] {
    const order: string[] = [];
    const byKey = new Map<string, ArticleSyncInput>();
    for (const article of articles) {
        const prior = byKey.get(article.dedupeKey);
        if (!prior) {
            order.push(article.dedupeKey);
            byKey.set(article.dedupeKey, article);
        } else {
            byKey.set(article.dedupeKey, { ...prior, ...updatableFields(article) });
        }
    }
    return order.map((key) => byKey.get(key)!);
}

/**
 * Batches what used to be a per-article `findUnique` -> `upsert` -> cross-feed
 * `findFirst` -> conditional `update` loop (P-1) into a small, fixed number of
 * queries regardless of batch size:
 *  1. one `findMany` to load existing rows for the batch's dedupe keys
 *  2. one `createManyAndReturn` for genuinely-new articles
 *  3. individual `update`s only for existing rows whose fetched fields actually
 *     differ from what's stored (an unconditional overwrite would otherwise just
 *     rewrite identical data)
 *  4. one `findMany` over the batch's content hashes for cross-feed duplicate
 *     detection, resolved in memory, instead of one `findFirst` per new article
 *
 * Dedupe semantics are unchanged: the same `userId_feedId_dedupeKey` identifies an
 * "existing" row, and cross-feed duplicate linking still picks the earliest-created
 * non-duplicate article sharing a `contentHash` as canonical — including another
 * article created earlier in this same batch, which the original sequential loop
 * would also have seen (each iteration's insert was committed, and thus visible,
 * before the next iteration's duplicate check ran).
 */
export async function upsertArticleBatch(rawArticles: ArticleSyncInput[]): Promise<ArticleSyncResult> {
    if (rawArticles.length === 0) return { upsertedIds: [], createdArticleIds: [] };

    const articles = foldByDedupeKey(rawArticles);
    const { userId, feedId } = articles[0];
    const dedupeKeys = articles.map((a) => a.dedupeKey);

    const existingRows = await db.article.findMany({
        where: { userId, feedId, dedupeKey: { in: dedupeKeys } },
        select: {
            id: true,
            dedupeKey: true,
            title: true,
            link: true,
            externalId: true,
            content: true,
            excerpt: true,
            author: true,
            publishedAt: true,
            imageUrl: true,
        },
    });
    const existingByDedupeKey = new Map(
        existingRows
            .filter((row) => row.dedupeKey !== null)
            .map((row) => [row.dedupeKey as string, row] as const),
    );

    const upsertedIds: string[] = [];
    const newArticles: ArticleSyncInput[] = [];

    for (const article of articles) {
        const existing = existingByDedupeKey.get(article.dedupeKey);
        if (!existing) {
            newArticles.push(article);
            continue;
        }

        upsertedIds.push(existing.id);

        const next = updatableFields(article);
        const changed =
            existing.title !== next.title ||
            existing.link !== next.link ||
            existing.externalId !== next.externalId ||
            existing.content !== next.content ||
            existing.excerpt !== next.excerpt ||
            existing.author !== next.author ||
            existing.publishedAt.getTime() !== next.publishedAt.getTime() ||
            (existing.imageUrl ?? null) !== next.imageUrl;

        if (changed) {
            await db.article.update({ where: { id: existing.id }, data: next });
        }
    }

    const createdArticleIds: string[] = [];

    if (newArticles.length > 0) {
        // Cross-feed duplicate candidates that existed *before* this batch, queried
        // up front (before any inserts) so real historical creation order can't get
        // entangled with same-batch rows that may share an identical DB timestamp.
        const contentHashes = Array.from(
            new Set(newArticles.map((a) => a.contentHash).filter((hash): hash is string => !!hash)),
        );
        const preExistingCandidates = contentHashes.length > 0
            ? await db.article.findMany({
                where: { userId, contentHash: { in: contentHashes }, isDuplicate: false },
                orderBy: { createdAt: "asc" },
                select: { id: true, contentHash: true },
            })
            : [];

        let created: { id: string; dedupeKey: string | null; contentHash: string | null }[];
        try {
            created = await db.article.createManyAndReturn({
                data: newArticles.map((article) => ({
                    feedId: article.feedId,
                    userId: article.userId,
                    title: article.title,
                    link: article.link,
                    externalId: article.externalId,
                    dedupeKey: article.dedupeKey,
                    contentHash: article.contentHash,
                    content: article.content,
                    excerpt: article.excerpt,
                    author: article.author,
                    publishedAt: article.publishedAt,
                    imageUrl: article.imageUrl ?? null,
                })),
                select: { id: true, dedupeKey: true, contentHash: true },
            });
        } catch (error) {
            // A concurrent sync of the same feed could race us on the unique
            // (userId, feedId, dedupeKey) constraint that `createMany` doesn't
            // resolve the way `upsert` does. Fall back to per-row upserts for just
            // this batch of new articles rather than failing the whole sync.
            logger.warn("[rss-sync] batched article insert conflicted, falling back to per-row upsert:", error);
            created = [];
            for (const article of newArticles) {
                const row = await db.article.upsert({
                    where: {
                        userId_feedId_dedupeKey: {
                            userId: article.userId,
                            feedId: article.feedId,
                            dedupeKey: article.dedupeKey,
                        },
                    },
                    update: updatableFields(article),
                    create: {
                        feedId: article.feedId,
                        userId: article.userId,
                        title: article.title,
                        link: article.link,
                        externalId: article.externalId,
                        dedupeKey: article.dedupeKey,
                        contentHash: article.contentHash,
                        content: article.content,
                        excerpt: article.excerpt,
                        author: article.author,
                        publishedAt: article.publishedAt,
                        imageUrl: article.imageUrl ?? null,
                    },
                    select: { id: true, dedupeKey: true, contentHash: true },
                });
                created.push(row);
            }
        }

        for (const row of created) {
            upsertedIds.push(row.id);
            createdArticleIds.push(row.id);
        }

        // Resolve which article is canonical per content hash: a pre-existing
        // article always wins (it was necessarily created before "now"); failing
        // that, the first new article for that hash *in original fetch order*
        // becomes canonical, matching what the sequential loop would have left as
        // non-duplicate (the first one processed finds no candidate yet).
        const canonicalByHash = new Map<string, string>();
        for (const row of preExistingCandidates) {
            if (row.contentHash && !canonicalByHash.has(row.contentHash)) {
                canonicalByHash.set(row.contentHash, row.id);
            }
        }

        const createdIdByDedupeKey = new Map(
            created.filter((row) => row.dedupeKey !== null).map((row) => [row.dedupeKey as string, row.id]),
        );
        for (const article of newArticles) {
            if (!article.contentHash) continue;
            const createdId = createdIdByDedupeKey.get(article.dedupeKey);
            if (!createdId) continue;
            if (!canonicalByHash.has(article.contentHash)) {
                canonicalByHash.set(article.contentHash, createdId);
            }
        }

        for (const article of newArticles) {
            if (!article.contentHash) continue;
            const createdId = createdIdByDedupeKey.get(article.dedupeKey);
            if (!createdId) continue;
            const canonicalId = canonicalByHash.get(article.contentHash);
            if (canonicalId && canonicalId !== createdId) {
                await db.article.update({
                    where: { id: createdId },
                    data: { isDuplicate: true, duplicateOf: canonicalId },
                });
            }
        }
    }

    return { upsertedIds, createdArticleIds };
}

/**
 * Syncs a single feed for a specific user.
 */
export async function syncFeed(userId: string, feedId: string) {
    const feed = await db.feed.findUnique({
        where: { id: feedId, userId },
    });

    if (!feed) throw new Error("Feed not found");

    try {
        const remoteFeed = await fetchFeedArticles(feed);

        if (remoteFeed.notModified) {
            // Conditional GET (P-2): server confirmed nothing changed since our last
            // fetch, so skip article processing entirely. A 304 response is allowed
            // to omit ETag/Last-Modified (RFC 7232) — only overwrite our stored
            // values if the server actually repeated them; otherwise keep what we
            // have so the next request can still send a conditional GET.
            await db.feed.update({
                where: { id: feed.id },
                data: {
                    lastFetchedAt: new Date(),
                    lastStatus: "ok",
                    lastError: null,
                    ...(remoteFeed.etag ? { etag: remoteFeed.etag } : {}),
                    ...(remoteFeed.lastModifiedHeader ? { lastModifiedHeader: remoteFeed.lastModifiedHeader } : {}),
                },
            });
            return { success: true, count: 0, createdArticleIds: [] };
        }

        const feedPatch: any = {
            lastFetchedAt: new Date(),
            lastStatus: "ok",
            lastError: null,
            etag: remoteFeed.etag ?? null,
            lastModifiedHeader: remoteFeed.lastModifiedHeader ?? null,
        };

        if (!feed.name || feed.name === "New Feed") {
            feedPatch.name = remoteFeed.title || feed.name;
        }
        if (!feed.description && remoteFeed.description) feedPatch.description = remoteFeed.description;
        if (!feed.htmlUrl && remoteFeed.htmlUrl) feedPatch.htmlUrl = remoteFeed.htmlUrl;

        const DOMPurify = await getSanitizer();

        const maxChars = feed.maxSizeKb ? feed.maxSizeKb * 1024 : undefined;

        const articles = remoteFeed.articles.map((item) => {
            let content = item.content || item.summary || "";
            if (maxChars && content.length > maxChars) {
                content = content.slice(0, maxChars);
            }
            const excerpt = DOMPurify.sanitize(content, { ALLOWED_TAGS: [] }).substring(0, 200);

            const externalId = item.externalId || item.link || null;
            const dedupeKey = buildDedupeKey(feed, item, externalId);
            const link = item.link || `${feed.url}#${encodeURIComponent(dedupeKey)}`;

            return {
                feedId: feed.id,
                userId: userId,
                title: item.title || "Untitled",
                link,
                externalId,
                dedupeKey,
                contentHash: computeContentHash(link),
                content: DOMPurify.sanitize(content),
                excerpt: excerpt,
                author: item.author || null,
                publishedAt: item.publishedAt || new Date(),
                imageUrl: item.imageUrl,
            };
        });

        const { upsertedIds, createdArticleIds } = await upsertArticleBatch(articles);

        await db.feed.update({
            where: { id: feed.id },
            data: feedPatch,
        });

        // Auto full-text extraction for newly synced articles. `fullTextMode`
        // defaults to "off" for every pre-existing row, so it can't be trusted
        // alone — resolveFullTextMode() falls back to the legacy
        // `autoFetchFullText` boolean so feeds that already relied on it keep
        // working unchanged.
        if (upsertedIds.length > 0) {
            const mode = resolveFullTextMode(feed);
            if (mode === "selector") {
                await autoFetchFullTextForArticles(userId, upsertedIds, feed);
            } else if (mode === "auto") {
                await autoFetchFullTextViaEngine(userId, upsertedIds, feed);
            }
        }

        if (createdArticleIds.length > 0) {
            await autoSummarizeNewArticles(userId, createdArticleIds);
        }

        if (createdArticleIds.length > 0) {
            await applyKeywordAlerts(userId, createdArticleIds).catch((e) =>
                logger.error("[rss-sync] keyword alerts failed:", e),
            );
            await queueNewArticleNotifications(userId, createdArticleIds).catch((e) =>
                logger.error("[rss-sync] push notification queue failed:", e),
            );
            // Webhook: new_article events (one per created article, non-blocking)
        }

        return { success: true, count: articles.length, createdArticleIds };
    } catch (error) {
        logger.error(`Error syncing feed ${feed.url}:`, error);
        await db.feed.update({
            where: { id: feed.id },
            data: {
                lastFetchedAt: new Date(),
                lastStatus: "error",
                lastError: String(error).slice(0, 1000),
            },
        });
        const errorMessage = String(error).slice(0, 500);
        // Fire matching feed_error rules (in-app/push/email/webhook actions)
        import("@/lib/auto-read-rules")
            .then(({ applyFeedErrorRules }) =>
                applyFeedErrorRules(userId, {
                    feedId: feed.id,
                    feedName: feed.name,
                    feedUrl: feed.url,
                    error: errorMessage,
                }),
            )
            .catch((e) => logger.warn("[rss-sync] feed_error rules failed:", e));
        return { success: false, error: String(error) };
    }
}

async function autoFetchFullTextForArticles(
    userId: string,
    articleIds: string[],
    feed: {
        fullTextSelector?: string | null;
        fullTextRemoveSelectors?: string | null;
    },
) {
    const { JSDOM } = await import("jsdom");
    const DOMPurify = await getSanitizer();

    const articles = await db.article.findMany({
        where: { id: { in: articleIds }, userId },
        select: { id: true, link: true, content: true },
    });

    for (const article of articles) {
        if (!article.link) continue;
        try {
            const html = await fetchTextWithSsrfProtection(
                article.link,
                { headers: { "User-Agent": "FeedFerret/1.0", Accept: "text/html" } },
                {
                    allowInternal: await isTrustedFeedFetchingAllowed(),
                    context: "Full-text fetch",
                    maxBytes: 2 * 1024 * 1024,
                    maxRedirects: 5,
                    timeoutMs: 12_000,
                },
            );
            const dom = new JSDOM(html, { url: article.link });
            const document = dom.window.document;

            // Remove unwanted elements
            const removeSelectors = [
                "script", "style", "nav", "footer", "header", "aside", "form", "iframe", "noscript", "svg",
                ...(feed.fullTextRemoveSelectors
                    ? feed.fullTextRemoveSelectors.split(",").map((s) => s.trim()).filter(Boolean)
                    : []),
            ];
            document.querySelectorAll(removeSelectors.join(",")).forEach((n: Element) => n.remove());

            // Resolve relative URLs
            document.querySelectorAll("a[href], img[src]").forEach((node: Element) => {
                const attr = node instanceof dom.window.HTMLImageElement ? "src" : "href";
                const value = node.getAttribute(attr);
                if (!value) return;
                try { node.setAttribute(attr, new URL(value, article.link).toString()); } catch { /* ignore */ }
            });

            let best: Element | undefined;
            if (feed.fullTextSelector) {
                best = document.querySelector(feed.fullTextSelector) ?? undefined;
            }
            if (!best) {
                const candidates = ["article", "main", "[role='main']", ".post-content", ".entry-content", ".article-content", ".content"]
                    .flatMap((s) => Array.from<Element>(document.querySelectorAll(s)))
                    .concat(Array.from<Element>(document.body.children));
                best = candidates
                    .map((el: Element) => ({
                        el,
                        score: (el.textContent?.trim().length || 0) + el.querySelectorAll("p").length * 250 - el.querySelectorAll("a").length * 20,
                    }))
                    .sort((a, b) => b.score - a.score)[0]?.el;
            }

            if (!best) continue;

            const sanitized = DOMPurify.sanitize(best.innerHTML, { ADD_ATTR: ["target", "rel"] }).trim();
            const plain = DOMPurify.sanitize(sanitized, { ALLOWED_TAGS: [] }).replace(/\s+/g, " ").trim();

            if (plain.length < 400) continue;

            await db.article.update({
                where: { id: article.id, userId },
                data: { content: sanitized, contentFormat: "html", excerpt: plain.slice(0, 240) },
            });
        } catch (e) {
            logger.warn(`[rss-sync] autoFetchFullText failed for ${article.link}:`, e);
        }
    }
}

// Minimum plain-text length a fetched-and-extracted article body must have to
// be considered an improvement worth storing, mirroring the threshold the
// selector-based path (autoFetchFullTextForArticles) uses.
const MIN_ENGINE_EXTRACTED_TEXT_LENGTH = 400;

/**
 * "auto" full-text mode: fetches each article's source page and runs it
 * through the readability extraction engine (Defuddle -> Readability
 * fallback), storing the result as either HTML or Markdown per the feed's
 * `defaultContentFormat`. Unlike the selector/heuristic path, this doesn't
 * use `feed.fullTextSelector` at all — extraction quality comes from the
 * engine's own content scoring.
 */
async function autoFetchFullTextViaEngine(
    userId: string,
    articleIds: string[],
    feed: {
        defaultContentFormat?: string | null;
    },
) {
    const DOMPurify = await getSanitizer();

    const articles = await db.article.findMany({
        where: { id: { in: articleIds }, userId },
        select: { id: true, link: true, content: true },
    });

    for (const article of articles) {
        if (!article.link) continue;
        try {
            const result = await fetchAndExtractReadable(article.link);
            if (result.extractedBy === "none" || !result.html) {
                // Extraction failed to find anything useful — leave the
                // feed-provided content as-is.
                continue;
            }

            const useMarkdown = feed.defaultContentFormat === "markdown";
            const content = useMarkdown ? result.markdown : result.html;
            if (!content) continue;

            const plain = DOMPurify.sanitize(result.html, { ALLOWED_TAGS: [] }).replace(/\s+/g, " ").trim();
            if (plain.length < MIN_ENGINE_EXTRACTED_TEXT_LENGTH) continue;

            const excerpt = result.excerpt?.trim() || plain.slice(0, 240);

            await db.article.update({
                where: { id: article.id, userId },
                data: {
                    content,
                    contentFormat: useMarkdown ? "markdown" : "html",
                    excerpt,
                },
            });
        } catch (e) {
            logger.warn(`[rss-sync] autoFetchFullTextViaEngine failed for ${article.link}:`, e);
        }
    }
}

async function autoSummarizeNewArticles(userId: string, articleIds: string[]) {
    const user = await db.user.findUnique({
        where: { id: userId },
        select: {
            aiAutoSummarize: true,
            aiProvider: true,
            aiApiKey: true,
            aiModel: true,
            aiOllamaBaseUrl: true,
            aiSummaryLanguage: true,
        },
    });

    if (!user?.aiAutoSummarize || !user.aiProvider) return;

    const { generateSummary } = await import("./ai-summary");

    const articles = await db.article.findMany({
        where: {
            id: { in: articleIds },
            userId,
            isDuplicate: false,
            aiSummary: null,
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, content: true },
        take: MAX_AUTO_SUMMARIES_PER_SYNC,
    });

    for (const article of articles) {
        const content = article.content?.trim();
        if (!content) continue;

        try {
            const summary = await generateSummary(content, {
                provider: user.aiProvider as AiConfig["provider"],
                apiKey: decryptIfValue(user.aiApiKey),
                model: user.aiModel,
                ollamaBaseUrl: user.aiOllamaBaseUrl,
                language: user.aiSummaryLanguage,
            });

            await db.article.update({
                where: { id: article.id },
                data: { aiSummary: summary, aiSummarizedAt: new Date() },
            });
        } catch (error) {
            logger.error("[rss-sync] auto-summary failed:", error);
        }
    }
}

export async function syncUserFeeds(userId: string) {
    await syncDynamicOpmlCategories(userId).catch((e) =>
        logger.error("[rss-sync] dynamic OPML sync failed:", e),
    );

    const user = await db.user.findUnique({
        where: { id: userId },
        select: { defaultUpdateFrequency: true },
    });
    const userDefaultUpdateFrequency = user?.defaultUpdateFrequency ?? 60;

    const feeds = await db.feed.findMany({
        where: { userId },
        select: {
            id: true,
            userId: true,
            url: true,
            updateFrequency: true,
            lastFetchedAt: true,
            category: {
                select: {
                    parentId: true,
                    updateFrequency: true,
                    parent: { select: { updateFrequency: true } },
                },
            },
        },
    });

    const results = [];
    const concurrency = 4;

    for (let i = 0; i < feeds.length; i += concurrency) {
        const batch = feeds.slice(i, i + concurrency);
        const batchResults = await Promise.all(
            batch.map(async (feed) => {
                const effectiveUpdateFrequency = computeEffectiveUpdateFrequency(
                    feed,
                    userDefaultUpdateFrequency,
                );
                const now = new Date();
                const lastSync = feed.lastFetchedAt || new Date(0);
                const diffMinutes = (now.getTime() - lastSync.getTime()) / (1000 * 60);

                if (diffMinutes < effectiveUpdateFrequency) {
                    return { feed: feed.url, success: true, skipped: true, count: 0 };
                }

                const res = await syncFeed(feed.userId, feed.id);
                return { feed: feed.url, ...res };
            }),
        );
        results.push(...batchResults);
    }

    const hasSynced = results.some((r: any) => r.success && !r.skipped);
    if (hasSynced) {
        await applyAutoReadRules(userId).catch((e) =>
            logger.error("[rss-sync] applyAutoReadRules failed:", e),
        );
    }

    return results;
}

export async function syncAllFeeds() {
    await syncDynamicOpmlCategories().catch((e) =>
        logger.error("[rss-sync] dynamic OPML sync failed:", e),
    );

    const feeds = await db.feed.findMany({
        select: {
            id: true,
            userId: true,
            url: true,
            updateFrequency: true,
            lastFetchedAt: true,
            category: {
                select: {
                    parentId: true,
                    updateFrequency: true,
                    parent: { select: { updateFrequency: true } },
                },
            },
            user: { select: { defaultUpdateFrequency: true } },
        },
    });

    const results = [];
    const concurrency = 4;

    for (let i = 0; i < feeds.length; i += concurrency) {
        const batch = feeds.slice(i, i + concurrency);
        const batchResults = await Promise.all(
            batch.map(async (feed) => {
                const effectiveUpdateFrequency = computeEffectiveUpdateFrequency(
                    feed,
                    feed.user.defaultUpdateFrequency,
                );
                const now = new Date();
                const lastSync = feed.lastFetchedAt || new Date(0);
                const diffMinutes = (now.getTime() - lastSync.getTime()) / (1000 * 60);

                if (diffMinutes < effectiveUpdateFrequency) {
                    return { feed: feed.url, success: true, skipped: true, count: 0 };
                }

                const res = await syncFeed(feed.userId, feed.id);
                return { feed: feed.url, ...res };
            }),
        );
        results.push(...batchResults);
    }

    return results;
}

type FrequencyResolutionFeed = {
    updateFrequency: number | null;
    category: {
        parentId: string | null;
        updateFrequency: number | null;
        parent: { updateFrequency: number | null } | null;
    } | null;
};

/**
 * Mirrors `getEffectiveSettings`'s resolution hierarchy (Feed -> Subcategory -> Category ->
 * User Global -> Site Default) but works off data already loaded in the outer feed query,
 * so the sync loop doesn't re-fetch each feed's settings.
 */
function computeEffectiveUpdateFrequency(
    feed: FrequencyResolutionFeed,
    userDefaultUpdateFrequency: number,
): number {
    // 1. Feed level
    if (feed.updateFrequency !== null) {
        return feed.updateFrequency;
    }

    // 2. Subcategory level (if category has parent)
    if (feed.category && feed.category.parentId) {
        if (feed.category.updateFrequency !== null) {
            return feed.category.updateFrequency;
        }
    }

    // 3. Category level (top-level or parent)
    if (feed.category) {
        const topLevelFrequency = feed.category.parentId
            ? feed.category.parent?.updateFrequency
            : feed.category.updateFrequency;

        if (topLevelFrequency !== null && topLevelFrequency !== undefined) {
            return topLevelFrequency;
        }
    }

    // 4. User global level
    if (userDefaultUpdateFrequency) {
        return userDefaultUpdateFrequency;
    }

    // 5. Site default
    return 60;
}

function buildDedupeKey(
    feed: { unicityCriteria?: string | null },
    item: FetchedFeedArticle,
    externalId: string | null,
) {
    const parts = (feed.unicityCriteria || "id")
        .split(":")
        .map((part) => part.trim())
        .filter(Boolean);

    const valueFor = (part: string) => {
        if (part === "id" || part === "guid" || part === "uid") return externalId;
        if (part === "link" || part === "uri" || part === "url") return item.link;
        if (part === "title") return item.title;
        if (part === "author") return item.author;
        if (part === "date" || part === "timestamp") return item.publishedAt?.toISOString();
        return null;
    };

    const values = parts.map(valueFor).filter(Boolean);
    if (values.length > 0) return values.join(":");
    return externalId || item.link || item.title;
}
