import { db } from "@/lib/db";
import { syncFeed } from "@/lib/rss-sync";
import { fetchAndSuggestFeedCandidates, type SuggestedFieldConfig } from "@/lib/page-feed-suggest";

/**
 * Page→feed creation shared by the Server Action (`createFeedFromPage`) and the
 * REST/MCP surface. A page-feed is an `HTML+XPath` scraper feed built from a set
 * of XPath field selectors that turn a repeating list on an arbitrary web page
 * into feed items.
 */

/** Serialize a suggested XPath field config into the feed's `scraperConfig` JSON. */
export function buildPageFeedScraperConfig(config: SuggestedFieldConfig): string {
    const xpath: Record<string, string> = {};
    for (const [key, value] of Object.entries(config)) {
        if (typeof value === "string" && value.trim()) xpath[key] = value;
    }
    return JSON.stringify({ xpath });
}

/**
 * Fetch a page and return the highest-scoring feed-candidate config the
 * heuristic finds, or null when nothing on the page looks like a repeating
 * item list. Used to let callers create a page-feed from just a URL.
 */
export async function suggestTopPageFeedConfig(url: string): Promise<SuggestedFieldConfig | null> {
    const candidates = await fetchAndSuggestFeedCandidates(url);
    return candidates.length ? candidates[0].config : null;
}

/**
 * Create an HTML+XPath page-feed for a user from a resolved field config, and
 * sync it once (unless `sync` is false). User-scoped and session-agnostic: the
 * caller supplies the already-authenticated `userId`.
 */
export async function createPageFeedForUser(
    userId: string,
    input: { url: string; config: SuggestedFieldConfig; name?: string; categoryId?: string; sync?: boolean },
) {
    if (!input.config?.xPathItem || !input.config.xPathItem.trim()) {
        throw new Error("A repeating item selector (xPathItem) is required");
    }

    let name = input.name?.trim();
    if (!name) {
        try {
            name = new URL(input.url).hostname.replace(/^www\./, "");
        } catch {
            name = "New Feed";
        }
    }

    const order = await db.feed.count({ where: { userId } });
    const feed = await db.feed.create({
        data: {
            userId,
            url: input.url,
            name,
            categoryId: input.categoryId,
            sourceType: "HTML+XPath",
            scraperConfig: buildPageFeedScraperConfig(input.config),
            order,
            lastStatus: "pending",
        },
    });

    if (input.sync !== false) await syncFeed(userId, feed.id).catch(() => null);

    return db.feed.findFirst({
        where: { id: feed.id, userId },
        include: { category: true, _count: { select: { articles: { where: { isRead: false } } } } },
    });
}
