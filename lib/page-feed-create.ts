import { db } from "@/lib/db";
import { syncFeed } from "@/lib/rss-sync";
import { fetchAndSuggestFeedCandidatesDetailed, type CandidateQuality, type SuggestedFieldConfig, type SuggestionResult } from "@/lib/page-feed-suggest";

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
 * Fetch a page and return the highest-scoring gated candidate config, or null
 * plus why nothing was picked (the preview quality gate may have dropped
 * every list as navigation/login/maps…). Lets callers create a page-feed from
 * just a URL.
 */
export async function suggestTopPageFeed(url: string): Promise<{
    config: SuggestedFieldConfig | null;
    quality: CandidateQuality | null;
    rejected: SuggestionResult["rejected"];
}> {
    const { candidates, rejected } = await fetchAndSuggestFeedCandidatesDetailed(url);
    const top = candidates[0];
    return { config: top?.config ?? null, quality: top?.quality ?? null, rejected };
}

/** Human-readable API error when no candidate survived (REST/MCP). */
export function noPageFeedCandidateMessage(rejected: SuggestionResult["rejected"]): string {
    const base = "No feed-like repeating items found on that page; provide an explicit config with xPathItem";
    if (!rejected.count) return base;
    const reasons = Object.entries(rejected.reasons).map(([reason, n]) => `${reason}: ${n}`).join(", ");
    return `${base}. ${rejected.count} candidate list(s) were rejected by the preview quality gate (${reasons}).`;
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
