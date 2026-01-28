import Parser from "rss-parser";
import DOMPurify from "isomorphic-dompurify";
import { db } from "./db";
import { getEffectiveSettings } from "./settings";

const parser = new Parser();

/**
 * Syncs a single feed for a specific user.
 */
export async function syncFeed(userId: string, feedId: string) {
    const feed = await db.feed.findUnique({
        where: { id: feedId, userId },
    });

    if (!feed) throw new Error("Feed not found");

    try {
        const remoteFeed = await parser.parseURL(feed.url);

        // Update feed info if missing
        if (!feed.name || feed.name === "New Feed") {
            await db.feed.update({
                where: { id: feedId },
                data: { name: remoteFeed.title || feed.name },
            });
        }

        const articles = remoteFeed.items.map((item) => {
            const content = item.content || item["content:encoded"] || item.summary || "";
            const excerpt = DOMPurify.sanitize(content, { ALLOWED_TAGS: [] }).substring(0, 200);

            return {
                feedId: feed.id,
                userId: userId,
                title: item.title || "Untitled",
                link: item.link || "",
                content: DOMPurify.sanitize(content),
                excerpt: excerpt,
                author: item.creator || item.author || null,
                publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
                imageUrl: extractImageUrl(item),
            };
        });

        // Batch upsert articles
        for (const article of articles) {
            if (!article.link) continue;

            await db.article.upsert({
                where: {
                    userId_link: {
                        userId: userId,
                        link: article.link,
                    },
                },
                update: {
                    title: article.title,
                    content: article.content,
                    excerpt: article.excerpt,
                },
                create: article,
            });
        }

        // Update last fetched timestamp
        await db.feed.update({
            where: { id: feed.id },
            data: { lastFetchedAt: new Date() },
        });

        return { success: true, count: articles.length };
    } catch (error) {
        console.error(`Error syncing feed ${feed.url}:`, error);
        return { success: false, error: String(error) };
    }
}

/**
 * Triggers a sync for all feeds that need updating based on their frequency.
 */
export async function syncAllFeeds() {
    const feeds = await db.feed.findMany({
        include: { user: true },
    });

    const results = [];
    for (const feed of feeds) {
        const settings = await getEffectiveSettings(feed.userId, feed.id);
        const now = new Date();
        const lastSync = feed.lastFetchedAt || new Date(0);

        const diffMinutes = (now.getTime() - lastSync.getTime()) / (1000 * 60);

        if (diffMinutes >= settings.updateFrequency) {
            const res = await syncFeed(feed.userId, feed.id);
            results.push({ feed: feed.url, ...res });
        }
    }

    return results;
}

function extractImageUrl(item: any): string | null {
    // Try enclosure
    if (item.enclosure && item.enclosure.url && item.enclosure.type?.startsWith("image/")) {
        return item.enclosure.url;
    }

    // Try media:content
    if (item["media:content"] && item["media:content"].$) {
        return item["media:content"].$.url;
    }

    // Try parsing from content/summary (basic regex)
    const content = item.content || item["content:encoded"] || "";
    const imgMatch = content.match(/<img[^>]+src="([^">]+)"/);
    if (imgMatch) return imgMatch[1];

    return null;
}
