import { db } from "@/lib/db";

/**
 * Per-feed keyword content filters.
 *
 * A feed's `filtersActionRead` field is a newline-separated list of keywords.
 * When a newly-synced article matches any of them (in its title, excerpt, or
 * body), it is marked read on arrival — a lightweight per-feed "mute these
 * words" that keeps noisy items out of the unread count and notifications
 * without deleting anything.
 */

/** Split a newline-separated filter list into normalized, de-duplicated lowercase terms. */
export function parseContentFilterTerms(raw: string | null | undefined): string[] {
    if (!raw) return [];
    return Array.from(
        new Set(
            raw
                .split(/\r?\n/)
                .map((term) => term.trim().toLowerCase())
                .filter(Boolean),
        ),
    );
}

/**
 * True if the article matches any of the (already lowercased) filter terms.
 * Matches against title + excerpt + tag-stripped body so a term hidden only in
 * the article body still counts, without matching HTML tag/attribute noise.
 */
export function articleMatchesContentFilter(
    article: { title?: string | null; excerpt?: string | null; content?: string | null },
    terms: string[],
): boolean {
    if (terms.length === 0) return false;
    const body = (article.content ?? "").replace(/<[^>]+>/g, " ");
    const haystack = `${article.title ?? ""}\n${article.excerpt ?? ""}\n${body}`.toLowerCase();
    return terms.some((term) => haystack.includes(term));
}

/**
 * Apply a feed's read-filter to a batch of just-created articles: mark the
 * matching ones read and return their ids so the caller can exclude them from
 * downstream new-article processing (summaries, tags, alerts, notifications).
 */
export async function applyFeedReadFilter(
    userId: string,
    feed: { id: string; filtersActionRead?: string | null },
    createdArticleIds: string[],
): Promise<string[]> {
    const terms = parseContentFilterTerms(feed.filtersActionRead);
    if (terms.length === 0 || createdArticleIds.length === 0) return [];

    const candidates = await db.article.findMany({
        where: { id: { in: createdArticleIds }, userId, isRead: false },
        select: { id: true, title: true, excerpt: true, content: true },
    });

    const matchedIds = candidates
        .filter((article) => articleMatchesContentFilter(article, terms))
        .map((article) => article.id);

    if (matchedIds.length > 0) {
        await db.article.updateMany({
            where: { id: { in: matchedIds }, userId },
            data: { isRead: true, readAt: new Date() },
        });
    }

    return matchedIds;
}
