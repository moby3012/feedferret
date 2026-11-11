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
import { discoverFeeds } from "@/lib/feed-discovery";
import { validateFeedUrl } from "@/lib/validation";
import { connectorFeedUrlError, redactFeedsForClient, stripConnectorSecrets } from "@/lib/connector-secrets";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { redact } from "@/lib/redact";
import { logger } from "@/lib/logger";
import { applyManualUnmute } from "@/lib/feed-auto-mute";
import { NEWSLETTER_SOURCE_TYPE } from "@/lib/newsletter-constants";
import {
    categorizeFeedError,
    compareBrokenFeeds,
    failingSinceOf,
    feedHost,
    isBrokenFeed,
    isStaleBroken,
    STALE_BROKEN_FEED_DAYS,
    type BrokenFeedCategory,
} from "@/lib/broken-feeds";

export type BrokenFeedDto = {
    id: string;
    name: string;
    icon: string | null;
    host: string;
    category: BrokenFeedCategory;
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
    autoMuted: true,
    consecutiveFailureCount: true,
    failingSince: true,
    lastSuccessAt: true,
    lastFetchedAt: true,
} as const;

const REPAIRABLE_SOURCE_TYPES = new Set(["rss", "JSONFeed"]);
const MAX_BULK_IDS = 500;
const MAX_REPAIR_CANDIDATES = 8;

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
            return {
                id: row.id,
                name: row.name,
                icon: row.icon,
                host: feedHost(row.url),
                category: categorizeFeedError(row.lastError, row.url),
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

/** Every non-newsletter feed of the user that is auto-muted or has failed syncs. */
export async function getBrokenFeeds(): Promise<BrokenFeedDto[]> {
    const userId = await requireUserId();
    const rows = await db.feed.findMany({
        where: {
            userId,
            sourceType: { not: NEWSLETTER_SOURCE_TYPE },
            OR: [{ autoMuted: true }, { consecutiveFailureCount: { gt: 0 } }],
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
        data: { ...applyManualUnmute(), failingSince: null },
    });
    revalidatePath("/");
    return { success: true };
}

export type RepairCandidate = { url: string; title: string; type: string };
export type RepairProposal =
    | { status: "ok"; site: string; candidates: RepairCandidate[]; hint?: "needs-rsshub" | "rate-limited" | "blocked" }
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
    try {
        await fetchFeedArticles({ url });
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
 * "Alle entfernen, die seit > 30 Tagen fehlschlagen". The client sends the ids
 * it showed in the confirmation; each one is re-checked here (owned, still
 * failing, streak older than the cutoff) so a stale list can never delete a
 * feed that has recovered in the meantime.
 */
export async function removeStaleBrokenFeeds(feedIds: string[]): Promise<{ removed: number; skipped: number }> {
    const userId = await requireUserId();
    if (!Array.isArray(feedIds)) throw new Error("Invalid input");
    const ids = [...new Set(feedIds.filter(validId))].slice(0, MAX_BULK_IDS);
    if (ids.length === 0) return { removed: 0, skipped: 0 };
    const rows = await db.feed.findMany({
        where: { id: { in: ids }, userId, sourceType: { not: NEWSLETTER_SOURCE_TYPE } },
        select: BROKEN_SELECT,
    });
    const now = new Date();
    const eligible = (rows as BrokenRow[]).filter((row) => isStaleBroken(row, now, STALE_BROKEN_FEED_DAYS)).map((row) => row.id);
    if (eligible.length) await db.feed.deleteMany({ where: { id: { in: eligible }, userId } });
    revalidatePath("/");
    return { removed: eligible.length, skipped: ids.length - eligible.length };
}
