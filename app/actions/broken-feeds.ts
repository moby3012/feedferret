"use server";

// "Defekte Feeds": triage overview for muted / failing feeds. Every action
// authenticates, scopes by the session user (ownership on every feed id),
// reads only allowlisted columns and fetches exclusively through the SSRF-safe
// paths (syncFeed / fetchFeedArticles / feed discovery).

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { syncFeed } from "@/lib/rss-sync";
import { fetchFeedArticles } from "@/lib/feed-fetcher";
import { discoverFeeds, type DiscoveryHint } from "@/lib/feed-discovery";
import { validateFeedUrl } from "@/lib/validation";
import { connectorFeedUrlError, redactFeedsForClient, stripConnectorSecrets } from "@/lib/connector-secrets";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { redact } from "@/lib/redact";
import { credentialResetForUrlChange, originOfUrl } from "@/lib/feed-secrets";
import { readPlainColumn } from "@/lib/secret-box";
import { logger } from "@/lib/logger";
import { applyManualUnmute } from "@/lib/feed-auto-mute";
import { NEWSLETTER_SOURCE_TYPE } from "@/lib/newsletter-constants";
import {
    brokenKindOf,
    categorizeFeedError,
    compareBrokenFeeds,
    daysSince,
    failingSinceOf,
    feedHost,
    isBrokenFeed,
    isInactiveFeed,
    isStaleBroken,
    lastItemAtOf,
    normalizeInactiveDays,
    STALE_BROKEN_FEED_DAYS,
    type BrokenFeedCategory,
    type BrokenFeedKind,
} from "@/lib/broken-feeds";
import { loadArchivedFeeds } from "@/server/bootstrap";

export type BrokenFeedDto = {
    id: string;
    name: string;
    icon: string | null;
    host: string;
    category: BrokenFeedCategory;
    /** gone (404/410) | blocked (403/429, bot protection) | error (everything else). */
    kind: BrokenFeedKind;
    /** Redacted, truncated `lastError` (diagnostic detail under the plain-language category). */
    detail: string;
    autoMuted: boolean;
    consecutiveFailureCount: number;
    failingSince: string | null;
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    /** The failure streak is older than STALE_BROKEN_FEED_DAYS (eligible for the bulk removal). */
    stale: boolean;
    /** "Reparieren" (feed discovery) only makes sense for plain RSS-style feeds. */
    canRepair: boolean;
};

const BROKEN_SELECT = {
    id: true,
    name: true,
    icon: true,
    url: true,
    sourceType: true,
    lastError: true,
    lastStatus: true,
    autoMuted: true,
    consecutiveFailureCount: true,
    failingSince: true,
    lastSuccessAt: true,
    lastFetchedAt: true,
} as const;

const REPAIRABLE_SOURCE_TYPES = new Set(["rss", "JSONFeed"]);
const MAX_BULK_IDS = 500;
const MAX_REPAIR_CANDIDATES = 8;
const STATS_CHUNK = 5000;

type BrokenRow = {
    id: string;
    name: string;
    icon: string | null;
    url: string;
    sourceType: string;
    lastError: string | null;
    autoMuted: boolean;
    consecutiveFailureCount: number;
    failingSince: Date | null;
    lastSuccessAt: Date | null;
    lastFetchedAt: Date | null;
};

async function requireUserId(): Promise<string> {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    return session.user.id;
}

function validId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 128;
}

async function ownedFeed(userId: string, feedId: string) {
    if (!validId(feedId)) throw new Error("Feed not found");
    const feed = await db.feed.findFirst({ where: { id: feedId, userId }, select: BROKEN_SELECT });
    if (!feed || feed.sourceType === NEWSLETTER_SOURCE_TYPE) throw new Error("Feed not found");
    return feed as BrokenRow;
}

async function toDtos(rows: BrokenRow[], userId: string, now = new Date()): Promise<BrokenFeedDto[]> {
    if (rows.length === 0) return [];
    // `lastSuccessAt` only exists for syncs after the column was added; older rows
    // fall back to the newest article we ingested for the feed.
    const needFallback = rows.filter((r) => !r.lastSuccessAt).map((r) => r.id);
    const newest = needFallback.length
        ? await db.article.groupBy({
            by: ["feedId"],
            where: { userId, feedId: { in: needFallback } },
            _max: { createdAt: true },
        })
        : [];
    const newestByFeed = new Map<string, Date | null>(
        newest.map((n: { feedId: string; _max: { createdAt: Date | null } }) => [n.feedId, n._max.createdAt]),
    );
    // Connector secrets (RSSHub key …) must never reach the client, not even inside `lastError`.
    const redacted = await redactFeedsForClient(rows);
    return redacted
        .map((row, i): BrokenFeedDto => {
            const source = rows[i];
            const since = failingSinceOf(source);
            const lastSuccess = source.lastSuccessAt ?? newestByFeed.get(source.id) ?? null;
            const category = categorizeFeedError(row.lastError, row.url);
            return {
                id: row.id,
                name: row.name,
                icon: row.icon,
                host: feedHost(row.url),
                category,
                kind: brokenKindOf(category, row.lastError),
                detail: redact(row.lastError ?? "").slice(0, 300),
                autoMuted: row.autoMuted,
                consecutiveFailureCount: row.consecutiveFailureCount,
                failingSince: since ? since.toISOString() : null,
                lastSuccessAt: lastSuccess ? lastSuccess.toISOString() : null,
                lastAttemptAt: row.lastFetchedAt ? row.lastFetchedAt.toISOString() : null,
                stale: isStaleBroken(source, now),
                canRepair: REPAIRABLE_SOURCE_TYPES.has(row.sourceType),
            };
        })
        .sort(compareBrokenFeeds);
}

async function loadOne(userId: string, feedId: string): Promise<BrokenFeedDto | null> {
    const row = await db.feed.findFirst({ where: { id: feedId, userId }, select: BROKEN_SELECT });
    if (!row || !isBrokenFeed(row)) return null;
    return (await toDtos([row as BrokenRow], userId))[0] ?? null;
}

/** Every active (non-archived, non-newsletter) feed of the user that is auto-muted or has failed syncs. */
export async function getBrokenFeeds(): Promise<BrokenFeedDto[]> {
    const userId = await requireUserId();
    const rows = await db.feed.findMany({
        where: {
            userId,
            archivedAt: null,
            sourceType: { not: NEWSLETTER_SOURCE_TYPE },
            OR: [{ autoMuted: true }, { consecutiveFailureCount: { gt: 0 } }, { lastStatus: "attention", lastError: "HTTP 403: feed_blocked" }],
        },
        select: BROKEN_SELECT,
        orderBy: [{ autoMuted: "desc" }, { consecutiveFailureCount: "desc" }, { name: "asc" }],
    });
    return toDtos(rows as BrokenRow[], userId);
}

export type RetestResult =
    | { status: "recovered"; feed: null }
    | { status: "still-broken"; feed: BrokenFeedDto | null; error: string }
    | { status: "rate-limited"; retryAfterSecs: number };

/**
 * "Erneut testen": a real fetch of this one feed through the normal sync path.
 * On success the sync resets the failure counter and lifts the mute; on failure
 * the counters keep growing like for any other failed sync.
 */
export async function retestBrokenFeed(feedId: string): Promise<RetestResult> {
    const userId = await requireUserId();
    await ownedFeed(userId, feedId);
    const limit = checkRateLimit(`user:${userId}`, RATE_LIMITS.feedRetest);
    if (!limit.success) return { status: "rate-limited", retryAfterSecs: limit.retryAfterSecs ?? 60 };

    const result = await syncFeed(userId, feedId);
    revalidatePath("/");
    const feed = await loadOne(userId, feedId);
    if (result.success && !feed) return { status: "recovered", feed: null };
    return {
        status: "still-broken",
        feed,
        error: redact(String((result as { error?: unknown }).error ?? feed?.detail ?? "")).slice(0, 300),
    };
}

/** "Stummschaltung aufheben": a manual unmute gives the feed a clean slate (one more chance). */
export async function unmuteBrokenFeed(feedId: string): Promise<{ success: true }> {
    const userId = await requireUserId();
    await ownedFeed(userId, feedId);
    await db.feed.update({
        where: { id: feedId, userId },
        data: { ...applyManualUnmute(), failingSince: null, nextSyncAt: null, lastStatus: null, lastError: null },
    });
    revalidatePath("/");
    return { success: true };
}

export type RepairCandidate = { url: string; title: string; type: string };
export type RepairProposal =
    | { status: "ok"; site: string; candidates: RepairCandidate[]; hint?: DiscoveryHint }
    | { status: "rate-limited"; retryAfterSecs: number }
    | { status: "unsupported" };

/** "Reparieren": propose replacement feed URLs for the feed's site via the add-feed discovery. */
export async function proposeFeedRepair(feedId: string): Promise<RepairProposal> {
    const userId = await requireUserId();
    const feed = await ownedFeed(userId, feedId);
    if (!REPAIRABLE_SOURCE_TYPES.has(feed.sourceType)) return { status: "unsupported" };
    const limit = checkRateLimit(`user:${userId}`, RATE_LIMITS.urlDiscover);
    if (!limit.success) return { status: "rate-limited", retryAfterSecs: limit.retryAfterSecs ?? 60 };

    // The site's home page is the most stable place to look for the moved feed.
    const stored = await db.feed.findFirst({ where: { id: feedId, userId }, select: { url: true, htmlUrl: true } });
    let site = "";
    for (const candidate of [stored?.htmlUrl, stored?.url]) {
        if (!candidate) continue;
        try {
            const u = new URL(candidate);
            if (u.protocol === "http:" || u.protocol === "https:") {
                site = candidate === stored?.url ? u.origin : candidate;
                break;
            }
        } catch {
            /* try the next one */
        }
    }
    if (!site) return { status: "ok", site: "", candidates: [] };

    const discovery = await discoverFeeds(site);
    const taken = new Set(
        (await db.feed.findMany({ where: { userId }, select: { url: true } })).map((f: { url: string }) => f.url),
    );
    const candidates = discovery.feeds
        .filter((f) => !taken.has(f.url) && validateFeedUrl(f.url) === null)
        .slice(0, MAX_REPAIR_CANDIDATES)
        .map((f) => ({ url: f.url, title: f.title, type: f.type }));
    return { status: "ok", site: feedHost(site), candidates, ...(discovery.hint ? { hint: discovery.hint } : {}) };
}

export type RepairResult =
    | { success: true; recovered: boolean; feed: BrokenFeedDto | null }
    | { success: false; error: "invalid-url" | "duplicate" | "not-a-feed" | "unsupported" | "rate-limited" };

/** Accepts a proposed URL: verifies it parses as a feed, swaps it in, resets the failure state and syncs once. */
export async function applyFeedRepair(feedId: string, newUrl: string): Promise<RepairResult> {
    const userId = await requireUserId();
    const feed = await ownedFeed(userId, feedId);
    if (!REPAIRABLE_SOURCE_TYPES.has(feed.sourceType)) return { success: false, error: "unsupported" };
    if (typeof newUrl !== "string" || newUrl.length > 2000) return { success: false, error: "invalid-url" };
    if (validateFeedUrl(newUrl)) return { success: false, error: "invalid-url" };
    if (await connectorFeedUrlError(newUrl)) return { success: false, error: "invalid-url" };
    const limit = checkRateLimit(`user:${userId}`, RATE_LIMITS.feedRetest);
    if (!limit.success) return { success: false, error: "rate-limited" };

    const url = await stripConnectorSecrets(newUrl);
    const clash = await db.feed.findFirst({ where: { userId, url, NOT: { id: feedId } }, select: { id: true } });
    if (clash) return { success: false, error: "duplicate" };
    // Credentials belong to one origin: the verification fetch uses the feed's own config only when the
    // origin stays the same; for another host it is a bare, unauthenticated GET.
    const stored = await db.feed.findFirst({ where: { id: feedId, userId } });
    if (!stored) return { success: false, error: "unsupported" };
    const sameOrigin = originOfUrl(stored.url) !== null && originOfUrl(stored.url) === originOfUrl(url);
    try {
        await fetchFeedArticles(sameOrigin ? { ...stored, url, etag: null, lastModifiedHeader: null } : { url });
    } catch (error) {
        logger.warn("Feed repair candidate is not a readable feed:", error);
        return { success: false, error: "not-a-feed" };
    }
    try {
        await db.feed.update({
            where: { id: feedId, userId },
            data: {
                url,
                etag: null,
                lastModifiedHeader: null,
                // A different origin never inherits the old site's Basic auth, cookies or custom headers.
                ...credentialResetForUrlChange(stored.url, url, readPlainColumn("feed.httpOptions", stored.httpOptions)),
                ...applyManualUnmute(),
                failingSince: null,
                lastError: null,
                lastStatus: "pending",
            },
        });
    } catch (error) {
        if ((error as { code?: string })?.code === "P2002") return { success: false, error: "duplicate" };
        throw error;
    }
    await syncFeed(userId, feedId);
    revalidatePath("/");
    const after = await loadOne(userId, feedId);
    return { success: true, recovered: !after, feed: after };
}

/**
 * "Alle entfernen, die seit > 30 Tagen fehlschlagen". The client sends the ids it showed in the confirmation, but
 * eligibility is part of the ONE atomic delete predicate (no read-then-delete): a feed that recovered, was unmuted
 * or was repaired in the meantime no longer matches and survives. Mirrors `isStaleBroken` (lib/broken-feeds.ts).
 */
export async function removeStaleBrokenFeeds(feedIds: string[]): Promise<{ removed: number; skipped: number }> {
    const userId = await requireUserId();
    if (!Array.isArray(feedIds)) throw new Error("Invalid input");
    const ids = [...new Set(feedIds.filter(validId))].slice(0, MAX_BULK_IDS);
    if (ids.length === 0) return { removed: 0, skipped: 0 };
    const cutoff = new Date(Date.now() - STALE_BROKEN_FEED_DAYS * 86_400_000);
    const { count } = await db.feed.deleteMany({
        where: {
            id: { in: ids },
            userId,
            sourceType: { not: NEWSLETTER_SOURCE_TYPE },
            OR: [
                // Known streak start: still muted / failing, and started more than N days ago.
                { failingSince: { lt: cutoff }, OR: [{ autoMuted: true }, { consecutiveFailureCount: { gt: 0 } }] },
                // Rows from before the column: their last attempt stands in (understates the streak).
                { failingSince: null, consecutiveFailureCount: { gt: 0 }, lastFetchedAt: { lt: cutoff } },
            ],
        },
    });
    revalidatePath("/");
    return { removed: count, skipped: ids.length - count };
}

// --- Inactive feeds (fetch fine, nothing new for a long time) and the archive ---------------------

export type InactiveFeedDto = {
    id: string;
    name: string;
    icon: string | null;
    host: string;
    /** Newest item date; null when the feed never delivered an item (then `inactiveDays` counts from creation). */
    lastItemAt: string | null;
    inactiveDays: number;
    articleCount: number;
    lastSuccessAt: string | null;
};

export type InactiveFeedsResult = { thresholdDays: number; feeds: InactiveFeedDto[] };

/** Rows that can possibly be inactive; the date test itself happens against the newest article below. */
const INACTIVE_CANDIDATE = {
    OR: [{ lastStatus: null }, { lastStatus: { not: "attention" } }, { lastError: null }, { lastError: { not: "HTTP 403: feed_blocked" } }],
    archivedAt: null,
    autoMuted: false,
    consecutiveFailureCount: 0,
    lastFetchedAt: { not: null },
    sourceType: { not: NEWSLETTER_SOURCE_TYPE },
};

async function inactiveThreshold(userId: string): Promise<number> {
    const user = await db.user.findUnique({ where: { id: userId }, select: { inactiveFeedDays: true } });
    return normalizeInactiveDays(user?.inactiveFeedDays);
}

/**
 * Feeds that work (no failure streak) but whose newest item is older than the user's threshold
 * (`User.inactiveFeedDays`, default 180 days). Oldest silence first. Archived feeds are excluded.
 */
export async function getInactiveFeeds(): Promise<InactiveFeedsResult> {
    const userId = await requireUserId();
    const thresholdDays = await inactiveThreshold(userId);
    const now = new Date();
    const rows = await db.feed.findMany({
        where: { userId, ...INACTIVE_CANDIDATE },
        select: { id: true, name: true, icon: true, url: true, sourceType: true, autoMuted: true, consecutiveFailureCount: true, lastFetchedAt: true, lastSuccessAt: true, createdAt: true, archivedAt: true },
    });
    if (rows.length === 0) return { thresholdDays, feeds: [] };
    // Only the candidates: `(feedId, publishedAt)`-indexed lookups instead of grouping every article of the user.
    // Chunked so a huge subscription list never exceeds the bind-parameter limit.
    const statsByFeed = new Map<string, { newest: Date | null; count: number }>();
    for (let i = 0; i < rows.length; i += STATS_CHUNK) {
        const stats = await db.article.groupBy({
            by: ["feedId"],
            where: { userId, feedId: { in: rows.slice(i, i + STATS_CHUNK).map((r) => r.id) } },
            _max: { publishedAt: true },
            _count: { _all: true },
        });
        for (const s of stats as Array<{ feedId: string; _max: { publishedAt: Date | null }; _count: { _all: number } }>) {
            statsByFeed.set(s.feedId, { newest: s._max.publishedAt, count: s._count._all });
        }
    }
    const feeds: InactiveFeedDto[] = [];
    for (const row of rows) {
        const stat = statsByFeed.get(row.id);
        if (!isInactiveFeed(row, stat?.newest, now, thresholdDays)) continue;
        feeds.push({
            id: row.id,
            name: row.name,
            icon: row.icon,
            host: feedHost(row.url),
            lastItemAt: stat?.newest ? stat.newest.toISOString() : null,
            inactiveDays: daysSince(lastItemAtOf(stat?.newest, row), now),
            articleCount: stat?.count ?? 0,
            lastSuccessAt: row.lastSuccessAt ? row.lastSuccessAt.toISOString() : null,
        });
    }
    feeds.sort((a, b) => b.inactiveDays - a.inactiveDays || a.name.localeCompare(b.name));
    return { thresholdDays, feeds };
}

function cleanIds(feedIds: unknown): string[] {
    if (!Array.isArray(feedIds)) throw new Error("Invalid input");
    return [...new Set(feedIds.filter(validId))].slice(0, MAX_BULK_IDS);
}

/**
 * "Archivieren": the feed stops syncing, disappears from the sidebar, the unread counts, "All articles"
 * and the GReader / Fever subscription lists, and keeps all of its articles. Only the Feed row is
 * written, so no Article.updatedAt is touched. Restoring is `restoreFeeds`.
 */
export async function archiveFeeds(feedIds: string[]): Promise<{ archived: number; archivedIds: string[] }> {
    const userId = await requireUserId();
    const ids = cleanIds(feedIds);
    if (ids.length === 0) return { archived: 0, archivedIds: [] };
    const archivedIds = await archiveWhere(userId, { id: { in: ids } });
    revalidatePath("/");
    return { archived: archivedIds.length, archivedIds };
}

/**
 * Archives the feeds matching `guard` (always: own, not yet archived) and returns exactly the ids this call
 * archived, so an Undo restores nothing else. Candidates are selected with the guard, then updated by id inside
 * a transaction; the guard stays on the UPDATE so a feed that stops matching in between is left alone, and the
 * ids are read back by this call's unique timestamp.
 */
async function archiveWhere(userId: string, guard: Record<string, unknown>): Promise<string[]> {
    return db.$transaction(async (tx) => {
        const where = { ...guard, userId, archivedAt: null };
        const candidates = (await tx.feed.findMany({ where, select: { id: true } })).map((f: { id: string }) => f.id);
        if (candidates.length === 0) return [];
        const stamp = new Date();
        await tx.feed.updateMany({ where: { ...where, id: { in: candidates } }, data: { archivedAt: stamp } });
        const done = await tx.feed.findMany({ where: { userId, id: { in: candidates }, archivedAt: stamp }, select: { id: true } });
        return done.map((f: { id: string }) => f.id);
    });
}

/**
 * "Alle inaktiven archivieren". The client sends the ids it showed, but eligibility is part of the ONE atomic
 * update predicate (same idea as `removeStaleBrokenFeeds`): a feed that published again, failed or was
 * archived in the meantime no longer matches and is left alone. Mirrors `isInactiveFeed`.
 */
export async function archiveInactiveFeeds(feedIds: string[]): Promise<{ archived: number; skipped: number; archivedIds: string[] }> {
    const userId = await requireUserId();
    const ids = cleanIds(feedIds);
    if (ids.length === 0) return { archived: 0, skipped: 0, archivedIds: [] };
    const cutoff = new Date(Date.now() - (await inactiveThreshold(userId)) * 86_400_000);
    const archivedIds = await archiveWhere(userId, {
            id: { in: ids },
            ...INACTIVE_CANDIDATE,
            // No item newer than the cutoff, and either some (older) item exists or the feed itself is older than
            // the cutoff (an empty feed is silent since its creation).
            articles: { none: { publishedAt: { gte: cutoff } } },
            OR: [{ createdAt: { lt: cutoff } }, { articles: { some: {} } }],
    });
    revalidatePath("/");
    return { archived: archivedIds.length, skipped: ids.length - archivedIds.length, archivedIds };
}

/** Un-archives feeds; they are picked up by the next background sync (their sync schedule was only paused). */
export async function restoreFeeds(feedIds: string[]): Promise<{ restored: number }> {
    const userId = await requireUserId();
    const ids = cleanIds(feedIds);
    if (ids.length === 0) return { restored: 0 };
    const { count } = await db.feed.updateMany({
        where: { id: { in: ids }, userId, archivedAt: { not: null } },
        data: { archivedAt: null, nextSyncAt: null },
    });
    revalidatePath("/");
    return { restored: count };
}

/** Manage Feeds → filter "Archiviert". */
export async function getArchivedFeeds() {
    const userId = await requireUserId();
    return loadArchivedFeeds(userId);
}
