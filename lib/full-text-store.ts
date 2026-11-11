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

/** Stores accepted full text in `content`, preserving the feed version in `feedContent`. */
export async function storeFullText(
    article: FullTextArticleState,
    result: { content: string; format: "html" | "markdown"; excerpt: string | null },
) {
    const plain = plainOf(result.content, result.format);
    return db.article.update({
        where: { id: article.id, userId: article.userId },
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
        select: { id: true },
    });
}

/**
 * Records an attempt that did not produce storable full text. Never replaces
 * stored full text on a failed/deferred attempt. On a "rejected" re-extraction
 * (the page is now worse than the feed, e.g. after an upstream update), stale
 * full text that the current feed content matches or beats is dropped in favour
 * of the feed content, so the best content stays in `content`.
 */
export async function recordFullTextMiss(article: FullTextArticleState, status: Exclude<FullTextStatus, "ok">, reason: string) {
    const revert =
        status === "rejected" &&
        article.feedContent != null &&
        htmlToPlainText(article.feedContent).length >= plainOf(article.content, article.contentFormat).length;
    const feedPlain = revert ? htmlToPlainText(article.feedContent!) : "";
    return db.article.update({
        where: { id: article.id, userId: article.userId },
        data: {
            fullTextStatus: status,
            fullTextReason: reason.slice(0, 64),
            fullTextFetchedAt: new Date(),
            ...(status === "failed" ? { fullTextAttempts: (article.fullTextAttempts ?? 0) + 1 } : {}),
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
        },
        select: { id: true },
    });
}
