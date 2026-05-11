import { db } from "./db";
import { getEffectiveSettings } from "./settings";
import { applyAutoReadRules } from "./auto-read-rules";
import https from "https";

async function getSanitizer() {
    const { default: DOMPurify } = await import("isomorphic-dompurify");
    return DOMPurify;
}

import Parser from "rss-parser";

function buildFeedParser(feed: {
    authType?: string | null;
    authUsername?: string | null;
    authPassword?: string | null;
    customUserAgent?: string | null;
    fetchTimeoutSecs?: number | null;
    sslVerify?: boolean;
    maxSizeKb?: number | null;
}) {
    const headers: Record<string, string> = {};

    if (feed.authType === "basic" && feed.authUsername) {
        const creds = `${feed.authUsername}:${feed.authPassword ?? ""}`;
        headers["Authorization"] = `Basic ${Buffer.from(creds).toString("base64")}`;
    }
    headers["User-Agent"] =
        feed.customUserAgent || "FeedFerret/1.0 (+https://github.com/moby3012/feedferret)";

    const requestOptions: Record<string, unknown> = {
        rejectUnauthorized: feed.sslVerify !== false,
    };

    const timeoutMs = (feed.fetchTimeoutSecs ?? 30) * 1000;

    return new Parser({ headers, requestOptions, timeout: timeoutMs });
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
        const feedParser = buildFeedParser(feed);
        const remoteFeed = await feedParser.parseURL(feed.url);

        const feedPatch: any = {
            lastFetchedAt: new Date(),
            lastStatus: "ok",
            lastError: null,
        };

        if (!feed.name || feed.name === "New Feed") {
            feedPatch.name = remoteFeed.title || feed.name;
        }

        const DOMPurify = await getSanitizer();

        const maxChars = feed.maxSizeKb ? feed.maxSizeKb * 1024 : undefined;

        const articles = remoteFeed.items.map((item) => {
            let content = item.content || item["content:encoded"] || item.summary || "";
            if (maxChars && content.length > maxChars) {
                content = content.slice(0, maxChars);
            }
            const excerpt = DOMPurify.sanitize(content, { ALLOWED_TAGS: [] }).substring(0, 200);

            const externalId = item.guid || item.id || item.link || null;
            const dedupeKey = externalId || item.link;

            return {
                feedId: feed.id,
                userId: userId,
                title: item.title || "Untitled",
                link: item.link || "",
                externalId,
                dedupeKey,
                content: DOMPurify.sanitize(content),
                excerpt: excerpt,
                author: item.creator || item.author || null,
                publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
                imageUrl: extractImageUrl(item),
            };
        });

        const upsertedIds: string[] = [];

        for (const article of articles) {
            if (!article.link) continue;

            const upserted = await db.article.upsert({
                where: {
                    userId_feedId_dedupeKey: {
                        userId: userId,
                        feedId: feed.id,
                        dedupeKey: article.dedupeKey,
                    },
                },
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
        }

        await db.feed.update({
            where: { id: feed.id },
            data: feedPatch,
        });

        // Auto full-text extraction for newly synced articles
        if (feed.autoFetchFullText && upsertedIds.length > 0) {
            await autoFetchFullTextForArticles(userId, upsertedIds, feed);
        }

        return { success: true, count: articles.length };
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
            const response = await fetch(article.link, {
                headers: { "User-Agent": "FeedFerret/1.0", Accept: "text/html" },
                signal: AbortSignal.timeout(12_000),
            });
            if (!response.ok) continue;

            const html = await response.text();
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

function extractImageUrl(item: any): string | null {
    if (item.enclosure && item.enclosure.url && item.enclosure.type?.startsWith("image/")) {
        return item.enclosure.url;
    }
    if (item["media:content"] && item["media:content"].$) {
        return item["media:content"].$.url;
    }
    const content = item.content || item["content:encoded"] || "";
    const imgMatch = content.match(/<img[^>]+src="([^">]+)"/);
    if (imgMatch) return imgMatch[1];
    return null;
}
