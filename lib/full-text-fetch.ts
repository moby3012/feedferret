import { applyFeedContentRules } from "./feed-content-rules-client";
import { assessExtraction } from "./extraction-quality";
import { FEED_CLIENT_SELECT } from "@/lib/feed-secrets";
import { db } from "@/lib/db";
import { decideFullText } from "@/lib/extraction-quality";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { FULL_TEXT_STATE_SELECT, storeFullText } from "@/lib/full-text-store";
import { fetchAndExtractReadable } from "@/lib/readability-extract";
import { HostedFetchRateLimitedError } from "@/lib/hosted-fetch";
import { looksLikeTruncatedFeed } from "@/lib/full-text-mode";
import { isTlsError } from "@/lib/url-input";
import { isHtmlWorkerError } from "@/lib/html-worker/pool";

/** A page whose parsing hit the HTML worker's time / memory limit (lib/html-worker). */
export const PAGE_TOO_COMPLEX_MESSAGE = "Extraction aborted: this page is too complex to process safely.";
export const PARSER_BUSY_MESSAGE = "The server is busy reading other pages right now. Try again in a moment.";
export const PARSER_UNAVAILABLE_MESSAGE = "Page processing is unavailable on this server right now (administrator: see /api/health).";

/**
 * Turn a raw page-fetch error (SSRF guard, HTTP status, timeout, anti-bot
 * block, …) into a clean, status-aware, user-facing message. Shared by the
 * Server Actions (manual "Fetch full text", page→feed suggestion) and the
 * REST/MCP surface so every caller reports the same thing.
 */
export function describePageFetchError(error: unknown): string {
    const message = error instanceof Error ? error.message : "";

    if (isHtmlWorkerError(error)) {
        if (error.reason === "busy") return PARSER_BUSY_MESSAGE;
        if (error.reason === "unavailable") return PARSER_UNAVAILABLE_MESSAGE;
        return PAGE_TOO_COMPLEX_MESSAGE;
    }

    if (isTlsError(error)) {
        return "The secure (HTTPS) connection to this site failed: certificate or TLS error. For your safety we don't switch to unencrypted http automatically. If you trust the site, enter the address with http:// explicitly.";
    }

    if (/private IP|localhost|only supports http|URL is invalid|too large|Too many redirects/i.test(message)) {
        return message;
    }

    const statusMatch = message.match(/Fetch failed: (\d+)/);
    if (statusMatch) {
        const status = Number(statusMatch[1]);
        if (status === 401 || status === 403) {
            return "This site blocked automated access (it may use bot protection like Cloudflare). We can't read pages protected this way yet.";
        }
        if (status === 404) {
            return "That page doesn't exist (404). Check the URL and try again.";
        }
        if (status === 429) {
            return "This site is rate-limiting requests. Try again in a bit.";
        }
        return `The site returned an error (HTTP ${status}). Check the URL and try again.`;
    }

    return "Could not read that page. Check the URL and try again.";
}

/**
 * Fetch and extract the full readable text of an article's source page, and —
 * if it's a genuine improvement — persist it onto the article. User-scoped and
 * session-agnostic: callers (Server Action, REST v1, MCP) supply the `userId`
 * they've already authenticated.
 *
 * Uses the shared extraction engine (Defuddle → Readability → JSON-LD
 * articleBody fallback); the engine fetch is SSRF-safe and impersonating. A
 * manual/explicit refetch is always eligible for the user's hosted-API BYOK
 * connector as the final fallback.
 *
 * Throws a clean, user-facing message when the page can't be read or the
 * result wouldn't improve the article.
 *
 * Returns the updated article (including `feed` and `labels`) plus an optional
 * `suggestAutoFullText` hint when a dramatically-improved short feed looks like
 * it deliberately truncates its items.
 */
export async function refetchArticleFullText(userId: string, articleId: string) {
    const article = await db.article.findFirst({
        where: { id: articleId, userId },
        select: { ...FULL_TEXT_STATE_SELECT, feedId: true, title: true },
    });

    if (!article) throw new Error("Article not found");

    // One limit for every surface (action, REST v1, MCP): a manual fetch can
    // escalate to the render sidecar / hosted API.
    const limit = checkRateLimit(`user:${userId}`, RATE_LIMITS.fullTextFetch);
    if (!limit.success) {
        throw new Error(`Too many full-text requests. Try again in ${limit.retryAfterSecs ?? 60} seconds.`);
    }
    if (!article.link) throw new Error("Article has no source link");

    let result: Awaited<ReturnType<typeof fetchAndExtractReadable>>;
    try {
        // Escalate (other transport → render sidecar → hosted) until the result
        // beats what the reader shows now.
        result = await fetchAndExtractReadable(article.link, { userId, baselineHtml: article.content, gate: "manual" });
    } catch (error) {
        if (error instanceof HostedFetchRateLimitedError) {
            throw new Error(
                "Your hosted full-text provider is rate-limited right now. If you're using Firecrawl's free tier without your own API key, this daily limit is shared across this whole server — add your own key in Settings → Integrations for much higher limits, or try again later.",
            );
        }
        throw new Error(describePageFetchError(error));
    }
    if (!result.html) {
        if (result.parseAborted === "too_complex") throw new Error(PAGE_TOO_COMPLEX_MESSAGE);
        if (result.parseAborted === "busy") throw new Error(PARSER_BUSY_MESSAGE);
        if (result.parseAborted === "unavailable") throw new Error(PARSER_UNAVAILABLE_MESSAGE);
        throw new Error("Could not extract article content");
    }

    const feed = await db.feed.findFirst({ where: { id: article.feedId, userId }, select: { contentRules: true, fullTextRemoveSelectors: true } });
    if (feed && feed.contentRules) {
        const [clean] = await applyFeedContentRules([{ title: article.title, html: result.html }], feed.contentRules, feed.fullTextRemoveSelectors);
        result = { ...result, html: clean.html, excerpt: clean.excerpt, quality: assessExtraction(clean.html) };
    }
    const existingPlainLength = (article.content || "").replace(/<[^>]*>?/gm, "").length;
    const decision = decideFullText(result.quality, article.content, "manual", result.html);
    if (!decision.accept) {
        if (result.quality?.verdict === "wall") {
            throw new Error("The page only showed a cookie consent, subscription or bot-check screen instead of the article.");
        }
        throw new Error("Full text could not improve this article");
    }
    const plainLength = result.quality?.textLength ?? 0;

    const stored = await storeFullText(article, { content: result.html!, format: "html", excerpt: result.excerpt });
    if (!stored) {
        // The article changed while the page was being fetched (a sync recorded
        // an upstream update, or another fetch stored full text first): this
        // result belongs to an outdated version and is discarded.
        throw new Error("This article was updated while its full text was loading. Try again.");
    }
    const updated = await db.article.findFirstOrThrow({
        where: { id: article.id, userId },
        // feedContent is internal (the feed version kept for sync comparisons).
        omit: { feedContent: true },
        include: {
            // Explicit allowlist: this article is returned to clients (N4).
            feed: { select: FEED_CLIENT_SELECT },
            labels: { include: { label: true } },
        },
    });

    const suggestAutoFullText =
        looksLikeTruncatedFeed(existingPlainLength, plainLength) &&
        updated.feed.fullTextMode === "off" &&
        !updated.feed.fullTextAutoSuggestDismissed
            ? { feedId: updated.feed.id, feedName: updated.feed.name }
            : null;

    return { article: updated, suggestAutoFullText };
}
