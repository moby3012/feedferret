import { db } from "./db";
import { getEffectiveSettings } from "./settings";
import { applyAutoReadRules } from "./auto-read-rules";
import { applyKeywordAlerts } from "./keyword-alerts";
import { queueNewArticleNotifications } from "./notifications";
import { fetchFeedArticles, type FetchedFeedArticle } from "./feed-fetcher";
import { syncDynamicOpmlCategories } from "./dynamic-opml";
import { fetchTextWithSsrfProtection, isTrustedFeedFetchingAllowed } from "./ssrf";
import { computeContentHash } from "./content-hash";
import { dispatchWebhookEvent } from "./webhooks";

async function getSanitizer() {
    const { default: DOMPurify } = await import("isomorphic-dompurify");
    return DOMPurify;
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
            await applyKeywordAlerts(userId, createdArticleIds).catch((e) =>
                console.error("[rss-sync] keyword alerts failed:", e),
            );
            await queueNewArticleNotifications(userId, createdArticleIds).catch((e) =>
                console.error("[rss-sync] push notification queue failed:", e),
            );
            // Webhook: new_article events (one per created article, non-blocking)
            const newArticles = await db.article.findMany({
                where: { id: { in: createdArticleIds }, isDuplicate: false },
                select: { id: true, title: true, link: true, excerpt: true, publishedAt: true, feed: { select: { name: true } } },
            });
            for (const a of newArticles) {
                dispatchWebhookEvent(userId, "new_article", {
                    id: a.id,
                    title: a.title,
                    link: a.link,
                    feedId: feed.id,
                    feedName: a.feed.name,
                    publishedAt: a.publishedAt.toISOString(),
                    excerpt: a.excerpt ?? "",
                }, feed.id).catch((e) => console.error("[webhooks] dispatch failed:", e));
            }
        }

        return { success: true, count: articles.length, createdArticleIds };
    } catch (error) {
        console.error(`Error syncing feed ${feed.url}:`, error);
        await db.feed.update({
            where: { id: feed.id },
            data: {
                lastFetchedAt: new Date(),
                lastStatus: "error",
                lastError: String(error).slice(0, 1000),
            },
        });
        dispatchWebhookEvent(userId, "feed_error", {
            feedId: feed.id,
            feedName: feed.name,
            feedUrl: feed.url,
            error: String(error).slice(0, 500),
        }, feed.id).catch(() => {});
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
            document.querySelectorAll(removeSelectors.join(",")).forEach((n) => n.remove());

            // Resolve relative URLs
            document.querySelectorAll("a[href], img[src]").forEach((node) => {
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
                    .flatMap((s) => Array.from(document.querySelectorAll(s)))
                    .concat(Array.from(document.body.children));
                best = candidates
                    .map((el) => ({
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
            console.warn(`[rss-sync] autoFetchFullText failed for ${article.link}:`, e);
        }
    }
}

export async function syncUserFeeds(userId: string) {
    await syncDynamicOpmlCategories(userId).catch((e) =>
        console.error("[rss-sync] dynamic OPML sync failed:", e),
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
            console.error("[rss-sync] applyAutoReadRules failed:", e),
        );
    }

    return results;
}

export async function syncAllFeeds() {
    await syncDynamicOpmlCategories().catch((e) =>
        console.error("[rss-sync] dynamic OPML sync failed:", e),
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
