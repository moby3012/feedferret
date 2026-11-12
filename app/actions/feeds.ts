"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { syncUserFeeds, syncFeed } from "@/lib/rss-sync";
import { fetchFeedArticles } from "@/lib/feed-fetcher";
import { hintForFetchError } from "@/lib/fetch-error-hint";
import { assertSafeHttpOptionsProxy, fetchTextWithSsrfProtection, isTrustedFeedFetchingAllowed } from "@/lib/ssrf";
import { generateOpml } from "@/lib/opml";
import { importOpmlXml } from "@/lib/import/opml-import";
import {
    MAX_LABEL_NAME,
    MAX_SEARCH_QUERY,
    MAX_SAVED_SEARCH_NAME,
    CreateFeedSchema,
} from "@/lib/validation";
import { fetchAndSuggestFeedCandidatesDetailed, type SuggestedFieldConfig } from "@/lib/page-feed-suggest";
import { createPageFeedForUser } from "@/lib/page-feed-create";
import { sanitizeWebhookConfigs, actionsReferenceConfigs, redactRuleForClient } from "@/lib/webhooks";
import { scrapeXPathArticles } from "@/lib/feed-fetcher";
import { createUndoToken, claimUndoToken, releaseUndoToken } from "@/lib/undo-tokens";
import { isMarkAllAllowed } from "@/lib/view-scope";
import { buildViewScope, legacyViewScopeInput } from "@/server/articles/view-scope";
import { markWhereRead, parseCutoffMs, setReadStateByIds } from "@/server/articles/bulk-read";
import { loadCategories, loadFeeds, loadLabels, loadNotifications, loadSavedSearches } from "@/server/bootstrap";
import { applyRetentionPoliciesForUser } from "@/lib/retention";
import { randomBytes } from "crypto";
import { decryptIfValue } from "@/lib/crypto";
import type { AiProvider } from "@/lib/ai-summary";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { AI_OPERATOR_DELETE_ERROR, ruleHasAiDeleteConflict } from "@/lib/rule-ai-operators";
import { parseRuleActions } from "@/lib/auto-read-rules";
import { isHtmlWorkerError, runInHtmlWorker } from "@/lib/html-worker";
import { describePageFetchError, refetchArticleFullText } from "@/lib/full-text-fetch";
import {
    discoverExistingFeeds,
    normalizeActionUrl,
    pageFetchErrorCode,
    sameFeedAddress,
    TLS_ERROR_TEXT,
    type AddFeedErrorCode,
} from "@/lib/add-feed-input";
import { httpFallbackUrl, isConnectError } from "@/lib/url-input";
import { pickFields } from "@/lib/pick-fields";
import { clampFeedLimits } from "@/lib/feed-limits";
import { assertOwnedCategories, MAX_REORDER_ITEMS } from "@/lib/owned-categories";
import { connectorFeedUrlError, redactArticleForClient, redactFeedForClient, redactFeedsForClient, stripConnectorSecrets } from "@/lib/connector-secrets";
import { FEED_CLIENT_SELECT, HTTP_OPTION_KEEP, mergeHttpOptions, readFeedCredentials, redactHttpOptions, stripFeedSecrets } from "@/lib/feed-secrets";
import { readPlainColumn } from "@/lib/secret-box";
import { parseGoogleNewsFeedUrl } from "@/lib/google-news";
import { googleNewsFeedName } from "@/lib/google-news-url";

export async function refreshAllFeeds() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const result = await syncUserFeeds(session.user.id);
    return result;
}

export async function refreshFeed(feedId: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const feed = await db.feed.findFirst({
        where: { id: feedId, userId: session.user.id },
        select: { id: true },
    });
    if (!feed) throw new Error("Feed not found");

    const result = await syncFeed(session.user.id, feedId);
    return result;
}

export async function getFeeds() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    return loadFeeds(session.user.id);
}

export async function getCategories() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    return loadCategories(session.user.id);
}

export async function getLabels() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    return loadLabels(session.user.id);
}

export async function createLabel(data: { name: string; color?: string }) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const name = data.name.trim();
    if (!name) throw new Error("Label name is required");
    if (name.length > MAX_LABEL_NAME) throw new Error(`Label name too long (max ${MAX_LABEL_NAME} characters)`);

    const label = await db.label.create({
        data: {
            userId: session.user.id,
            name,
            color: data.color || "#3b82f6",
        },
    });

    revalidatePath("/");
    return label;
}

export async function updateLabel(labelId: string, data: { name?: string; color?: string }) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const label = await db.label.update({
        where: { id: labelId, userId: session.user.id },
        data: {
            ...(data.name !== undefined ? { name: data.name.trim() } : {}),
            ...(data.color !== undefined ? { color: data.color } : {}),
        },
    });

    revalidatePath("/");
    return label;
}

export async function deleteLabel(labelId: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    await db.label.delete({
        where: { id: labelId, userId: session.user.id },
    });

    revalidatePath("/");
}

export async function setArticleLabels(articleId: string, labelIds: string[]) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const article = await db.article.findUnique({
        where: { id: articleId, userId: session.user.id },
        select: { id: true },
    });
    if (!article) throw new Error("Article not found");

    const labels = await db.label.findMany({
        where: {
            userId: session.user.id,
            id: { in: labelIds },
        },
        select: { id: true },
    });
    const allowedIds = labels.map((label: { id: string }) => label.id);

    await db.$transaction([
        db.articleLabel.deleteMany({
            where: { articleId, userId: session.user.id },
        }),
        ...allowedIds.map((labelId: string) =>
            db.articleLabel.create({
                data: {
                    articleId,
                    labelId,
                    userId: session.user.id,
                },
            }),
        ),
    ]);

    return await db.article.findUnique({
        where: { id: articleId, userId: session.user.id },
        // feedContent is internal (feed version kept for sync comparisons).
        omit: { feedContent: true },
        include: {
            feed: { select: { id: true, name: true, icon: true, htmlUrl: true } },
            labels: { include: { label: true } },
        },
    });
}

export async function getSavedSearches() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    return loadSavedSearches(session.user.id);
}

export async function createSavedSearch(data: { name: string; query: string }) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const name = data.name.trim();
    const query = data.query.trim();
    if (!name || !query) throw new Error("Name and query are required");
    if (name.length > MAX_SAVED_SEARCH_NAME) throw new Error(`Search name too long (max ${MAX_SAVED_SEARCH_NAME} characters)`);
    if (query.length > MAX_SEARCH_QUERY) throw new Error(`Search query too long (max ${MAX_SEARCH_QUERY} characters)`);

    const savedSearch = await db.savedSearch.create({
        data: {
            userId: session.user.id,
            name,
            query,
        },
    });

    return savedSearch;
}

export async function updateSavedSearch(searchId: string, data: { name?: string; query?: string; order?: number }) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const savedSearch = await db.savedSearch.update({
        where: { id: searchId, userId: session.user.id },
        data: {
            ...(data.name !== undefined ? { name: data.name.trim() } : {}),
            ...(data.query !== undefined ? { query: data.query.trim() } : {}),
            ...(data.order !== undefined ? { order: data.order } : {}),
        },
    });

    revalidatePath("/");
    return savedSearch;
}

export async function setSavedSearchSharing(searchId: string, enabled: boolean) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const existing = await db.savedSearch.findUnique({
        where: { id: searchId, userId: session.user.id },
        select: { shareToken: true },
    });
    if (!existing) throw new Error("Saved search not found");

    const savedSearch = await db.savedSearch.update({
        where: { id: searchId, userId: session.user.id },
        data: enabled
            ? {
                shareToken: existing.shareToken || randomBytes(24).toString("base64url"),
                sharedAt: new Date(),
            }
            : { shareToken: null, sharedAt: null },
    });

    revalidatePath("/");
    revalidatePath("/settings");
    return savedSearch;
}

export async function deleteSavedSearch(searchId: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    await db.savedSearch.delete({
        where: { id: searchId, userId: session.user.id },
    });

    revalidatePath("/");
}

export async function addFeed(rawUrl: string, categoryId?: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    // Bare domains, `www.`, missing scheme, pasted junk → one https URL.
    const normalized = normalizeActionUrl(rawUrl);
    if (!normalized.ok) return { success: false as const, error: normalized.error, errorCode: normalized.errorCode };
    let url = normalized.url;

    const parsed = CreateFeedSchema.safeParse({ url, categoryId });
    if (!parsed.success) {
        return { success: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    // Only allowed connector routes (no /rsshub/transform/…, no all-watches feed) — N3.
    const connectorError = await connectorFeedUrlError(url);
    if (connectorError) return { success: false as const, error: connectorError };

    if (categoryId) {
        const category = await db.category.findFirst({
            where: { id: categoryId, userId: session.user.id },
            select: { id: true },
        });
        if (!category) return { success: false as const, error: "Invalid category" };
    }

    try {
        // Stored URLs never carry connector secrets; the fetcher adds them (N3).
        url = await stripConnectorSecrets(url);
        let remoteFeed;
        try {
            remoteFeed = await fetchFeedArticles({ url });
        } catch (error) {
            // No scheme typed and https could not connect at all: one plain-http try.
            const fallback = normalized.schemeAssumed && isConnectError(error) ? httpFallbackUrl(url) : null;
            if (!fallback) throw error;
            remoteFeed = await fetchFeedArticles({ url: fallback });
            url = fallback;
        }

        // G1: keyword feeds get "Google News: <query>" instead of Google's title.
        const googleNews = parseGoogleNewsFeedUrl(url);
        const feed = await db.feed.create({
            data: {
                url,
                name: googleNews ? googleNewsFeedName(googleNews.query) : remoteFeed.title || "New Feed",
                userId: session.user.id,
                categoryId,
                lastStatus: "pending",
            },
        });

        await syncFeed(session.user.id, feed.id);
        revalidatePath("/");
        return { success: true as const, feed: await redactFeedForClient(stripFeedSecrets(feed)) };
    } catch (error) {
        logger.error("Failed to add feed:", error);
        // "Add directly" with a web page (not a feed): fall back to discovery
        // and offer the page's real feeds instead of failing.
        const discovered = await discoverExistingFeeds(session.user.id, rawUrl);
        const others = discovered.feeds.filter((f) => !sameFeedAddress(f.url, url));
        if (others.length) {
            return {
                success: false as const,
                errorCode: "not-a-feed" as AddFeedErrorCode,
                error: "This address is a web page, not a feed. Pick one of the feeds found on it.",
                discovered: others,
            };
        }
        if (pageFetchErrorCode(error) === "page-tls-error" || discovered.tlsError) {
            return { success: false as const, errorCode: "page-tls-error" as AddFeedErrorCode, error: TLS_ERROR_TEXT };
        }
        const hint = hintForFetchError(error);
        if (hint) return { success: false as const, error: hint };
        return { success: false as const, errorCode: "no-feed-found" as AddFeedErrorCode, error: "Invalid RSS/Atom feed URL" };
    }
}

const PAGE_FEED_PREVIEW_CAP = 8;

/**
 * Turns a raw fetch/SSRF error into a message that tells the user WHY we
 * couldn't read the page, instead of a one-size-fits-all "check the URL".
 * SSRF-guard errors (private IP, localhost, invalid scheme, too large, too
 * many redirects) are already clear, safe, self-authored text — pass those
 * through unchanged. An HTTP status failure gets a status-specific message,
 * since 401/403/429 almost always means the site's bot/anti-scraping
 * protection (e.g. a Cloudflare challenge) rejected our request, which is a
 * very different situation from a broken URL and worth telling users about.
 */
export async function suggestFeedFromUrl(rawUrl: string, options: { skipDiscovery?: boolean } = {}) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const normalized = normalizeActionUrl(rawUrl);
    if (!normalized.ok) return { success: false as const, error: normalized.error, errorCode: normalized.errorCode };

    // Discovery first: a page that already publishes a feed gets that feed
    // offered (one click), scraping stays an explicit alternative.
    let pageUrl = normalized.url;
    if (!options?.skipDiscovery) {
        const existing = await discoverExistingFeeds(session.user.id, rawUrl);
        if (existing.feeds.length) {
            return { success: true as const, kind: "existing-feed" as const, feeds: existing.feeds, pageUrl: existing.pageUrl ?? pageUrl };
        }
        if (existing.tlsError) return { success: false as const, errorCode: "page-tls-error" as const, error: TLS_ERROR_TEXT };
        if (existing.pageUrl) pageUrl = existing.pageUrl;
    }

    try {
        let result;
        try {
            result = await fetchAndSuggestFeedCandidatesDetailed(pageUrl);
        } catch (error) {
            const fallback = normalized.schemeAssumed && pageUrl === normalized.url && isConnectError(error) ? httpFallbackUrl(pageUrl) : null;
            if (!fallback) throw error;
            result = await fetchAndSuggestFeedCandidatesDetailed(fallback);
            pageUrl = fallback;
        }
        const { candidates, rejected } = result;
        return {
            success: true as const,
            kind: "candidates" as const,
            pageUrl,
            candidates: candidates.map((candidate) => ({
                config: candidate.config,
                score: candidate.score,
                itemCount: candidate.itemCount,
                sampleTitles: candidate.sampleTitles,
                // Preview quality gate verdict: "review" candidates are shown
                // with a "please review" label and their reasons.
                quality: candidate.quality,
                preview: candidate.previewArticles.slice(0, PAGE_FEED_PREVIEW_CAP).map((article, i) => ({
                    title: article.title,
                    link: article.link,
                    publishedAt: article.publishedAt ? article.publishedAt.toISOString() : null,
                    imageUrl: article.imageUrl || null,
                    flagged: candidate.previewIssues[i] != null,
                })),
            })),
            // Lists the gate dropped (navigation, login, maps, placeholders…)
            // and why, so an empty result can explain itself.
            rejected: { count: rejected.count, reasons: rejected.reasons },
        };
    } catch (error) {
        logger.error("Failed to suggest feed candidates from page:", error);
        return { success: false as const, error: describePageFetchError(error), errorCode: pageFetchErrorCode(error) };
    }
}

export async function createFeedFromPage(input: {
    url: string;
    config: SuggestedFieldConfig;
    name?: string;
    categoryId?: string;
}) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const normalized = normalizeActionUrl(input?.url);
    if (!normalized.ok) return { success: false, error: normalized.error, errorCode: normalized.errorCode };
    const pageUrl = normalized.url;

    if (!input.config?.xPathItem || !input.config.xPathItem.trim()) {
        return { success: false, error: "A repeating item selector is required" };
    }

    if (input.categoryId) {
        const category = await db.category.findFirst({
            where: { id: input.categoryId, userId: session.user.id },
            select: { id: true },
        });
        if (!category) return { success: false, error: "Invalid category" };
    }

    try {
        const feed = await createPageFeedForUser(session.user.id, {
            url: pageUrl,
            config: input.config,
            name: input.name,
            categoryId: input.categoryId,
        });
        revalidatePath("/");
        return { success: true, feed: feed ? await redactFeedForClient(stripFeedSecrets(feed)) : feed };
    } catch (error) {
        logger.error("Failed to create feed from page:", error);
        return { success: false, error: "Could not create feed from that page" };
    }
}

/**
 * The AI "Let AI set this up" proposal action (Phase 2 M4, slice 2). Fetches
 * the page once, hands it to `proposeFeedConfig` (which asks the user's BYOK
 * AI provider for a scraping config and validates it through the real
 * extraction engine), and returns a fully serializable result shaped so the
 * UI can reuse the exact same candidate-card rendering as the heuristic
 * `suggestFeedFromUrl` path. Never returns raw HTML.
 */
export async function proposeAiFeedConfig(rawUrl: string, options: { skipDiscovery?: boolean } = {}) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const normalized = normalizeActionUrl(rawUrl);
    if (!normalized.ok) return { success: false as const, error: normalized.error, errorCode: normalized.errorCode };

    const user = await db.user.findUnique({
        where: { id: session.user.id },
        select: { aiProvider: true, aiApiKey: true, aiModel: true, aiOllamaBaseUrl: true },
    });
    if (!user?.aiProvider) {
        return {
            success: false as const,
            errorCode: "ai-not-configured" as const,
            error: "AI is not configured. Set up AI in Settings → AI Summaries.",
        };
    }

    // Discovery first, at no AI cost: a page that already publishes a feed
    // gets that feed offered; the AI path stays an explicit alternative.
    let url = normalized.url;
    if (!options?.skipDiscovery) {
        const existing = await discoverExistingFeeds(session.user.id, rawUrl);
        if (existing.feeds.length) {
            return { success: true as const, mode: "existing-feed" as const, feeds: existing.feeds, pageUrl: existing.pageUrl ?? url };
        }
        if (existing.tlsError) return { success: false as const, errorCode: "page-tls-error" as const, error: TLS_ERROR_TEXT };
        if (existing.pageUrl) url = existing.pageUrl;
    }

    const rateLimit = checkRateLimit(`user:${session.user.id}`, RATE_LIMITS.aiFeedConfig);
    if (!rateLimit.success) {
        return { success: false as const, errorCode: "ai-rate-limited" as const, error: "Too many AI requests. Wait a bit and try again." };
    }

    // Captured by the injected fetchHtml below so we can reuse the same fetched
    // HTML to build a full item preview afterward without fetching the page twice.
    let fetchedHtml: string | null = null;
    const fetchPage = async (u: string) =>
        fetchTextWithSsrfProtection(
            u,
            {},
            {
                allowInternal: await isTrustedFeedFetchingAllowed(),
                context: "AI feed config",
                impersonate: true,
                maxBytes: 2 * 1024 * 1024,
                maxRedirects: 5,
                timeoutMs: 12_000,
            },
        );

    try {
        const { proposeFeedConfig } = await import("@/lib/ai-feed-config");
        const { proposal, validation } = await proposeFeedConfig(
            url,
            {
                provider: user.aiProvider as AiProvider,
                apiKey: decryptIfValue(user.aiApiKey, "user.aiApiKey"),
                model: user.aiModel,
                ollamaBaseUrl: user.aiOllamaBaseUrl,
                usage: { userId: session.user.id, feature: "feed-config" },
            },
            {
                fetchHtml: async (u: string) => {
                    try {
                        fetchedHtml = await fetchPage(u);
                    } catch (error) {
                        const fallback = normalized.schemeAssumed && u === normalized.url && isConnectError(error) ? httpFallbackUrl(u) : null;
                        if (!fallback) throw error;
                        fetchedHtml = await fetchPage(fallback);
                        url = fallback;
                    }
                    return fetchedHtml;
                },
            },
        );

        if (proposal.mode === "fulltext") {
            return {
                success: true as const,
                mode: "fulltext" as const,
                notes: proposal.notes ?? null,
            };
        }

        if (!validation.ok) {
            return {
                success: false as const,
                errorCode: "ai-no-config" as const,
                error: "The AI couldn't find a working configuration for this page",
            };
        }

        let preview: { title: string; link: string; publishedAt: string | null; imageUrl: string | null }[] = [];
        if (fetchedHtml) {
            try {
                const xpath: Record<string, string> = {};
                for (const [key, value] of Object.entries(proposal.itemConfig)) {
                    if (value) xpath[key] = value;
                }
                const { articles } = await scrapeXPathArticles(fetchedHtml, url, { xpath }, "text/html");
                preview = articles.slice(0, PAGE_FEED_PREVIEW_CAP).map((article) => ({
                    title: article.title,
                    link: article.link,
                    publishedAt: article.publishedAt ? article.publishedAt.toISOString() : null,
                    imageUrl: article.imageUrl || null,
                }));
            } catch {
                // Preview is a nice-to-have; the validated itemCount/sampleTitles
                // already convey that the config works even if this re-derivation fails.
            }
        }

        return {
            success: true as const,
            mode: "pagefeed" as const,
            pageUrl: url,
            config: proposal.itemConfig,
            itemCount: validation.itemCount ?? 0,
            sampleTitles: validation.sampleTitles ?? [],
            preview,
            notes: proposal.notes ?? null,
        };
    } catch (error) {
        logger.error("Failed to propose AI feed config:", error);
        const message = error instanceof Error ? error.message : "";
        if (message.includes("unreadable config")) {
            return { success: false as const, errorCode: "ai-unreadable" as const, error: "The AI returned a response we couldn't understand. Try again." };
        }
        if (/Fetch failed|private IP|localhost|only supports http|URL is invalid|too large|Too many redirects/i.test(message) || fetchedHtml === null) {
            return { success: false as const, errorCode: pageFetchErrorCode(error), error: describePageFetchError(error) };
        }
        // Raw provider messages ("Anthropic 401: …") stay in the server log.
        return { success: false as const, errorCode: "ai-failed" as const, error: "The AI request failed. Check the AI settings and try again." };
    }
}

/**
 * AI full-text-selector proposal (Phase 2 M4, slice 3/T5). Picks the most
 * recent already-synced article on this feed as a representative sample,
 * then reuses the same `proposeFeedConfig` engine as `proposeAiFeedConfig`
 * to ask the user's BYOK AI provider for the article-body CSS selector.
 * The proposal only comes back if the real extraction engine (JSDOM query +
 * sanitizer) validates it against the live page — never trusts the AI's
 * output on its own. Shares `RATE_LIMITS.aiFeedConfig`'s budget with
 * `proposeAiFeedConfig` since both hit the AI provider and fetch a page.
 */
export async function proposeAiFullTextSelector(feedId: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const feed = await db.feed.findFirst({
        where: { id: feedId, userId: session.user.id },
        select: { id: true },
    });
    if (!feed) throw new Error("Feed not found");

    const article = await db.article.findFirst({
        where: { feedId, userId: session.user.id, link: { not: "" } },
        orderBy: { publishedAt: "desc" },
        select: { link: true },
    });
    if (!article?.link) {
        return {
            success: false as const,
            error: "This feed has no synced articles yet. Sync the feed first, then try again.",
        };
    }

    const rateLimit = checkRateLimit(`user:${session.user.id}`, RATE_LIMITS.aiFeedConfig);
    if (!rateLimit.success) {
        return { success: false as const, error: "Too many AI requests. Wait a bit and try again." };
    }

    const user = await db.user.findUnique({
        where: { id: session.user.id },
        select: { aiProvider: true, aiApiKey: true, aiModel: true, aiOllamaBaseUrl: true },
    });
    if (!user?.aiProvider) {
        return { success: false as const, error: "AI is not configured. Set up AI in Settings → AI Summaries." };
    }

    // Captured by the injected fetchHtml below so we can re-derive a plain-text
    // excerpt from the validated selector without fetching the page twice.
    let fetchedHtml: string | null = null;

    try {
        const { proposeFeedConfig } = await import("@/lib/ai-feed-config");
        const { proposal, validation } = await proposeFeedConfig(
            article.link,
            {
                provider: user.aiProvider as AiProvider,
                apiKey: decryptIfValue(user.aiApiKey, "user.aiApiKey"),
                model: user.aiModel,
                ollamaBaseUrl: user.aiOllamaBaseUrl,
                usage: { userId: session.user.id, feature: "feed-config" },
            },
            {
                fetchHtml: async (u: string) => {
                    fetchedHtml = await fetchTextWithSsrfProtection(
                        u,
                        {},
                        {
                            allowInternal: await isTrustedFeedFetchingAllowed(),
                            context: "AI full-text selector",
                            impersonate: true,
                            maxBytes: 2 * 1024 * 1024,
                            maxRedirects: 5,
                            timeoutMs: 12_000,
                        },
                    );
                    return fetchedHtml;
                },
            },
        );

        if (proposal.mode !== "fulltext" || !validation.ok) {
            return {
                success: false as const,
                error: "The AI couldn't find a reliable selector for this feed's articles",
            };
        }

        let excerpt: string | null = null;
        if (fetchedHtml) {
            try {
                const probe = await runInHtmlWorker({
                    task: "cssProbe",
                    html: fetchedHtml,
                    url: article.link,
                    selector: proposal.fullTextSelector,
                });
                if (probe.status === "ok") excerpt = probe.excerpt || null;
            } catch {
                // Excerpt is a nice-to-have; the validated selector already proves it works.
            }
        }

        return {
            success: true as const,
            selector: proposal.fullTextSelector,
            notes: proposal.notes ?? null,
            excerpt,
        };
    } catch (error) {
        logger.error("Failed to propose AI full-text selector:", error);
        const message = error instanceof Error ? error.message : "";
        if (message.includes("unreadable config")) {
            return { success: false as const, error: "The AI returned a response we couldn't understand. Try again." };
        }
        if (/Fetch failed|private IP|localhost|only supports http|URL is invalid|too large|Too many redirects/i.test(message)) {
            return { success: false as const, error: describePageFetchError(error) };
        }
        return { success: false as const, error: message || "The AI request failed. Try again." };
    }
}

export async function deleteFeed(feedId: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    await db.feed.delete({
        where: { id: feedId, userId: session.user.id },
    });

    revalidatePath("/");
}

const UPDATE_FEED_FIELDS = [
    "name",
    "categoryId",
    "updateFrequency",
    "retentionDays",
    "keepMinArticles",
    "authType",
    "authUsername",
    "authPassword",
    "customUserAgent",
    "fetchTimeoutSecs",
    "sslVerify",
    "maxSizeKb",
    "fullTextSelector",
    "fullTextRemoveSelectors",
    "autoFetchFullText",
    "fullTextMode",
    "defaultContentFormat",
    "fullTextConditions",
    "fullTextAutoSuggestDismissed",
    "filtersActionRead",
    "sourceType",
    "priority",
    "unicityCriteria",
    "unicityCriteriaForced",
    "scraperConfig",
    "httpOptions",
    "hideFromAllFeeds",
    "hideArticleImage",
    "readerFontSizeOverride",
    "readerWidthOverride",
    "openOriginalOverride",
    "autoMuted",
] as const;

export async function updateFeed(feedId: string, data: {
    name?: string;
    categoryId?: string | null;
    updateFrequency?: number | null;
    retentionDays?: number | null;
    keepMinArticles?: number | null;
    // Auth
    authType?: string | null;
    authUsername?: string | null;
    authPassword?: string | null;
    // Fetch options
    customUserAgent?: string | null;
    fetchTimeoutSecs?: number | null;
    sslVerify?: boolean;
    maxSizeKb?: number | null;
    // Full-text extraction
    fullTextSelector?: string | null;
    fullTextRemoveSelectors?: string | null;
    autoFetchFullText?: boolean;
    fullTextMode?: string;
    defaultContentFormat?: string;
    fullTextConditions?: string | null;
    fullTextAutoSuggestDismissed?: boolean;
    filtersActionRead?: string | null;
    // Scout Studio source options
    sourceType?: string;
    priority?: string;
    unicityCriteria?: string;
    unicityCriteriaForced?: boolean;
    scraperConfig?: string | null;
    httpOptions?: string | null;
    // Behavior
    hideFromAllFeeds?: boolean;
    hideArticleImage?: boolean;
    // Per-feed reader defaults (null = inherit the user's global default)
    readerFontSizeOverride?: string | null;
    readerWidthOverride?: string | null;
    openOriginalOverride?: boolean | null;
    // F6: auto-mute for persistently-failing feeds
    autoMuted?: boolean;
}) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    if (data.categoryId) {
        const category = await db.category.findFirst({
            where: { id: data.categoryId, userId: session.user.id },
            select: { id: true },
        });
        if (!category) throw new Error("Invalid category");
    }

    if (typeof data.httpOptions === "string" && data.httpOptions.includes(HTTP_OPTION_KEEP)) {
        // The dialog sends masked secrets back as "__keep__": resolve them against the stored value.
        const stored = await db.feed.findFirst({ where: { id: feedId, userId: session.user.id }, select: { httpOptions: true } });
        if (!stored) throw new Error("Feed not found");
        data = { ...data, httpOptions: mergeHttpOptions(data.httpOptions, readPlainColumn("feed.httpOptions", stored.httpOptions)) };
    }
    if (data.httpOptions) await assertSafeHttpOptionsProxy(data.httpOptions);

    const READER_FONT_SIZES = new Set(["small", "medium", "large", "xl"]);
    const READER_WIDTHS = new Set(["normal", "wide", "full"]);
    const FULL_TEXT_MODES = new Set(["off", "auto", "selector"]);
    const CONTENT_FORMATS = new Set(["html", "markdown"]);

    // Allowlist: server-action input is untrusted at runtime; spreading it let a
    // caller set userId (re-assign the feed to another account) or internal fields.
    const allowed = clampFeedLimits(pickFields(data, UPDATE_FEED_FIELDS));
    await db.feed.update({
        where: { id: feedId, userId: session.user.id },
        data: {
            ...allowed,
            ...(data.readerFontSizeOverride !== undefined ? {
                readerFontSizeOverride: data.readerFontSizeOverride && READER_FONT_SIZES.has(data.readerFontSizeOverride)
                    ? data.readerFontSizeOverride
                    : null,
            } : {}),
            ...(data.readerWidthOverride !== undefined ? {
                readerWidthOverride: data.readerWidthOverride && READER_WIDTHS.has(data.readerWidthOverride)
                    ? data.readerWidthOverride
                    : null,
            } : {}),
            ...(data.openOriginalOverride !== undefined ? {
                openOriginalOverride: data.openOriginalOverride === null ? null : !!data.openOriginalOverride,
            } : {}),
            ...(data.fullTextMode !== undefined ? {
                fullTextMode: FULL_TEXT_MODES.has(data.fullTextMode) ? data.fullTextMode : "off",
            } : {}),
            ...(data.defaultContentFormat !== undefined ? {
                defaultContentFormat: CONTENT_FORMATS.has(data.defaultContentFormat) ? data.defaultContentFormat : "html",
            } : {}),
            // F6: a user manually unmuting a feed resets the failure counter and
            // gives it one more chance, rather than resuming right at the
            // threshold (see lib/feed-auto-mute.ts's applyManualUnmute).
            ...(data.autoMuted === false ? { consecutiveFailureCount: 0, failingSince: null } : {}),
        },
    });

    revalidatePath("/");
}

export async function getFeedHealth() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const feeds = await db.feed.findMany({
        // Archived feeds are not synced anymore: they have no health to report.
        where: { userId: session.user.id, archivedAt: null },
        select: {
            ...FEED_CLIENT_SELECT,
            category: true,
            _count: {
                select: { articles: true },
            },
        },
        orderBy: [{ lastStatus: "desc" }, { name: "asc" }],
    });

    const unreadCounts = await db.article.groupBy({
        by: ["feedId"],
        where: { userId: session.user.id, isRead: false },
        _count: { _all: true },
    });
    const unreadByFeed = new Map(unreadCounts.map((item: { feedId: string; _count: { _all: number } }) => [item.feedId, item._count._all]));

    const duplicateCounts = await db.article.groupBy({
        by: ["feedId"],
        where: { userId: session.user.id, isDuplicate: true, duplicateOf: { not: null } },
        _count: { _all: true },
    });
    const duplicateByFeed = new Map(duplicateCounts.map((item: { feedId: string; _count: { _all: number } }) => [item.feedId, item._count._all]));

    // Oldest article per feed for avgArticlesPerDay calculation
    const oldestByFeed = await db.article.groupBy({
        by: ["feedId"],
        where: { userId: session.user.id },
        _min: { publishedAt: true },
        _count: { _all: true },
    });
    const oldestMap = new Map(oldestByFeed.map((item: { feedId: string; _min: { publishedAt: Date | null } }) => [item.feedId, item._min.publishedAt]));

    return redactFeedsForClient(feeds.map((feed) => {
        const oldest = oldestMap.get(feed.id);
        const totalArticles = feed._count.articles;
        let avgArticlesPerDay: number | null = null;
        if (oldest && totalArticles > 0) {
            const ageDays = Math.max(1, (Date.now() - new Date(oldest).getTime()) / (1000 * 60 * 60 * 24));
            avgArticlesPerDay = Math.round((totalArticles / ageDays) * 10) / 10;
        }
        return {
            ...feed,
            unreadCount: unreadByFeed.get(feed.id) || 0,
            duplicateCount: duplicateByFeed.get(feed.id) || 0,
            articleCount: totalArticles,
            avgArticlesPerDay,
        };
    }));
}

/**
 * The owner-only, on-demand part of the feed settings dialog (N4): fetch
 * credentials and Scout-Studio options are no longer in the feed list / SSR
 * bootstrap. The Basic-Auth password is write-only — only whether one is
 * stored is returned; `updateFeed` keeps it when `authPassword` is omitted.
 */
export async function getFeedEditConfig(feedId: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    if (typeof feedId !== "string" || !feedId) throw new Error("Feed not found");

    const feed = await db.feed.findFirst({
        where: { id: feedId, userId: session.user.id },
        select: { authUsername: true, authPassword: true, scraperConfig: true, httpOptions: true },
    });
    if (!feed) throw new Error("Feed not found");
    // Owner-only: decrypts v2-sealed values (M8). An undecryptable value throws,
    // so the dialog keeps the stored value instead of saving an empty one.
    const opened = readFeedCredentials({ authUsername: feed.authUsername, httpOptions: feed.httpOptions });
    // Cookies, headers, POST bodies, proxy credentials … are write-only: masked as "__keep__".
    const { httpOptions, masked } = redactHttpOptions(opened.httpOptions);
    return {
        authUsername: opened.authUsername ?? null,
        hasAuthPassword: Boolean(feed.authPassword),
        scraperConfig: feed.scraperConfig ?? null,
        httpOptions,
        maskedHttpOptions: masked,
    };
}

export async function applyRetentionPolicies(dryRun = false) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const result = await applyRetentionPoliciesForUser(session.user.id, dryRun);

    if (!dryRun) revalidatePath("/");
    return result;
}

export async function addCategory(name: string, parentId?: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    if (parentId) await assertOwnedCategories(session.user.id, [parentId]);
    const category = await db.category.create({
        data: {
            name,
            userId: session.user.id,
            parentId,
        },
    });

    revalidatePath("/");
    return category;
}

export async function updateCategory(categoryId: string, data: { name?: string; updateFrequency?: number | null }) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const allowed = pickFields(data, ["name", "updateFrequency"] as const);
    if (allowed.name !== undefined && typeof allowed.name !== "string") throw new Error("Invalid name");
    await db.category.update({
        where: { id: categoryId, userId: session.user.id },
        data: clampFeedLimits(allowed),
    });

    revalidatePath("/");
}

export async function deleteCategory(categoryId: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    await db.category.delete({
        where: { id: categoryId, userId: session.user.id },
    });

    revalidatePath("/");
}

export async function updateCategoryOrder(orders: { id: string; order: number; parentId?: string | null }[]) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    // parentId must be one of the user's own categories (never another account's).
    if (!Array.isArray(orders) || orders.length > MAX_REORDER_ITEMS) throw new Error("Too many items");
    try {
        await assertOwnedCategories(session.user.id, orders.map((o) => o.parentId));
    } catch {
        throw new Error("Invalid parent category");
    }

    await db.$transaction(
        orders.map((o) =>
            db.category.update({
                where: { id: o.id, userId: session.user.id },
                data: { order: o.order, parentId: o.parentId },
            })
        )
    );

    revalidatePath("/");
}

export async function updateFeedOrder(orders: { id: string; order: number; categoryId?: string | null }[]) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    if (!Array.isArray(orders) || orders.length > MAX_REORDER_ITEMS) throw new Error("Too many items");
    await assertOwnedCategories(session.user.id, orders.map((o) => o.categoryId));

    await db.$transaction(
        orders.map((o) =>
            db.feed.update({
                where: { id: o.id, userId: session.user.id },
                data: { order: o.order, categoryId: o.categoryId },
            })
        )
    );

    revalidatePath("/");
}

/**
 * Legacy `(feedId, category, search)` → view scope. The scope builder lives in
 * server/articles/view-scope.ts (shared with GET /api/app/articles) so the
 * list, the header count and "mark all read" always describe the same set.
 */
async function buildLegacyViewScope(userId: string, feedId?: string | null, category?: string, search?: string, categoryId?: string | null) {
    return buildViewScope(userId, legacyViewScopeInput(feedId, category, categoryId), search);
}

/**
 * Server-side unread count for a list view. The list is paged, so counting
 * unread rows client-side under-reports big views; this counts the whole view.
 */
export async function getViewUnreadCount(feedId?: string | null, category?: string, search?: string, categoryId?: string | null) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    // Read-only views ("Recently Read", "Spoiler") have nothing to mark read:
    // report 0 instead of counting unrelated unread rows.
    if (!isMarkAllAllowed(feedId, category)) return 0;

    const { where } = await buildLegacyViewScope(session.user.id, feedId, category, search, categoryId);
    where.isRead = false;
    return db.article.count({ where });
}

export async function exportOpml(selectedFeedIds?: string[], options?: { includeCredentials?: boolean }) {
    // Opt-in only: cookies, headers, POST bodies, proxy and URL credentials (PM decision, #280).
    const includeCredentials = options?.includeCredentials === true;
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const where: any = { userId: session.user.id };
    if (selectedFeedIds && selectedFeedIds.length > 0) {
        where.id = { in: selectedFeedIds };
    }

    const [feeds, categories, user] = await Promise.all([
        db.feed.findMany({
            where,
            include: { category: { select: { id: true, name: true, parentId: true, opmlUrl: true } } },
            orderBy: [{ category: { name: "asc" } }, { name: "asc" }],
        }),
        db.category.findMany({
            where: { userId: session.user.id },
            orderBy: [{ order: "asc" }, { name: "asc" }],
        }),
        db.user.findUnique({ where: { id: session.user.id }, select: { defaultUpdateFrequency: true } }),
    ]);

    // Connector secrets are never exported (N3); the user's own feed credentials
    // (cookies, headers, proxy, URL userinfo) only with the explicit opt-in.
    return generateOpml(await redactFeedsForClient(feeds), selectedFeedIds?.length ? [] : categories, {
        defaultUpdateFrequency: user?.defaultUpdateFrequency,
        includeCredentials,
    });
}

export async function exportUserData() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const userId = session.user.id;

    const [feeds, labels, savedSearches, autoReadRules] = await Promise.all([
        db.feed.findMany({
            where: { userId },
            include: { category: { select: { name: true } } },
            orderBy: { name: "asc" },
        }),
        db.label.findMany({ where: { userId }, orderBy: { name: "asc" } }),
        db.savedSearch.findMany({ where: { userId }, orderBy: { order: "asc" } }),
        db.autoReadRule.findMany({ where: { userId }, orderBy: { order: "asc" } }),
    ]);

    return JSON.stringify(
        {
            exportedAt: new Date().toISOString(),
            version: 1,
            feeds: (await redactFeedsForClient(feeds)).map((f: { name: string; url: string; category?: { name: string } | null; icon: string | null; updateFrequency: number | null; retentionDays: number | null }) => ({
                name: f.name,
                url: f.url,
                category: f.category?.name ?? null,
                icon: f.icon,
                updateFrequency: f.updateFrequency,
                retentionDays: f.retentionDays,
            })),
            labels: labels.map((l: { name: string; color: string | null }) => ({ name: l.name, color: l.color })),
            savedSearches: savedSearches.map((s: { name: string; query: string }) => ({ name: s.name, query: s.query })),
            autoReadRules: autoReadRules.map((r: { name: string; query: string; action: string; enabled: boolean }) => ({
                name: r.name,
                query: r.query,
                action: r.action,
                enabled: r.enabled,
            })),
        },
        null,
        2,
    );
}

export async function importOpml(xml: string, options?: { dryRun?: boolean }) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) throw new Error("Unauthorized");

    if (!checkRateLimit(`user:${userId}`, RATE_LIMITS.opmlImport).success) throw new Error("Too many imports, try again in a minute");
    // Shared with REST v1 (`POST /api/v1/opml`), MCP (`import_opml`) and the FreshRSS
    // migration flow: lib/import/opml-import maps every OPML field once.
    const report = await importOpmlXml(userId, xml, { dryRun: options?.dryRun === true });
    if (!report.dryRun) revalidatePath("/");
    return report;
}

export async function fetchFullText(articleId: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    // Shared with the REST v1 (`POST /articles/{id}/fetch-full-text`) and MCP
    // (`fetch_full_text`) surfaces via lib/full-text-fetch. See that module for
    // the extraction-engine + improvement-check rationale. The UI caller expects
    // the article fields spread at the top level plus `suggestAutoFullText`.
    const { article, suggestAutoFullText } = await refetchArticleFullText(session.user.id, articleId);
    return { ...(await redactArticleForClient({ ...article, feed: await redactFeedForClient(article.feed) })), suggestAutoFullText };
}

/**
 * Upper bound of changed ids a bulk mark (or its Undo) sends back. Larger
 * results return only `count`: the client already patched the rows it holds
 * (optimistically, by scope) and refetches counts; shipping and walking 45 k
 * ids would only cost bandwidth and main-thread time.
 */
const MAX_RETURNED_IDS = 2000;

export interface BulkReadActionResult {
    /** Number of articles this call changed. */
    count: number;
    /** The changed ids, or `[]` when `count` > MAX_RETURNED_IDS (`idsTruncated`). */
    ids: string[];
    idsTruncated?: true;
    undoToken: string | null;
    /**
     * A chunk failed after others had been written: `count` / `undoToken` cover what changed.
     * Mark-all: re-running the same request finishes it (idempotent: same scope + cutoff).
     */
    incomplete?: true;
    /** Undo only, with `incomplete`: a fresh token for the rows this Undo did not restore yet. */
    retryToken?: string;
}

function bulkResult(ids: string[], complete: boolean, undoToken: string | null): BulkReadActionResult {
    const truncated = ids.length > MAX_RETURNED_IDS;
    return {
        count: ids.length,
        ids: truncated ? [] : ids,
        ...(truncated ? { idsTruncated: true as const } : {}),
        undoToken,
        ...(complete ? {} : { incomplete: true as const }),
    };
}

/**
 * Marks exactly the current list view read: the scope is built by the same
 * view scope as the list (GET /api/app/articles) / `getViewUnreadCount`, so feed / category /
 * label / saved search / free-text search / "hide duplicates" / spoiler rules
 * all match what the user sees. Read-only views ("Recently Read", "Spoiler")
 * change nothing.
 *
 * `cutoff` (epoch ms, optional): the list's snapshot time — only articles that
 * arrived at or before it are marked, so items a sync delivered after the
 * user loaded the list (or while this runs) stay unread. Without it the
 * server's request time is the cutoff.
 *
 * Set-based and chunked (server/articles/bulk-read.ts): short write
 * statements instead of one long transaction, `updatedAt` untouched. Returns
 * the count (+ ids for small results) and a server-side, user-scoped
 * `undoToken` for `markArticlesAsUnread`.
 */
export async function markAllAsRead(scope?: { feedId?: string | null; category?: string | null; categoryId?: string | null; search?: string | null; cutoff?: number | null }): Promise<BulkReadActionResult> {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const userId = session.user.id;

    const str = (value: unknown) => (typeof value === "string" ? value : undefined);
    const feedId = str(scope?.feedId) || null;
    const category = str(scope?.category) || undefined;
    const search = str(scope?.search)?.trim() || undefined;
    const now = new Date();
    const cutoff = parseCutoffMs(scope?.cutoff, now.getTime());
    if (cutoff === undefined) throw new Error("Invalid cutoff");

    if (!isMarkAllAllowed(feedId, category)) return bulkResult([], true, null);

    const { where } = await buildLegacyViewScope(userId, feedId, category, search, str(scope?.categoryId) || null);
    const result = await markWhereRead(userId, where, { cutoff: cutoff ?? now, now });
    return bulkResult(result.ids, result.complete, createUndoToken(userId, result.ids));
}

/**
 * Undo for `markAllAsRead`. Takes only the opaque token that call returned
 * (random, bound to the signed-in user, valid ~10 minutes) — never article ids
 * from the client. Restores exactly the articles that call changed and that are
 * still read (chunked, `updatedAt` untouched).
 *
 * The token is consumed for the rows this call restores: a failure before
 * anything changed puts it back; a failure after some chunks returns
 * `incomplete` plus a `retryToken` holding exactly the rows not restored yet,
 * so a retry finishes the Undo instead of losing it.
 */
export async function markArticlesAsUnread(undoToken: string): Promise<BulkReadActionResult> {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const userId = session.user.id;

    const claim = claimUndoToken(userId, undoToken);
    if (!claim) throw new Error("Undo expired");

    let result: Awaited<ReturnType<typeof setReadStateByIds>>;
    try {
        result = await setReadStateByIds(userId, claim.ids, false);
    } catch (error) {
        releaseUndoToken(undoToken, claim);
        throw error;
    }
    if (result.complete) return bulkResult(result.ids, true, null);
    const retryToken = createUndoToken(userId, result.remaining);
    return { ...bulkResult(result.ids, false, null), ...(retryToken ? { retryToken } : {}) };
}

// ─── Auto-Read Rules ────────────────────────────────────────────────────────

export async function getAutoReadRules() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const rules = await db.autoReadRule.findMany({
        where: { userId: session.user.id },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    });
    // Webhook signing secrets are write-only: the client gets `hasSecret` + `secretRef`.
    return rules.map(redactRuleForClient);
}

function normalizeRuleActions(actions?: string[] | null): { primary: string; serialized: string | null } {
    const cleaned = (actions || []).map((a) => String(a).trim()).filter(Boolean);
    if (cleaned.length === 0) return { primary: "mark_read", serialized: null };
    return {
        primary: cleaned[0],
        serialized: JSON.stringify(cleaned),
    };
}

function normalizeTrigger(value?: string | null): "article" | "feed_error" {
    return value === "feed_error" ? "feed_error" : "article";
}

const FEED_ERROR_ACTION_WHITELIST = new Set(["notify_inapp", "notify_push", "notify_email"]);

function filterActionsForTrigger(trigger: "article" | "feed_error", actions: string[]): string[] {
    if (trigger !== "feed_error") return actions;
    return actions.filter((a) => FEED_ERROR_ACTION_WHITELIST.has(a) || a.startsWith("webhook_call:"));
}


export async function createAutoReadRule(data: {
    name: string;
    query: string;
    action?: string;
    actions?: string[];
    scope?: string | null;
    trigger?: string;
    webhookConfigs?: unknown;
    removeSpoilerOnDelete?: boolean;
}) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    if (!data.name.trim()) throw new Error("Name is required");
    const trigger = normalizeTrigger(data.trigger);
    if (trigger === "article" && !data.query.trim()) {
        throw new Error("Query is required for article-based rules");
    }
    const rawList = data.actions && data.actions.length > 0 ? data.actions : (data.action ? [data.action] : []);
    const list = filterActionsForTrigger(trigger, rawList);
    if (list.length === 0) throw new Error("At least one supported action is required");
    if (ruleHasAiDeleteConflict(data.query, list)) throw new Error(AI_OPERATOR_DELETE_ERROR);
    const { primary, serialized } = normalizeRuleActions(list);

    const { configs, valid } = sanitizeWebhookConfigs(data.webhookConfigs);
    if (!valid) throw new Error("Each webhook action needs a valid http(s) URL");
    if (!actionsReferenceConfigs(list, configs.length)) {
        throw new Error("Webhook action references a missing configuration");
    }

    const rule = await db.autoReadRule.create({
        data: {
            userId: session.user.id,
            name: data.name.trim(),
            query: data.query.trim(),
            action: primary,
            actions: serialized,
            scope: data.scope?.trim() || null,
            trigger,
            webhookConfigs: configs.length ? JSON.stringify(configs) : null,
            removeSpoilerOnDelete: !!data.removeSpoilerOnDelete,
        },
    });
    revalidatePath("/");
    return redactRuleForClient(rule);
}

export async function updateAutoReadRule(
    ruleId: string,
    data: Partial<{
        name: string;
        query: string;
        action: string;
        actions: string[];
        scope: string | null;
        enabled: boolean;
        order: number;
        trigger: string;
        webhookConfigs: unknown;
        removeSpoilerOnDelete: boolean;
    }>,
) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const existing = await db.autoReadRule.findFirst({
        where: { id: ruleId, userId: session.user.id },
        select: { trigger: true, query: true, action: true, actions: true, webhookConfigs: true },
    });
    if (!existing) throw new Error("Rule not found");

    const trigger = data.trigger !== undefined ? normalizeTrigger(data.trigger) : normalizeTrigger(existing.trigger);

    const patch: Record<string, unknown> = {};
    if (data.name !== undefined) patch.name = String(data.name).trim();
    if (data.query !== undefined) patch.query = String(data.query).trim();
    if (data.scope !== undefined) patch.scope = data.scope ? String(data.scope).trim() : null;
    if (data.enabled !== undefined) patch.enabled = !!data.enabled;
    if (data.order !== undefined) patch.order = Number(data.order) || 0;
    if (data.trigger !== undefined) patch.trigger = trigger;

    let nextActions: string[] | null = null;
    if (data.actions !== undefined) {
        nextActions = filterActionsForTrigger(trigger, data.actions);
        const { primary, serialized } = normalizeRuleActions(nextActions);
        patch.actions = serialized;
        patch.action = primary;
    } else if (data.action !== undefined) {
        patch.action = String(data.action).trim();
    }

    if (data.webhookConfigs !== undefined) {
        const { configs, valid } = sanitizeWebhookConfigs(data.webhookConfigs, { existing: existing.webhookConfigs });
        if (!valid) throw new Error("Each webhook action needs a valid http(s) URL");
        const actionsForCheck = nextActions ?? (() => {
            // Compare against existing actions if caller didn't send a new list.
            return [] as string[];
        })();
        if (!actionsReferenceConfigs(actionsForCheck, configs.length) && nextActions) {
            throw new Error("Webhook action references a missing configuration");
        }
        patch.webhookConfigs = configs.length ? JSON.stringify(configs) : null;
    }

    if (data.removeSpoilerOnDelete !== undefined) {
        patch.removeSpoilerOnDelete = !!data.removeSpoilerOnDelete;
    }

    // Validate the rule as it will be stored (patched fields over the existing row).
    const effectiveQuery = typeof patch.query === "string" ? patch.query : existing.query;
    const effectiveActions =
        typeof patch.action === "string" || nextActions
            ? nextActions ?? [String(patch.action)]
            : parseRuleActions(existing);
    if (ruleHasAiDeleteConflict(effectiveQuery, effectiveActions)) throw new Error(AI_OPERATOR_DELETE_ERROR);

    const rule = await db.autoReadRule.update({
        where: { id: ruleId, userId: session.user.id },
        data: patch,
    });
    revalidatePath("/");
    return redactRuleForClient(rule);
}

export async function deleteAutoReadRule(ruleId: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const rule = await db.autoReadRule.findFirst({
        where: { id: ruleId, userId: session.user.id },
        select: { removeSpoilerOnDelete: true },
    });
    if (!rule) throw new Error("Rule not found");

    if (rule.removeSpoilerOnDelete) {
        await db.article.updateMany({
            where: { userId: session.user.id, spoilerRuleId: ruleId, isSpoiler: true },
            data: { isSpoiler: false, spoilerAt: null, spoilerRuleId: null },
        });
    }

    await db.autoReadRule.delete({
        where: { id: ruleId, userId: session.user.id },
    });
    revalidatePath("/");
}

export async function releaseArticleSpoiler(articleId: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    await db.article.updateMany({
        where: { id: articleId, userId: session.user.id },
        data: { isSpoiler: false, spoilerAt: null, spoilerRuleId: null },
    });
}

export async function releaseAllSpoilers() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    await db.article.updateMany({
        where: { userId: session.user.id, isSpoiler: true },
        data: { isSpoiler: false, spoilerAt: null, spoilerRuleId: null },
    });
}

export async function applyAutoReadRulesNow() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const { applyAutoReadRules } = await import("@/lib/auto-read-rules");
    const result = await applyAutoReadRules(session.user.id);
    revalidatePath("/");
    return result;
}

export async function previewAutoReadRule(query: string, scope: string | null = null, limit = 10) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const { previewAutoReadRuleMatches } = await import("@/lib/auto-read-rules");
    return previewAutoReadRuleMatches(session.user.id, query, scope, limit);
}

export async function migrateKeywordAlertsToRules() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const userId = session.user.id;

    const alerts = await db.keywordAlert.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
    });
    if (alerts.length === 0) return { migrated: 0 };

    let migrated = 0;
    for (const alert of alerts) {
        let alertActions: string[] = ["notify_inapp"];
        try {
            const parsed = JSON.parse(alert.actions);
            if (Array.isArray(parsed)) {
                alertActions = parsed.filter((x: unknown) => typeof x === "string");
            }
        } catch {}
        if (alertActions.length === 0) alertActions = ["notify_inapp"];

        await db.autoReadRule.create({
            data: {
                userId,
                name: alert.name,
                query: alert.query,
                action: alertActions[0],
                actions: JSON.stringify(alertActions),
                scope: alert.scope === "all" ? null : alert.scope,
                enabled: alert.enabled,
                lastTriggeredAt: alert.lastTriggeredAt,
            },
        });
        await db.keywordAlert.delete({ where: { id: alert.id } });
        migrated += 1;
    }
    revalidatePath("/");
    return { migrated };
}

// ─── Keyword Alerts + Notifications ────────────────────────────────────────

const ALLOWED_ALERT_ACTIONS = [
    "notify_inapp",
    "notify_push",
    "notify_email",
    "notify_telegram",
    "notify_gotify",
    "notify_ntfy",
] as const;

function stringifyAlertActions(actions?: string[]) {
    const allowed = (actions || ["notify_inapp"]).filter((action) =>
        (ALLOWED_ALERT_ACTIONS as readonly string[]).includes(action),
    );
    return JSON.stringify(allowed.length ? allowed : ["notify_inapp"]);
}

export async function getKeywordAlerts() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    return db.keywordAlert.findMany({
        where: { userId: session.user.id },
        orderBy: [{ enabled: "desc" }, { createdAt: "desc" }],
        include: {
            _count: { select: { notifications: true } },
        },
    });
}

export async function createKeywordAlert(data: {
    name: string;
    query: string;
    scope?: string;
    actions?: string[];
}) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const name = data.name.trim();
    const query = data.query.trim();
    if (!name || !query) throw new Error("Name and query are required");

    const alert = await db.keywordAlert.create({
        data: {
            userId: session.user.id,
            name,
            query,
            scope: data.scope || "all",
            actions: stringifyAlertActions(data.actions),
        },
    });
    revalidatePath("/");
    return alert;
}

export async function updateKeywordAlert(
    alertId: string,
    data: Partial<{ name: string; query: string; scope: string; actions: string[]; enabled: boolean }>,
) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const alert = await db.keywordAlert.update({
        where: { id: alertId, userId: session.user.id },
        data: {
            ...(data.name !== undefined ? { name: data.name.trim() } : {}),
            ...(data.query !== undefined ? { query: data.query.trim() } : {}),
            ...(data.scope !== undefined ? { scope: data.scope } : {}),
            ...(data.actions !== undefined ? { actions: stringifyAlertActions(data.actions) } : {}),
            ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
        },
    });
    revalidatePath("/");
    return alert;
}

export async function deleteKeywordAlert(alertId: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    await db.keywordAlert.delete({ where: { id: alertId, userId: session.user.id } });
    revalidatePath("/");
}

export async function previewKeywordAlertMatches(query: string, scope = "all", limit = 10) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const { previewKeywordAlert } = await import("@/lib/keyword-alerts");
    return previewKeywordAlert(session.user.id, query, scope, limit);
}

export async function testKeywordAlert(alertId: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const alert = await db.keywordAlert.findUnique({ where: { id: alertId, userId: session.user.id } });
    if (!alert) throw new Error("Alert not found");
    const { previewKeywordAlert } = await import("@/lib/keyword-alerts");
    return previewKeywordAlert(session.user.id, alert.query, alert.scope, 100);
}

export async function getAlertHistory(alertId: string, limit = 20) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const alert = await db.keywordAlert.findFirst({ where: { id: alertId, userId: session.user.id }, select: { id: true } });
    if (!alert) throw new Error("Not found");
    return db.notification.findMany({
        where: { userId: session.user.id, alertId, type: "keyword_alert" },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { id: true, title: true, body: true, isRead: true, createdAt: true, articleId: true },
    });
}

export async function getNotifications(limit = 20) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    return loadNotifications(session.user.id, limit);
}

export async function markNotificationRead(notificationId: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    return db.notification.update({
        where: { id: notificationId, userId: session.user.id },
        data: { isRead: true },
    });
}

export async function markAllNotificationsRead() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    return db.notification.updateMany({
        where: { userId: session.user.id, isRead: false },
        data: { isRead: true },
    });
}

/**
 * Dismiss ONE notification of the signed-in user. A notification is a one-shot
 * event record (feed auto-muted, keyword hit, …): deleting it never touches the
 * feed's mute / error state, and nothing re-creates it unless a new event fires.
 */
export async function dismissNotification(notificationId: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    if (typeof notificationId !== "string" || !notificationId) throw new Error("Invalid notification");
    const { count } = await db.notification.deleteMany({
        where: { id: notificationId, userId: session.user.id },
    });
    return { deleted: count };
}

/** Dismiss ALL notifications of the signed-in user (same guarantees as above). */
export async function clearAllNotifications() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const { count } = await db.notification.deleteMany({ where: { userId: session.user.id } });
    return { deleted: count };
}

export async function previewFeedExtraction(feedId: string, articleUrl: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const feed = await db.feed.findFirst({
        where: { id: feedId, userId: session.user.id },
        select: { fullTextSelector: true, fullTextRemoveSelectors: true },
    });
    if (!feed) throw new Error("Feed not found");

    const html = await fetchTextWithSsrfProtection(
        articleUrl,
        { headers: { "User-Agent": "FeedFerret/1.0", Accept: "text/html,application/xhtml+xml" } },
        {
            allowInternal: await isTrustedFeedFetchingAllowed(),
            context: "Full-text preview fetch",
            impersonate: true,
            maxBytes: 2 * 1024 * 1024,
            maxRedirects: 5,
            timeoutMs: 12_000,
        },
    );
    // The page is attacker-controlled: parsed + evaluated in the HTML worker
    // pool on bounded input (a too-complex page rejects with HtmlWorkerError).
    const extracted = await runInHtmlWorker({
        task: "css",
        html,
        url: articleUrl,
        selector: feed.fullTextSelector,
        removeSelectors: feed.fullTextRemoveSelectors,
        mode: "preview",
    }).catch((error: unknown) => {
        if (isHtmlWorkerError(error)) throw new Error(describePageFetchError(error));
        throw error;
    });
    if (!extracted.html) throw new Error("Could not find article content");
    const sanitized = extracted.html;

    return {
        html: sanitized.slice(0, 50_000),
        charCount: extracted.plainLength,
        selectorUsed: feed.fullTextSelector || "(auto-detect)",
        candidates: extracted.candidates,
    };
}

/**
 * On-demand article summary. The daily AI token cap is an expected outcome,
 * not a failure: it comes back as `{ error: "budget" }` (server actions mask
 * thrown messages in production) so the UI can say why.
 */
export async function summarizeArticle(articleId: string): Promise<{ summary: string; error?: undefined } | { summary?: undefined; error: "budget" | "ai_off" }> {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const [article, user] = await Promise.all([
        db.article.findFirst({
            where: { id: articleId, userId: session.user.id },
            select: { id: true, content: true },
        }),
        db.user.findUnique({
            where: { id: session.user.id },
            select: {
                aiProvider: true,
                aiApiKey: true,
                aiModel: true,
                aiOllamaBaseUrl: true,
                aiSummaryLanguage: true,
            },
        }),
    ]);

    if (!article) throw new Error("Article not found");
    if (!user?.aiProvider) throw new Error("No AI provider configured. Set up AI in Settings → AI Summaries.");

    const { generateSummary } = await import("@/lib/ai-summary");

    const { AiBudgetError } = await import("@/lib/ai/errors");

    let summary: string;
    try {
        summary = await generateSummary(article.content, {
            provider: user.aiProvider as AiProvider,
            apiKey: decryptIfValue(user.aiApiKey, "user.aiApiKey"),
            model: user.aiModel,
            ollamaBaseUrl: user.aiOllamaBaseUrl,
            language: user.aiSummaryLanguage,
            usage: { userId: session.user.id, feature: "summary" },
        });
    } catch (error) {
        if (error instanceof AiBudgetError) return { error: error.cap === 0 ? "ai_off" : "budget" };
        throw error;
    }

    await db.article.update({
        where: { id: articleId, userId: session.user.id },
        data: { aiSummary: summary, aiSummarizedAt: new Date() },
    });

    revalidatePath("/");
    return { summary };
}

/** Whether an admin has configured the RSSHub connector (M5a) — gates the "Add from platform" UI. */
export async function getRsshubStatus() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const { isRsshubConfigured } = await import("@/lib/rsshub");
    return { configured: await isRsshubConfigured() };
}

/**
 * Resolves a candidate RSSHub feed and validates it for real before ever
 * showing success — either from an explicit route path (power users who
 * know RSSHub's route syntax) or, given a source URL/description, via the
 * user's BYOK AI provider proposing one (never trusted without the same
 * validation). Returns the route URL WITHOUT the admin's access key (the
 * fetcher adds it server-side), ready to hand to the normal add-feed flow —
 * an RSSHub-backed feed is just a plain RSS/Atom feed once the route works.
 */
export async function previewRsshubFeed(input: { routePath?: string; sourceDescription?: string }) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    // Every branch below can hit the admin's RSSHub instance; bound it per user
    // before any of them (the AI branch additionally has its own stricter limit).
    if (!checkRateLimit(`user:${session.user.id}`, RATE_LIMITS.urlDiscover).success) {
        return { success: false as const, error: "Too many requests. Please wait a moment." };
    }
    const { getRsshubConfig, buildRsshubPublicRouteUrl, validateRsshubRoute, proposeAndValidateRoute, resolveRadarRoute } = await import("@/lib/rsshub");
    const rsshubConfig = await getRsshubConfig();
    if (!rsshubConfig) {
        return { success: false as const, error: "RSSHub is not configured on this server." };
    }

    const routePath = input.routePath?.trim();
    if (routePath) {
        const validation = await validateRsshubRoute(rsshubConfig, routePath);
        if (!validation.ok) return { success: false as const, error: validation.reason };
        return {
            success: true as const,
            route: routePath,
            url: buildRsshubPublicRouteUrl(rsshubConfig, routePath),
            title: validation.title,
            itemCount: validation.itemCount,
            sampleTitles: validation.sampleTitles,
        };
    }

    const sourceDescription = input.sourceDescription?.trim();
    if (!sourceDescription) {
        return { success: false as const, error: "Enter a platform URL/description, or an RSSHub route path." };
    }

    // Deterministic stage first: bundled RSSHub Radar rules need no AI key,
    // no rate limit and cost nothing — the LLM is only asked on a miss.
    const radar = await resolveRadarRoute(sourceDescription, rsshubConfig);
    if (radar) {
        if (!radar.validation.ok) {
            return { success: false as const, error: `Route "${radar.route}" didn't work: ${radar.validation.reason}` };
        }
        return {
            success: true as const,
            route: radar.route,
            url: buildRsshubPublicRouteUrl(rsshubConfig, radar.route),
            title: radar.validation.title,
            itemCount: radar.validation.itemCount,
            sampleTitles: radar.validation.sampleTitles,
        };
    }

    const rateLimit = checkRateLimit(`user:${session.user.id}`, RATE_LIMITS.rsshubRoute);
    if (!rateLimit.success) {
        return { success: false as const, error: "Too many AI requests. Wait a bit and try again." };
    }

    const user = await db.user.findUnique({
        where: { id: session.user.id },
        select: { aiProvider: true, aiApiKey: true, aiModel: true, aiOllamaBaseUrl: true },
    });
    if (!user?.aiProvider) {
        return {
            success: false as const,
            error: "AI is not configured. Set up AI in Settings → AI Summaries, or enter an RSSHub route path directly.",
        };
    }

    const result = await proposeAndValidateRoute(
        sourceDescription,
        {
            provider: user.aiProvider as AiProvider,
            apiKey: decryptIfValue(user.aiApiKey, "user.aiApiKey"),
            model: user.aiModel,
            ollamaBaseUrl: user.aiOllamaBaseUrl,
            usage: { userId: session.user.id, feature: "rsshub" },
        },
        rsshubConfig,
    );
    if (!result) {
        return {
            success: false as const,
            error: "The AI couldn't determine a route for that. Try a more specific URL, or enter a route path directly.",
        };
    }
    if (!result.validation.ok) {
        return { success: false as const, error: `Proposed route "${result.route}" didn't work: ${result.validation.reason}` };
    }

    return {
        success: true as const,
        route: result.route,
        url: buildRsshubPublicRouteUrl(rsshubConfig, result.route),
        title: result.validation.title,
        itemCount: result.validation.itemCount,
        sampleTitles: result.validation.sampleTitles,
    };
}

/** Whether an admin has configured the changedetection.io connector (M5b) — gates the "Monitor this page" UI. */
export async function getChangedetectionStatus() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const { isChangedetectionConfigured } = await import("@/lib/changedetection");
    return { configured: await isChangedetectionConfigured() };
}

/**
 * Creates a changedetection.io watch for `input.url` and returns it as a
 * ready-to-add feed URL. When `useAiSelector` is set and the user has an AI
 * provider configured, reuses M4's fulltext-selector-proposal engine
 * (`proposeFeedConfig`) to suggest a content selector — only used as a
 * best-effort `include_filters` when the engine also validated it actually
 * extracts real content from the live page; otherwise falls back to
 * watching the whole page, never blocking on the AI step.
 *
 * Important: unlike the RSSHub connector, the returned feed will have NO
 * items until changedetection.io has completed at least two checks on the
 * URL — this cannot be validated synchronously (see lib/changedetection.ts).
 * Callers must set that expectation in the UI, not treat success here as
 * "the feed has content."
 */
export async function createChangedetectionFeed(input: { url: string; useAiSelector?: boolean }) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const normalized = normalizeActionUrl(input?.url);
    if (!normalized.ok) return { success: false as const, error: normalized.error, errorCode: normalized.errorCode };
    input = { ...input, url: normalized.url };

    const { getChangedetectionConfig, createWatch, buildWatchFeedPublicUrl } = await import("@/lib/changedetection");
    const config = await getChangedetectionConfig();
    if (!config) {
        return { success: false as const, error: "changedetection.io is not configured on this server." };
    }

    let includeFilters: string[] | undefined;
    let aiNotes: string | null = null;
    if (input.useAiSelector) {
        const rateLimit = checkRateLimit(`user:${session.user.id}`, RATE_LIMITS.aiFeedConfig);
        if (!rateLimit.success) {
            return { success: false as const, error: "Too many AI requests. Wait a bit and try again." };
        }
        const user = await db.user.findUnique({
            where: { id: session.user.id },
            select: { aiProvider: true, aiApiKey: true, aiModel: true, aiOllamaBaseUrl: true },
        });
        if (user?.aiProvider) {
            try {
                const { proposeFeedConfig } = await import("@/lib/ai-feed-config");
                const { proposal, validation } = await proposeFeedConfig(input.url, {
                    provider: user.aiProvider as AiProvider,
                    apiKey: decryptIfValue(user.aiApiKey, "user.aiApiKey"),
                    model: user.aiModel,
                    ollamaBaseUrl: user.aiOllamaBaseUrl,
                    usage: { userId: session.user.id, feature: "feed-config" },
                });
                if (proposal.mode === "fulltext" && validation.ok) {
                    includeFilters = [proposal.fullTextSelector];
                    aiNotes = proposal.notes ?? null;
                }
            } catch {
                // AI assist is best-effort here — fall through to watching the whole page.
            }
        }
    }

    const result = await createWatch(config, { url: input.url, includeFilters });
    if (!result.ok) {
        return { success: false as const, error: result.reason };
    }

    return {
        success: true as const,
        url: buildWatchFeedPublicUrl(config, result.uuid),
        usedAiSelector: !!includeFilters,
        aiNotes,
    };
}
