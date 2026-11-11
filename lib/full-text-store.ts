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
    fullTextAttempts: number | null;
};

/** The feed-provided content of an article (what extracted full text must beat). */
export function feedBaseline(article: Pick<FullTextArticleState, "content" | "feedContent">): string {
    return article.feedContent ?? article.content;
}

/** Whether background sync should (re)try extracting this article's full text. */
export function needsFullTextAttempt(article: { fullTextStatus: string | null; fullTextAttempts: number | null }): boolean {
    const status = article.fullTextStatus;
    if (status === null || status === "deferred") return true;
    if (status === "failed") return (article.fullTextAttempts ?? 0) < MAX_FULL_TEXT_ATTEMPTS;
    return false; // "ok" / "rejected": only an upstream change (status reset) triggers a new attempt
}

function plainOf(content: string, format: string): string {
    return format === "markdown" ? markdownToPlainText(content) : htmlToPlainText(content);
}

/**
 * Optimistic-concurrency guard: the row must still be exactly the version the
 * extraction started from (same content, same feed version, same updatedAt).
 * A sync that recorded an upstream change in the meantime (new content /
 * feedContent, advanced updatedAt), a concurrent manual fetch or another
 * worker storing full text all change at least one of these, so a stale result
 * matches zero rows and is discarded — it can never restore an old feed
 * version, mark an outdated version complete, or move updatedAt backwards
 * (updatedAt is only ever re-written with the value it currently has).
 */
function snapshotWhere(article: FullTextArticleState) {
    return {
        id: article.id,
        userId: article.userId,
        updatedAt: article.updatedAt,
        content: article.content,
        feedContent: article.feedContent ?? null,
    };
}

/**
 * Stores accepted full text in `content`, preserving the feed version in
 * `feedContent`. Returns false (and writes nothing) when the article changed
 * since `article` was read.
 */
export async function storeFullText(
    article: FullTextArticleState,
    result: { content: string; format: "html" | "markdown"; excerpt: string | null },
): Promise<boolean> {
    const plain = plainOf(result.content, result.format);
    const { count } = await db.article.updateMany({
        where: snapshotWhere(article),
        data: {
            content: result.content,
            contentFormat: result.format,
            excerpt: result.excerpt?.trim() || plain.slice(0, 240),
            readMinutes: estimateReadMinutes(plain),
            feedContent: feedBaseline(article),
            fullTextStatus: "ok",
            fullTextReason: null,
            fullTextFetchedAt: new Date(),
            fullTextAttempts: null,
            updatedAt: article.updatedAt,
        },
    });
    return count === 1;
}

/**
 * Records an attempt that did not produce storable full text. Never replaces
 * stored full text on a failed/deferred attempt. On a "rejected" re-extraction
 * (the page is now worse than the feed, e.g. after an upstream update), stale
 * full text that the current feed content matches or beats is dropped in favour
 * of the feed content, so the best content stays in `content`.
 *
 * Guarded like storeFullText (stale outcomes are discarded, returns false);
 * failed attempts are counted with an atomic increment so concurrent attempts
 * never lose one.
 */
export async function recordFullTextMiss(
    article: FullTextArticleState,
    status: Exclude<FullTextStatus, "ok">,
    reason: string,
): Promise<boolean> {
    const revert =
        status === "rejected" &&
        article.feedContent != null &&
        htmlToPlainText(article.feedContent).length >= plainOf(article.content, article.contentFormat).length;
    const feedPlain = revert ? htmlToPlainText(article.feedContent!) : "";
    const data = {
        fullTextStatus: status,
        fullTextReason: reason.slice(0, 64),
        fullTextFetchedAt: new Date(),
        ...(revert
            ? {
                  content: article.feedContent!,
                  contentFormat: "html",
                  feedContent: null,
                  excerpt: feedPlain.slice(0, 200),
                  readMinutes: estimateReadMinutes(feedPlain),
              }
            : {}),
        updatedAt: article.updatedAt,
    };
    const where = snapshotWhere(article);
    if (status !== "failed") {
        const { count } = await db.article.updateMany({ where, data });
        return count === 1;
    }
    // `fullTextAttempts` is nullable (null = 0) and NULL + 1 is NULL in SQL, so
    // the first failure sets 1 and later ones increment — each statement atomic.
    const first = await db.article.updateMany({ where: { ...where, fullTextAttempts: null }, data: { ...data, fullTextAttempts: 1 } });
    if (first.count === 1) return true;
    const next = await db.article.updateMany({
        where: { ...where, fullTextAttempts: { not: null } },
        data: { ...data, fullTextAttempts: { increment: 1 } },
    });
    return next.count === 1;
}
