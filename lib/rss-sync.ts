import { db } from "./db";
import { getEffectiveSettings } from "./settings";
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

async function getSanitizer() {
    const { default: DOMPurify } = await import("isomorphic-dompurify");
    return DOMPurify;
}

const MAX_AUTO_SUMMARIES_PER_SYNC = 3;

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

        const feedPatch: any = {
            lastFetchedAt: new Date(),
            lastStatus: "ok",
            lastError: null,
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

        const upsertedIds: string[] = [];
        const createdArticleIds: string[] = [];

        for (const article of articles) {
            const where = {
                userId_feedId_dedupeKey: {
                    userId: userId,
                    feedId: feed.id,
                    dedupeKey: article.dedupeKey,
                },
            };

            const existing = await db.article.findUnique({
                where,
                select: { id: true },
            });

            const upserted = await db.article.upsert({
                where,
                update: {
                    title: article.title,
                    link: article.link,
                    externalId: article.externalId,
                    content: article.content,
                    excerpt: article.excerpt,
                    author: article.author,
                    publishedAt: article.publishedAt,
                    imageUrl: article.imageUrl,
                },
                create: article,
            });
            upsertedIds.push(upserted.id);
            if (!existing) {
                createdArticleIds.push(upserted.id);
                // Cross-feed duplicate detection for newly created articles
                if (article.contentHash) {
                    const canonical = await db.article.findFirst({
                        where: {
                            userId: userId,
                            contentHash: article.contentHash,
                            id: { not: upserted.id },
                            isDuplicate: false,
                        },
                        orderBy: { createdAt: "asc" },
                        select: { id: true },
                    });
                    if (canonical) {
                        await db.article.update({
                            where: { id: upserted.id },
                            data: { isDuplicate: true, duplicateOf: canonical.id },
                        });
                    }
                }
            }
        }

        await db.feed.update({
            where: { id: feed.id },
            data: feedPatch,
        });

        // Auto full-text extraction for newly synced articles
        if (feed.autoFetchFullText && upsertedIds.length > 0) {
            await autoFetchFullTextForArticles(userId, upsertedIds, feed);
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
    const { default: DOMPurify } = await import("isomorphic-dompurify");

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
                data: { content: sanitized, excerpt: plain.slice(0, 240) },
            });
        } catch (e) {
            logger.warn(`[rss-sync] autoFetchFullText failed for ${article.link}:`, e);
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

    const feeds = await db.feed.findMany({
        where: { userId },
    });

    const results = [];
    const concurrency = 4;

    for (let i = 0; i < feeds.length; i += concurrency) {
        const batch = feeds.slice(i, i + concurrency);
        const batchResults = await Promise.all(
            batch.map(async (feed) => {
                const settings = await getEffectiveSettings(feed.userId, feed.id);
                const now = new Date();
                const lastSync = feed.lastFetchedAt || new Date(0);
                const diffMinutes = (now.getTime() - lastSync.getTime()) / (1000 * 60);

                if (diffMinutes < settings.updateFrequency) {
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
        include: { user: true },
    });

    const results = [];
    const concurrency = 4;

    for (let i = 0; i < feeds.length; i += concurrency) {
        const batch = feeds.slice(i, i + concurrency);
        const batchResults = await Promise.all(
            batch.map(async (feed) => {
                const settings = await getEffectiveSettings(feed.userId, feed.id);
                const now = new Date();
                const lastSync = feed.lastFetchedAt || new Date(0);
                const diffMinutes = (now.getTime() - lastSync.getTime()) / (1000 * 60);

                if (diffMinutes < settings.updateFrequency) {
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
