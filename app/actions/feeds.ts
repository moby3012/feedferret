"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { syncUserFeeds, syncFeed } from "@/lib/rss-sync";
import { fetchFeedArticles } from "@/lib/feed-fetcher";
import { fetchTextWithSsrfProtection, isTrustedFeedFetchingAllowed } from "@/lib/ssrf";
import {
    parseOpml,
    generateOpml,
    OpmlOutline,
    scraperConfigFromOutline,
    httpOptionsFromOutline,
} from "@/lib/opml";
import {
    validateFeedUrl,
    validateOpml,
    MAX_LABEL_NAME,
    MAX_SEARCH_QUERY,
    MAX_SAVED_SEARCH_NAME,
    CreateFeedSchema,
} from "@/lib/validation";
import { normalizeSourceType, stringifyNonEmpty } from "@/lib/feed-extraction";
import { fetchAndSuggestFeedCandidates, type SuggestedFieldConfig } from "@/lib/page-feed-suggest";
import { buildXPathArticles } from "@/lib/feed-fetcher";
import { buildAdvancedSearchWhere } from "@/lib/search";
import { applyRetentionPoliciesForUser } from "@/lib/retention";
import { randomBytes } from "crypto";
import { decryptIfValue } from "@/lib/crypto";
import type { AiProvider } from "@/lib/ai-summary";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { getSanitizer } from "@/lib/sanitize-html";
import { fetchAndExtractReadable } from "@/lib/readability-extract";
import { HostedFetchRateLimitedError } from "@/lib/hosted-fetch";
import { looksLikeTruncatedFeed } from "@/lib/full-text-mode";

export async function refreshAllFeeds() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const result = await syncUserFeeds(session.user.id);
    revalidatePath("/");
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
    revalidatePath("/");
    return result;
}

export async function getFeeds() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    return await db.feed.findMany({
        where: { userId: session.user.id },
        include: {
            category: true,
            _count: {
                select: {
                    articles: {
                        where: { isRead: false, isSpoiler: false },
                    },
                },
            },
        },
        orderBy: [
            { order: "asc" },
            { name: "asc" }
        ],
    });
}

export async function getCategories() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    return await db.category.findMany({
        where: { userId: session.user.id },
        include: {
            children: {
                orderBy: { order: "asc" }
            },
        },
        orderBy: { order: "asc" },
    });
}

export async function getStarredCount() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    return await db.article.count({
        where: { userId: session.user.id, isStarred: true },
    });
}

export async function getReadLaterCount() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    return await db.article.count({
        where: { userId: session.user.id, isReadLater: true },
    });
}

export async function getSpoilerCount() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    return await db.article.count({
        where: { userId: session.user.id, isSpoiler: true },
    });
}

export async function toggleArticleReadLater(articleId: string, isReadLater: boolean) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    await db.article.update({
        where: { id: articleId, userId: session.user.id },
        data: {
            isReadLater,
            readLaterSavedAt: isReadLater ? new Date() : null,
        },
    });

    revalidatePath("/");
}

export async function getLabels() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    return await db.label.findMany({
        where: { userId: session.user.id },
        include: {
            _count: {
                select: {
                    articles: {
                        where: {
                            article: { isRead: false },
                        },
                    },
                },
            },
        },
        orderBy: { name: "asc" },
    });
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

    revalidatePath("/");
    return await db.article.findUnique({
        where: { id: articleId, userId: session.user.id },
        include: {
            feed: true,
            labels: { include: { label: true } },
        },
    });
}

export async function getSavedSearches() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    return await db.savedSearch.findMany({
        where: { userId: session.user.id },
        orderBy: [{ order: "asc" }, { name: "asc" }],
    });
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

    revalidatePath("/");
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

export async function addFeed(url: string, categoryId?: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const parsed = CreateFeedSchema.safeParse({ url, categoryId });
    if (!parsed.success) {
        return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    const urlError = validateFeedUrl(url);
    if (urlError) return { success: false, error: urlError };

    if (categoryId) {
        const category = await db.category.findFirst({
            where: { id: categoryId, userId: session.user.id },
            select: { id: true },
        });
        if (!category) return { success: false, error: "Invalid category" };
    }

    try {
        const remoteFeed = await fetchFeedArticles({ url });

        const feed = await db.feed.create({
            data: {
                url,
                name: remoteFeed.title || "New Feed",
                userId: session.user.id,
                categoryId,
                lastStatus: "pending",
            },
        });

        await syncFeed(session.user.id, feed.id);
        revalidatePath("/");
        return { success: true, feed };
    } catch (error) {
        logger.error("Failed to add feed:", error);
        return { success: false, error: "Invalid RSS/Atom feed URL" };
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
function describePageFetchError(error: unknown): string {
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

export async function suggestFeedFromUrl(url: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const urlError = validateFeedUrl(url);
    if (urlError) return { success: false, error: urlError };

    try {
        const candidates = await fetchAndSuggestFeedCandidates(url);
        return {
            success: true,
            candidates: candidates.map((candidate) => ({
                config: candidate.config,
                score: candidate.score,
                itemCount: candidate.itemCount,
                sampleTitles: candidate.sampleTitles,
                preview: candidate.previewArticles.slice(0, PAGE_FEED_PREVIEW_CAP).map((article) => ({
                    title: article.title,
                    link: article.link,
                    publishedAt: article.publishedAt ? article.publishedAt.toISOString() : null,
                    imageUrl: article.imageUrl || null,
                })),
            })),
        };
    } catch (error) {
        logger.error("Failed to suggest feed candidates from page:", error);
        return { success: false, error: describePageFetchError(error) };
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

    const urlError = validateFeedUrl(input.url);
    if (urlError) return { success: false, error: urlError };

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
        const xpath: Record<string, string> = {};
        for (const [key, value] of Object.entries(input.config)) {
            if (typeof value === "string" && value.trim()) xpath[key] = value;
        }
        const scraperConfig = JSON.stringify({ xpath });

        let name = input.name?.trim();
        if (!name) {
            try {
                name = new URL(input.url).hostname.replace(/^www\./, "");
            } catch {
                name = "New Feed";
            }
        }

        const feed = await db.feed.create({
            data: {
                url: input.url,
                name,
                userId: session.user.id,
                categoryId: input.categoryId,
                sourceType: "HTML+XPath",
                scraperConfig,
                lastStatus: "pending",
            },
        });

        await syncFeed(session.user.id, feed.id);
        revalidatePath("/");
        return { success: true, feed };
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
export async function proposeAiFeedConfig(url: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const urlError = validateFeedUrl(url);
    if (urlError) return { success: false as const, error: urlError };

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

    // Captured by the injected fetchHtml below so we can reuse the same fetched
    // HTML to build a full item preview afterward without fetching the page twice.
    let fetchedHtml: string | null = null;

    try {
        const { proposeFeedConfig } = await import("@/lib/ai-feed-config");
        const { proposal, validation } = await proposeFeedConfig(
            url,
            {
                provider: user.aiProvider as AiProvider,
                apiKey: decryptIfValue(user.aiApiKey),
                model: user.aiModel,
                ollamaBaseUrl: user.aiOllamaBaseUrl,
            },
            {
                fetchHtml: async (u: string) => {
                    fetchedHtml = await fetchTextWithSsrfProtection(
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
            return { success: false as const, error: "The AI couldn't find a working configuration for this page" };
        }

        let preview: { title: string; link: string; publishedAt: string | null; imageUrl: string | null }[] = [];
        if (fetchedHtml) {
            try {
                const xpath: Record<string, string> = {};
                for (const [key, value] of Object.entries(proposal.itemConfig)) {
                    if (value) xpath[key] = value;
                }
                const { articles } = buildXPathArticles(fetchedHtml, url, { xpath }, "text/html");
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
            return { success: false as const, error: "The AI returned a response we couldn't understand. Try again." };
        }
        if (/Fetch failed|private IP|localhost|only supports http|URL is invalid|too large|Too many redirects/i.test(message)) {
            return { success: false as const, error: describePageFetchError(error) };
        }
        return { success: false as const, error: message || "The AI request failed. Try again." };
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
                apiKey: decryptIfValue(user.aiApiKey),
                model: user.aiModel,
                ollamaBaseUrl: user.aiOllamaBaseUrl,
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
                const { JSDOM } = await import("jsdom");
                const dom = new JSDOM(fetchedHtml, { url: article.link });
                const element = dom.window.document.querySelector(proposal.fullTextSelector);
                if (element) {
                    const sanitizer = await getSanitizer();
                    const plain = sanitizer
                        .sanitize(element.innerHTML, { ALLOWED_TAGS: [] })
                        .replace(/\s+/g, " ")
                        .trim();
                    excerpt = plain ? plain.slice(0, 500) : null;
                }
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

    const READER_FONT_SIZES = new Set(["small", "medium", "large", "xl"]);
    const READER_WIDTHS = new Set(["normal", "wide", "full"]);
    const FULL_TEXT_MODES = new Set(["off", "auto", "selector"]);
    const CONTENT_FORMATS = new Set(["html", "markdown"]);

    await db.feed.update({
        where: { id: feedId, userId: session.user.id },
        data: {
            ...data,
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
        },
    });

    revalidatePath("/");
}

export async function getFeedHealth() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const feeds = await db.feed.findMany({
        where: { userId: session.user.id },
        include: {
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

    return feeds.map((feed) => {
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
    });
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

    await db.category.update({
        where: { id: categoryId, userId: session.user.id },
        data,
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

export async function toggleArticleRead(articleId: string, isRead: boolean) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    await db.article.update({
        where: { id: articleId, userId: session.user.id },
        data: {
            isRead,
            readAt: isRead ? new Date() : null,
        },
    });

    revalidatePath("/");
}

export async function toggleArticleStarred(articleId: string, isStarred: boolean) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    await db.article.update({
        where: { id: articleId, userId: session.user.id },
        data: { isStarred },
    });

    revalidatePath("/");
}


export async function getArticles(feedId?: string | null, category?: string, search?: string, filters?: { dateFrom?: string; dateTo?: string; isRead?: boolean; isStarred?: boolean; limit?: number }) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const userPrefs = await db.user.findUnique({
        where: { id: session.user.id },
        select: { hideDuplicates: true },
    });

    const where: any = { userId: session.user.id };

    // Hide duplicates that have a known canonical article
    if (userPrefs?.hideDuplicates ?? true) {
        where.AND = [...(where.AND || []), {
            NOT: { isDuplicate: true, duplicateOf: { not: null } },
        }];
    }

    const advancedSearchWhere = await buildAdvancedSearchWhere(session.user.id, search);
    if (Object.keys(advancedSearchWhere).length) {
        where.AND = [...(where.AND || []), advancedSearchWhere];
    }

    // Date filters
    if (filters?.dateFrom) {
        where.publishedAt = { ...where.publishedAt, gte: new Date(filters.dateFrom) };
    }
    if (filters?.dateTo) {
        where.publishedAt = { ...where.publishedAt, lte: new Date(filters.dateTo) };
    }

    // Read/Starred filters
    if (filters?.isRead !== undefined) {
        where.isRead = filters.isRead;
    }
    if (filters?.isStarred !== undefined) {
        where.isStarred = filters.isStarred;
    }

    // Stable tiebreaker: feeds whose items lack a parseable date all share the
    // same sync-time fallback publishedAt, so without a secondary sort they'd
    // fall back to undefined DB order (often oldest-first feed order). createdAt
    // surfaces newer-synced articles on top; id is the final deterministic key
    // so the top-N window is consistent across requests.
    let orderBy: any = [{ publishedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }];
    let isSpoilerCategory = false;

    const isSearching = !!search?.trim();

    if (feedId) {
        where.feedId = feedId;
    } else if (!category || category === "All" || category === "All Articles") {
        // Exclude feeds and categories marked as hidden from all feeds view.
        // Skip this exclusion while searching: global search is expected to span
        // every feed the user owns, including ones hidden from the default view.
        if (!isSearching) {
            where.AND = [...(where.AND || []), {
                feed: {
                    hideFromAllFeeds: false,
                    OR: [
                        { categoryId: null },
                        { category: { hideFromAllFeeds: false } },
                    ],
                },
            }];
        }
    } else if (category !== "All" && category !== "All Articles") {
        if (category === "Starred") {
            where.isStarred = true;
        } else if (category === "Read Later") {
            where.isReadLater = true;
        } else if (category === "Spoiler") {
            isSpoilerCategory = true;
            where.isSpoiler = true;
            orderBy = { spoilerAt: "desc" };
        } else if (category === "Recently Read") {
            where.isRead = true;
            where.readAt = { not: null };
            orderBy = { readAt: "desc" };
        } else if (category === "New Articles") {
            where.isRead = false;
        } else if (category.startsWith("Label:")) {
            where.labels = {
                some: {
                    labelId: category.slice("Label:".length),
                    userId: session.user.id,
                },
            };
        } else if (category.startsWith("Search:")) {
            const savedSearch = await db.savedSearch.findUnique({
                where: { id: category.slice("Search:".length), userId: session.user.id },
            });
            if (savedSearch) {
                const savedWhere = await buildAdvancedSearchWhere(session.user.id, savedSearch.query);
                where.AND = [...(where.AND || []), savedWhere];
            }
        } else {
            where.feed = {
                category: {
                    name: category,
                },
            };
        }
    }

    // Spoiler flag is opt-in: filter spoilers out of every view that is not the
    // dedicated Spoiler category so users do not accidentally read them.
    if (!isSpoilerCategory && where.isSpoiler !== true) {
        where.AND = [...(where.AND || []), { isSpoiler: false }];
    }

    return await db.article.findMany({
        where,
        include: {
            feed: {
                select: { id: true, name: true, icon: true },
            },
            labels: {
                include: { label: true },
            },
            _count: {
                select: { duplicates: true },
            },
            canonical: {
                select: { feedId: true, feed: { select: { name: true } } },
            },
        },
        orderBy,
        take: filters?.limit || 200,
    });
}

export async function exportOpml(selectedFeedIds?: string[]) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const where: any = { userId: session.user.id };
    if (selectedFeedIds && selectedFeedIds.length > 0) {
        where.id = { in: selectedFeedIds };
    }

    const [feeds, categories] = await Promise.all([
        db.feed.findMany({
            where,
            include: { category: { select: { id: true, name: true, parentId: true, opmlUrl: true } } },
            orderBy: [{ category: { name: "asc" } }, { name: "asc" }],
        }),
        db.category.findMany({
            where: { userId: session.user.id },
            orderBy: [{ order: "asc" }, { name: "asc" }],
        }),
    ]);

    return generateOpml(feeds, selectedFeedIds?.length ? [] : categories);
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
            feeds: feeds.map((f: { name: string; url: string; category?: { name: string } | null; icon: string | null; updateFrequency: number | null; retentionDays: number | null }) => ({
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

export async function importOpml(xml: string) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) throw new Error("Unauthorized");

    const opmlError = validateOpml(xml);
    if (opmlError) throw new Error(opmlError);

    const outlines = await parseOpml(xml);
    const report = {
        feedsAdded: 0,
        feedsUpdated: 0,
        categoriesAdded: 0,
        categoriesUpdated: 0,
        errors: [] as string[],
    };

    const getOrCreateCategory = async (name: string, parentId?: string | null, opmlUrl?: string | null) => {
        const normalizedParentId = parentId || null;
        const existingCategory = await db.category.findFirst({
            where: {
                userId,
                name,
                parentId: normalizedParentId,
            },
        });
        const category = existingCategory
            ? await db.category.update({
                where: { id: existingCategory.id },
                data: opmlUrl !== undefined ? { opmlUrl } : {},
            })
            : await db.category.create({
                data: {
                userId,
                name,
                parentId: normalizedParentId,
                opmlUrl: opmlUrl || undefined,
                },
            });
        if (existingCategory) report.categoriesUpdated += 1;
        else report.categoriesAdded += 1;
        return category;
    };

    const feedDataFromOutline = (outline: OpmlOutline, categoryId?: string | null) => {
        const scraperConfig = scraperConfigFromOutline(outline);
        const httpOptions = httpOptionsFromOutline(outline);
        const extensions = outline.extensions ?? {};
        const sourceType = normalizeSourceType(outline.type);
        return {
            url: outline.xmlUrl!,
            name: outline.text,
            categoryId,
            sourceType,
            htmlUrl: outline.htmlUrl || null,
            description: outline.description || null,
            priority: extensions.priority || "main",
            unicityCriteria: extensions.unicityCriteria || "id",
            unicityCriteriaForced: extensions.unicityCriteriaForced === "true" || extensions.unicityCriteriaForced === "1",
            scraperConfig: stringifyNonEmpty(scraperConfig),
            httpOptions: stringifyNonEmpty(httpOptions),
            fullTextSelector: extensions.cssFullContent || null,
            fullTextConditions: extensions.cssFullContentConditions || null,
            fullTextRemoveSelectors: extensions.cssContentFilter || extensions.cssFullContentFilter || null,
            filtersActionRead: extensions.filtersActionRead || null,
            customUserAgent: typeof httpOptions.CURLOPT_USERAGENT === "string" ? httpOptions.CURLOPT_USERAGENT : undefined,
        };
    };

    const processOutline = async (outline: OpmlOutline, categoryId?: string) => {
        if (outline.xmlUrl) {
            let targetCategoryId = categoryId;
            if (!targetCategoryId && outline.category) {
                const category = await getOrCreateCategory(outline.category);
                targetCategoryId = category.id;
            }
            const feedData = feedDataFromOutline(outline, targetCategoryId);
            const existing = await db.feed.findUnique({
                where: {
                    userId_url: {
                        userId: userId,
                        url: outline.xmlUrl,
                    },
                },
            });
            await db.feed.upsert({
                where: {
                    userId_url: {
                        userId: userId,
                        url: outline.xmlUrl,
                    },
                },
                update: {
                    name: feedData.name,
                    categoryId: feedData.categoryId,
                    sourceType: feedData.sourceType,
                    htmlUrl: feedData.htmlUrl,
                    description: feedData.description,
                    priority: feedData.priority,
                    unicityCriteria: feedData.unicityCriteria,
                    unicityCriteriaForced: feedData.unicityCriteriaForced,
                    scraperConfig: feedData.scraperConfig,
                    httpOptions: feedData.httpOptions,
                    fullTextSelector: feedData.fullTextSelector,
                    fullTextConditions: feedData.fullTextConditions,
                    fullTextRemoveSelectors: feedData.fullTextRemoveSelectors,
                    filtersActionRead: feedData.filtersActionRead,
                    ...(feedData.customUserAgent ? { customUserAgent: feedData.customUserAgent } : {}),
                },
                create: {
                    userId: userId,
                    ...feedData,
                },
            });
            if (existing) report.feedsUpdated += 1;
            else report.feedsAdded += 1;
        } else if (outline.children) {
            const category = await getOrCreateCategory(outline.text, categoryId, outline.extensions?.opmlUrl ?? null);

            for (const child of outline.children) {
                try {
                    await processOutline(child, category.id);
                } catch (error) {
                    report.errors.push(`${outline.text}: ${String(error)}`);
                }
            }
        }
    };

    for (const outline of outlines) {
        try {
            await processOutline(outline);
        } catch (error) {
            report.errors.push(`${outline.text}: ${String(error)}`);
        }
    }

    revalidatePath("/");
    return report;
}

export async function fetchFullText(articleId: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const article = await db.article.findUnique({
        where: { id: articleId, userId: session.user.id },
        include: { feed: true },
    });

    if (!article?.link) throw new Error("Article has no source link");

    // Use the shared extraction engine (Defuddle → Readability → JSON-LD
    // articleBody fallback) rather than a bespoke DOM-scoring heuristic. The
    // JSON-LD fallback recovers full text from sites (e.g. Wired/Condé Nast)
    // that paywall/truncate the visible DOM but ship the whole body in
    // schema.org structured data. Engine fetch is SSRF-safe + impersonating.
    //
    // A fetch failure (blocked, timed out, connection reset by the site's
    // anti-bot layer, …) throws here rather than returning a result — caught
    // and turned into the same clean, status-aware message `suggestFeedFromUrl`
    // gives, instead of letting a raw/native error escape this Server Action
    // uncaught (which previously surfaced as an opaque render crash).
    // A manual "Fetch full text" click is a deliberate, single, user-initiated
    // action — so the user's hosted-API BYOK connector (M7-T3), if they've
    // configured one, is always eligible as the final fallback here, same as
    // AI features distinguish a manual action from "auto" background use.
    let result: Awaited<ReturnType<typeof fetchAndExtractReadable>>;
    try {
        result = await fetchAndExtractReadable(article.link, { userId: session.user.id });
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
        where: { id: article.id, userId: session.user.id },
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

    // A feed whose short, teaser-only description was dramatically improved by
    // a real full-text fetch is a strong empirical signal it deliberately
    // truncates (e.g. WordPress "Summary" feed mode) — a much more reliable
    // detector than guessing from link/teaser text patterns, and it works
    // retroactively for feeds added long before this existed, triggered
    // exactly when the user first notices (their own manual fetch). Only
    // offered once per feed unless the user re-enables it after dismissing.
    const suggestAutoFullText =
        looksLikeTruncatedFeed(existingPlainLength, plain.length) &&
        updated.feed.fullTextMode === "off" &&
        !updated.feed.fullTextAutoSuggestDismissed
            ? { feedId: updated.feed.id, feedName: updated.feed.name }
            : null;

    return { ...updated, suggestAutoFullText };
}

export async function markAllAsRead(scope?: { feedId?: string | null; category?: string | null }) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const where: any = { 
        userId: session.user.id,
        isRead: false 
    };
    
    if (scope?.feedId) {
        where.feedId = scope.feedId;
    } else if (scope?.category && scope.category !== "All" && scope.category !== "All Articles") {
        if (scope.category === "Starred") {
            where.isStarred = true;
        } else if (scope.category === "New Articles") {
            where.isRead = false;
        } else if (scope.category.startsWith("Label:")) {
            where.labels = {
                some: {
                    labelId: scope.category.slice("Label:".length),
                    userId: session.user.id,
                },
            };
        } else if (scope.category.startsWith("Search:")) {
            const savedSearch = await db.savedSearch.findUnique({
                where: { id: scope.category.slice("Search:".length), userId: session.user.id },
            });
            if (savedSearch) {
                const savedWhere = await buildAdvancedSearchWhere(session.user.id, savedSearch.query);
                where.AND = [...(where.AND || []), savedWhere];
            }
        } else if (scope.category !== "Recently Read") {
            where.feed = {
                category: {
                    name: scope.category,
                },
            };
        }
    }

    // Mirror getArticles: for the global "All Articles" / "All" / no-scope view,
    // exclude feeds/categories marked as hidden from the all-feeds view. Without
    // this, "Mark all read" on All Articles would silently mark articles from
    // hidden feeds as read. Category-specific scopes (Starred, Label:, etc.) are
    // deliberately NOT filtered here — the user explicitly navigated to them.
    if (!scope?.feedId && (!scope?.category || scope.category === "All" || scope.category === "All Articles")) {
        where.AND = [...(where.AND || []), {
            feed: {
                hideFromAllFeeds: false,
                OR: [
                    { categoryId: null },
                    { category: { hideFromAllFeeds: false } },
                ],
            },
        }];
    }

    // Capture the affected article ids before the bulk update so callers can
    // offer an "undo" (re-mark as unread) without needing to re-derive the
    // same scope/where clause.
    const affected = await db.article.findMany({
        where,
        select: { id: true },
    });
    const ids = affected.map((a) => a.id);

    if (ids.length > 0) {
        await db.article.updateMany({
            where: { id: { in: ids }, userId: session.user.id },
            data: { isRead: true, readAt: new Date() },
        });
    }

    revalidatePath("/");

    return { ids };
}

/**
 * Re-mark a specific set of articles as unread. Used to power "undo" for
 * bulk mark-all-read actions (e.g. auto-mark-as-read on swipe-to-next-feed).
 */
export async function markArticlesAsUnread(articleIds: string[]) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    if (!Array.isArray(articleIds) || articleIds.length === 0) return { count: 0 };

    const result = await db.article.updateMany({
        where: { id: { in: articleIds }, userId: session.user.id },
        data: { isRead: false, readAt: null },
    });

    revalidatePath("/");

    return { count: result.count };
}

// ─── Auto-Read Rules ────────────────────────────────────────────────────────

export async function getAutoReadRules() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    return db.autoReadRule.findMany({
        where: { userId: session.user.id },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    });
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

type IncomingWebhookConfig = {
    url?: unknown;
    method?: unknown;
    headers?: unknown;
    bodyTemplate?: unknown;
    secret?: unknown;
};

function sanitizeWebhookConfigs(input: unknown): { configs: { url: string; method: string; headers?: Record<string, string>; bodyTemplate?: string; secret?: string }[]; valid: boolean } {
    if (!Array.isArray(input)) return { configs: [], valid: true };
    const out: { url: string; method: string; headers?: Record<string, string>; bodyTemplate?: string; secret?: string }[] = [];
    for (const raw of input as IncomingWebhookConfig[]) {
        if (!raw || typeof raw !== "object") continue;
        const url = typeof raw.url === "string" ? raw.url.trim() : "";
        if (!url) return { configs: [], valid: false };
        try {
            const parsed = new URL(url);
            if (!["http:", "https:"].includes(parsed.protocol)) return { configs: [], valid: false };
        } catch {
            return { configs: [], valid: false };
        }
        const method = typeof raw.method === "string" && ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(raw.method.toUpperCase())
            ? raw.method.toUpperCase()
            : "POST";
        const headers = raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)
            ? Object.fromEntries(
                Object.entries(raw.headers as Record<string, unknown>)
                    .filter(([k, v]) => typeof k === "string" && typeof v === "string")
                    .map(([k, v]) => [k.slice(0, 200), String(v).slice(0, 1000)]),
            )
            : undefined;
        const bodyTemplate = typeof raw.bodyTemplate === "string" ? raw.bodyTemplate : undefined;
        const secret = typeof raw.secret === "string" && raw.secret ? raw.secret : undefined;
        out.push({ url, method, headers, bodyTemplate, secret });
    }
    return { configs: out, valid: true };
}

function actionsReferenceConfigs(actions: string[], configCount: number): boolean {
    for (const a of actions) {
        if (!a.startsWith("webhook_call:")) continue;
        const idx = Number.parseInt(a.slice("webhook_call:".length), 10);
        if (!Number.isFinite(idx) || idx < 0 || idx >= configCount) return false;
    }
    return true;
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
    return rule;
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
        select: { trigger: true },
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
        const { configs, valid } = sanitizeWebhookConfigs(data.webhookConfigs);
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

    const rule = await db.autoReadRule.update({
        where: { id: ruleId, userId: session.user.id },
        data: patch,
    });
    revalidatePath("/");
    return rule;
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
    revalidatePath("/");
}

export async function releaseAllSpoilers() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    await db.article.updateMany({
        where: { userId: session.user.id, isSpoiler: true },
        data: { isSpoiler: false, spoilerAt: null, spoilerRuleId: null },
    });
    revalidatePath("/");
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

    return db.notification.findMany({
        where: { userId: session.user.id },
        include: {
            article: {
                select: {
                    id: true,
                    title: true,
                    link: true,
                    feed: { select: { name: true, icon: true } },
                },
            },
            alert: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(Math.max(limit, 1), 100),
    });
}

export async function getUnreadNotificationCount() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    return db.notification.count({ where: { userId: session.user.id, isRead: false } });
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
    const { JSDOM } = await import("jsdom");
    const DOMPurify = await getSanitizer();
    const dom = new JSDOM(html, { url: articleUrl });
    const document = dom.window.document;

    const removeSelectors = [
        "script", "style", "nav", "footer", "header", "aside", "form", "iframe", "noscript", "svg",
        ...(feed.fullTextRemoveSelectors
            ? feed.fullTextRemoveSelectors.split(",").map((s) => s.trim()).filter(Boolean)
            : []),
    ];
    document.querySelectorAll(removeSelectors.join(",")).forEach((n) => n.remove());

    document.querySelectorAll("a[href], img[src]").forEach((node) => {
        const attr = node instanceof dom.window.HTMLImageElement ? "src" : "href";
        const value = node.getAttribute(attr);
        if (!value) return;
        try { node.setAttribute(attr, new URL(value, articleUrl).toString()); } catch { /* ignore */ }
    });

    const cssEscape = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
    const selectorFor = (element: Element) => {
        const tag = element.tagName.toLowerCase();
        const id = element.getAttribute("id");
        if (id) return `${tag}#${cssEscape(id)}`;
        const classes = Array.from(element.classList).slice(0, 3);
        if (classes.length > 0) return `${tag}.${classes.map(cssEscape).join(".")}`;
        const parent = element.parentElement;
        if (!parent) return tag;
        const siblings = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
        const index = siblings.indexOf(element);
        return siblings.length > 1 ? `${tag}:nth-of-type(${index + 1})` : tag;
    };
    const plainText = (element: Element) => (element.textContent || "").replace(/\s+/g, " ").trim();
    const scoredCandidates = [
        "article",
        "main",
        "[role='main']",
        ".post-content",
        ".entry-content",
        ".article-content",
        ".content",
        ".post",
        ".entry",
    ]
        .flatMap((s) => Array.from<Element>(document.querySelectorAll(s)))
        .concat(Array.from<Element>(document.body.children))
        .map((el: Element) => {
            const text = plainText(el);
            return {
                el,
                selector: selectorFor(el),
                charCount: text.length,
                paragraphCount: el.querySelectorAll("p").length,
                linkCount: el.querySelectorAll("a").length,
                sample: text.slice(0, 220),
                score: text.length + el.querySelectorAll("p").length * 250 - el.querySelectorAll("a").length * 20,
            };
        })
        .filter((candidate, index, all) => (
            candidate.charCount > 80 &&
            all.findIndex((other) => other.selector === candidate.selector) === index
        ))
        .sort((a, b) => b.score - a.score);

    let best: Element | undefined;
    if (feed.fullTextSelector) {
        best = document.querySelector(feed.fullTextSelector) ?? undefined;
    }
    if (!best) {
        best = scoredCandidates[0]?.el;
    }

    if (!best) throw new Error("Could not find article content");

    const sanitized = DOMPurify.sanitize(best.innerHTML, { ADD_ATTR: ["target", "rel"] }).trim();
    const plain = DOMPurify.sanitize(sanitized, { ALLOWED_TAGS: [] }).replace(/\s+/g, " ").trim();

    return {
        html: sanitized.slice(0, 50_000),
        charCount: plain.length,
        selectorUsed: feed.fullTextSelector || "(auto-detect)",
        candidates: scoredCandidates.slice(0, 5).map(({ selector, charCount, paragraphCount, linkCount, sample }) => ({
            selector,
            charCount,
            paragraphCount,
            linkCount,
            sample,
        })),
    };
}

export async function summarizeArticle(articleId: string): Promise<{ summary: string }> {
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

    const summary = await generateSummary(article.content, {
        provider: user.aiProvider as AiProvider,
        apiKey: decryptIfValue(user.aiApiKey),
        model: user.aiModel,
        ollamaBaseUrl: user.aiOllamaBaseUrl,
        language: user.aiSummaryLanguage,
    });

    await db.article.update({
        where: { id: articleId, userId: session.user.id },
        data: { aiSummary: summary, aiSummarizedAt: new Date() },
    });

    revalidatePath("/");
    return { summary };
}
