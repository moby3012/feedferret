// Persistence rules for extracted full text (shared by background sync and the
// manual "Fetch full text" action).
//
// Invariants (see prisma/schema.prisma, Article.feedContent):
//  - `content` always holds the best content to serve. Every read path (reader,
//    REST, GReader, Fever, search, summaries) keeps reading `content` only.
//  - `feedContent !== null` ⇔ `content` holds extracted full text, and
//    `feedContent` is the feed-provided (sanitized HTML) version. Feed sync
//    compares upstream changes against `feedContent ?? content`, so a stored
//    full text is never mistaken for an upstream change (no ping-pong), and a
//    feed teaser never overwrites it.
//  - Storing full text or recording an attempt is not an upstream change:
//    every write here keeps `updatedAt` (GReader `updated` / ot-nt clock).

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { estimateReadMinutes, htmlToPlainText, markdownToPlainText } from "@/lib/article-kind";

export type FullTextStatus = "ok" | "rejected" | "failed" | "deferred";

/** Failed (fetch error) attempts per upstream version before giving up until the item changes. */
export const MAX_FULL_TEXT_ATTEMPTS = 3;

/** Unattended extractions per feed sync; the rest are picked up by later syncs (status stays null). */
export const MAX_FULL_TEXT_FETCHES_PER_SYNC = 20;

export const FULL_TEXT_STATE_SELECT = {
    id: true,
    userId: true,
    link: true,
    content: true,
    contentFormat: true,
    feedContent: true,
    updatedAt: true,
    fullTextStatus: true,
    fullTextReason: true,
    fullTextAttempts: true,
} as const;

export type FullTextArticleState = {
    id: string;
    userId: string;
    link: string;
    content: string;
    contentFormat: string;
    feedContent: string | null;
    updatedAt: Date;
    fullTextStatus: string | null;
    fullTextReason: string | null;
    fullTextAttempts: number | null;
};

/** The feed-provided content of an article (what extracted full text must beat). */
export function feedBaseline(article: Pick<FullTextArticleState, "content" | "feedContent">): string {
    return article.feedContent ?? article.content;
}

/** Whether background sync should (re)try extracting this article's full text. */
export function needsFullTextAttempt(article: { fullTextStatus: string | null; fullTextAttempts: number | null }): boolean {
    const status = article.fullTextStatus;
    if (status === null) return true;
    // Render failures are deferred but consume attempts; budget/backoff deferrals do not.
    if (status === "failed" || status === "deferred") return (article.fullTextAttempts ?? 0) < MAX_FULL_TEXT_ATTEMPTS;
    return false; // "ok" / "rejected": only an upstream change (status reset) triggers a new attempt
}

function plainOf(content: string, format: string): string {
    return format === "markdown" ? markdownToPlainText(content) : htmlToPlainText(content);
}

/**
 * Optimistic-concurrency write. The extraction result is only valid for the
 * version it started from: the row's `content` and `feedContent` must still be
 * what `article` captured. A sync that recorded an upstream change (new content
 * / feedContent) or another fetch that stored full text first changes one of
 * them, and the stale result is dropped (debug-logged) — it can never restore an
 * old feed version or mark an outdated version complete.
 *
 * Unrelated writes in between (read/star state, summaries, tags) do NOT
 * invalidate the result: the row is re-read and written compare-and-swap on the
 * CURRENT `updatedAt` (and attempt counter), keeping that current `updatedAt`
 * — never a value from the earlier snapshot. A concurrent write between re-read
 * and write makes the CAS miss and the loop re-reads.
 */
const CAS_RETRIES = 6;

async function casWrite(
    article: FullTextArticleState,
    kind: string,
    buildData: (current: { updatedAt: Date; fullTextAttempts: number | null }) => Record<string, unknown>,
): Promise<boolean> {
    for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
        const current = await db.article.findFirst({
            where: { id: article.id, userId: article.userId },
            select: { content: true, feedContent: true, updatedAt: true, fullTextAttempts: true },
        });
        if (!current || current.content !== article.content || (current.feedContent ?? null) !== (article.feedContent ?? null)) {
            logger.debug(`[full-text] dropped stale ${kind} for article ${article.id} (changed during extraction)`);
            return false;
        }
        const { count } = await db.article.updateMany({
            where: {
                id: article.id,
                userId: article.userId,
                content: current.content,
                feedContent: current.feedContent ?? null,
                updatedAt: current.updatedAt,
                fullTextAttempts: current.fullTextAttempts ?? null,
            },
            data: { ...buildData(current), updatedAt: current.updatedAt },
        });
        if (count === 1) return true;
    }
    logger.debug(`[full-text] dropped ${kind} for article ${article.id} (row kept changing)`);
    return false;
}

/**
 * Stores accepted full text in `content`, preserving the feed version in
 * `feedContent`. Returns false (and writes nothing) when the article's content
 * changed since `article` was read.
 */
export async function storeFullText(
    article: FullTextArticleState,
    result: { content: string; format: "html" | "markdown"; excerpt: string | null },
): Promise<boolean> {
    const plain = plainOf(result.content, result.format);
    return casWrite(article, "full text", () => ({
        content: result.content,
        contentFormat: result.format,
        excerpt: result.excerpt?.trim() || plain.slice(0, 240),
        readMinutes: estimateReadMinutes(plain),
        feedContent: feedBaseline(article),
        fullTextStatus: "ok",
        fullTextReason: null,
        fullTextFetchedAt: new Date(),
        fullTextAttempts: null,
    }));
}

/**
 * Records an attempt that did not produce storable full text. Never replaces
 * stored full text on a failed/deferred attempt. On a "rejected" re-extraction
 * (the page is now worse than the feed, e.g. after an upstream update), stale
 * full text that the current feed content matches or beats is dropped in favour
 * of the feed content, so the best content stays in `content`.
 *
 * Same concurrency rules as storeFullText; failed attempts are counted
 * compare-and-swap on the current counter, so concurrent attempts never lose
 * an increment. A "deferred" row that did not consume an attempt and is
 * already deferred for the same reason is not rewritten (no write per sync while a host backs off).
 */
export async function recordFullTextMiss(
    article: FullTextArticleState,
    status: Exclude<FullTextStatus, "ok">,
    reason: string,
): Promise<boolean> {
    const shortReason = reason.slice(0, 64);
    const countsAttempt = status === "failed" || (status === "deferred" && reason === "render_unavailable");
    if (!countsAttempt && status === "deferred" && article.fullTextStatus === "deferred" && article.fullTextReason === shortReason) return true;
    const revert =
        status === "rejected" &&
        article.feedContent != null &&
        (reason === "duplicate_across_items" || reason === "lead_mismatch" ||
        htmlToPlainText(article.feedContent).length >= plainOf(article.content, article.contentFormat).length);
    const feedPlain = revert ? htmlToPlainText(article.feedContent!) : "";
    return casWrite(article, `${status} outcome`, (current) => ({
        fullTextStatus: countsAttempt && status === "deferred" &&
            (current.fullTextAttempts ?? 0) + 1 >= MAX_FULL_TEXT_ATTEMPTS ? "failed" : status,
        fullTextReason: shortReason,
        fullTextFetchedAt: new Date(),
        ...(countsAttempt ? { fullTextAttempts: (current.fullTextAttempts ?? 0) + 1 } : {}),
        ...(revert
            ? {
                  content: article.feedContent!,
                  contentFormat: "html",
                  feedContent: null,
                  excerpt: feedPlain.slice(0, 200),
                  readMinutes: estimateReadMinutes(feedPlain),
              }
            : {}),
    }));
}
