import { db } from "@/lib/db";
import { getSanitizer } from "@/lib/sanitize-html";
import { fetchAndExtractReadable } from "@/lib/readability-extract";
import { HostedFetchRateLimitedError } from "@/lib/hosted-fetch";
import { looksLikeTruncatedFeed } from "@/lib/full-text-mode";

/**
 * Turn a raw page-fetch error (SSRF guard, HTTP status, timeout, anti-bot
 * block, …) into a clean, status-aware, user-facing message. Shared by the
 * Server Actions (manual "Fetch full text", page→feed suggestion) and the
 * REST/MCP surface so every caller reports the same thing.
 */
export function describePageFetchError(error: unknown): string {
    const message = error instanceof Error ? error.message : "";

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
        include: { feed: true },
    });

    if (!article) throw new Error("Article not found");
    if (!article.link) throw new Error("Article has no source link");

    let result: Awaited<ReturnType<typeof fetchAndExtractReadable>>;
    try {
        result = await fetchAndExtractReadable(article.link, { userId });
    } catch (error) {
        if (error instanceof HostedFetchRateLimitedError) {
            throw new Error(
                "Your hosted full-text provider is rate-limited right now. If you're using Firecrawl's free tier without your own API key, this daily limit is shared across this whole server — add your own key in Settings → Integrations for much higher limits, or try again later.",
            );
        }
        throw new Error(describePageFetchError(error));
    }
    if (!result.html) throw new Error("Could not extract article content");

    const DOMPurify = await getSanitizer();
    const plain = DOMPurify.sanitize(result.html, { ALLOWED_TAGS: [] }).replace(/\s+/g, " ").trim();
    const existingPlainLength = (article.content || "").replace(/<[^>]*>?/gm, "").length;

    if (plain.length < 400 || plain.length <= existingPlainLength) {
        throw new Error("Full text could not improve this article");
    }

    const updated = await db.article.update({
        where: { id: article.id, userId },
        data: {
            content: result.html,
            contentFormat: "html",
            excerpt: result.excerpt?.trim() || plain.slice(0, 240),
        },
        include: {
            feed: true,
            labels: { include: { label: true } },
        },
    });

    const suggestAutoFullText =
        looksLikeTruncatedFeed(existingPlainLength, plain.length) &&
        updated.feed.fullTextMode === "off" &&
        !updated.feed.fullTextAutoSuggestDismissed
            ? { feedId: updated.feed.id, feedName: updated.feed.name }
            : null;

    return { article: updated, suggestAutoFullText };
}
