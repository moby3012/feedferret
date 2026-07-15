import { db } from "./db";
import { logger } from "./logger";

export interface RetentionResult {
    deleted: number;
    dryRun: boolean;
}

/**
 * Applies a single user's retention policy across all of their feeds.
 *
 * Per-feed `retentionDays` (falling back to `User.defaultRetentionDays`) and the
 * `keepMinArticles` floor are resolved once in memory, then deletion candidates for
 * every feed are loaded with a single `findMany`, per-feed totals (needed only for
 * `keepMinArticles`) are loaded with a single `groupBy`, and the final set of ids is
 * removed with one `deleteMany` — replacing the previous per-feed
 * `findMany` + `count` + `deleteMany` loop (an N+1 across a user's feeds).
 *
 * Deletion candidates are restricted to articles that are read, not starred, not
 * saved for "Read Later", and have no labels — the same protections the previous
 * per-feed implementation enforced.
 */
export async function applyRetentionPoliciesForUser(userId: string, dryRun = false): Promise<RetentionResult> {
    const user = await db.user.findUnique({
        where: { id: userId },
        select: {
            defaultRetentionDays: true,
            feeds: {
                select: { id: true, retentionDays: true, keepMinArticles: true },
            },
        },
    });
    if (!user) throw new Error("User not found");

    // Resolve the effective retention window per feed; feeds with no active
    // retention window are skipped entirely (mirrors the original `continue`).
    const feedCutoffs = new Map<string, Date>();
    const feedKeepMin = new Map<string, number>();
    let maxCutoff: Date | null = null;

    for (const feed of user.feeds) {
        const retentionDays = feed.retentionDays ?? user.defaultRetentionDays;
        if (!retentionDays || retentionDays <= 0) continue;

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - retentionDays);
        feedCutoffs.set(feed.id, cutoff);
        if (!maxCutoff || cutoff > maxCutoff) maxCutoff = cutoff;

        if (feed.keepMinArticles && feed.keepMinArticles > 0) {
            feedKeepMin.set(feed.id, feed.keepMinArticles);
        }
    }

    if (feedCutoffs.size === 0 || !maxCutoff) return { deleted: 0, dryRun };

    const feedIdsWithRetention = Array.from(feedCutoffs.keys());

    // One query for every deletion candidate across all of this user's feeds. `maxCutoff`
    // (the loosest/latest cutoff among the feeds) is used as an upper bound here; each
    // feed's own (possibly stricter) cutoff is re-applied per-article below.
    const candidates = await db.article.findMany({
        where: {
            userId,
            feedId: { in: feedIdsWithRetention },
            isRead: true,
            isStarred: false,
            isReadLater: false,
            labels: { none: {} },
            publishedAt: { lt: maxCutoff },
        },
        select: { id: true, feedId: true, publishedAt: true },
        orderBy: { publishedAt: "asc" },
    });

    const candidatesByFeed = new Map<string, { id: string; publishedAt: Date }[]>();
    for (const article of candidates) {
        const cutoff = feedCutoffs.get(article.feedId);
        if (!cutoff || article.publishedAt >= cutoff) continue;
        const list = candidatesByFeed.get(article.feedId);
        if (list) {
            list.push(article);
        } else {
            candidatesByFeed.set(article.feedId, [article]);
        }
    }

    // Total per-feed article counts, needed only for feeds with a `keepMinArticles` floor.
    let totalCountByFeed = new Map<string, number>();
    const feedIdsWithKeepMin = Array.from(feedKeepMin.keys());
    if (feedIdsWithKeepMin.length > 0) {
        const totals = await db.article.groupBy({
            by: ["feedId"],
            where: { userId, feedId: { in: feedIdsWithKeepMin } },
            _count: { _all: true },
        });
        totalCountByFeed = new Map(totals.map((t: { feedId: string; _count: { _all: number } }) => [t.feedId, t._count._all]));
    }

    const idsToDelete: string[] = [];
    for (const [feedId, feedCandidates] of candidatesByFeed) {
        let toDelete = feedCandidates;
        const keepMin = feedKeepMin.get(feedId);
        if (keepMin) {
            const totalCount = totalCountByFeed.get(feedId) ?? feedCandidates.length;
            const maxDeletable = Math.max(0, totalCount - keepMin);
            toDelete = feedCandidates.slice(0, maxDeletable);
        }
        for (const article of toDelete) idsToDelete.push(article.id);
    }

    if (idsToDelete.length === 0) return { deleted: 0, dryRun };

    if (dryRun) {
        return { deleted: idsToDelete.length, dryRun: true };
    }

    const result = await db.article.deleteMany({ where: { id: { in: idsToDelete } } });
    return { deleted: result.count, dryRun: false };
}

/**
 * Runs retention for every user, with bounded concurrency so a large instance doesn't
 * fire hundreds of concurrent queries at once. Intended to be called on a daily cadence
 * from the background scheduler (see `lib/background-sync.ts`). Errors for one user are
 * logged and isolated so they don't abort the sweep for everyone else.
 */
export async function applyRetentionPoliciesForAllUsers(): Promise<{ usersProcessed: number; deleted: number }> {
    const users = await db.user.findMany({ select: { id: true } });

    let deleted = 0;
    const concurrency = 4;

    for (let i = 0; i < users.length; i += concurrency) {
        const batch = users.slice(i, i + concurrency);
        const results = await Promise.all(
            batch.map((u: { id: string }) =>
                applyRetentionPoliciesForUser(u.id, false).catch((e) => {
                    logger.error(`[retention] failed for user ${u.id}:`, e);
                    return { deleted: 0, dryRun: false } satisfies RetentionResult;
                }),
            ),
        );
        deleted += results.reduce((sum, r) => sum + r.deleted, 0);
    }

    return { usersProcessed: users.length, deleted };
}
