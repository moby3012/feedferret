"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { syncUserFeeds, syncFeed } from "@/lib/rss-sync";
import {
    parseOpml,
    generateOpml,
    OpmlOutline,
    scraperConfigFromOutline,
    httpOptionsFromOutline,
} from "@/lib/opml";
import { normalizeSourceType, stringifyNonEmpty } from "@/lib/freshrss-opml";
import { buildAdvancedSearchWhere } from "@/lib/search";
import Parser from "rss-parser";
import { randomBytes } from "crypto";

const parser = new Parser();

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
                        where: { isRead: false },
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
                select: { articles: true },
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
    const allowedIds = labels.map((label) => label.id);

    await db.$transaction([
        db.articleLabel.deleteMany({
            where: { articleId, userId: session.user.id },
        }),
        ...allowedIds.map((labelId) =>
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

    try {
        const remoteFeed = await parser.parseURL(url);

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
        console.error("Failed to add feed:", error);
        return { success: false, error: "Invalid RSS/Atom feed URL" };
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
    fullTextConditions?: string | null;
    filtersActionRead?: string | null;
    // FreshRSS extended source options
    sourceType?: string;
    priority?: string;
    unicityCriteria?: string;
    unicityCriteriaForced?: boolean;
    scraperConfig?: string | null;
    httpOptions?: string | null;
}) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    await db.feed.update({
        where: { id: feedId, userId: session.user.id },
        data,
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
    const unreadByFeed = new Map(unreadCounts.map((item) => [item.feedId, item._count._all]));

    // Oldest article per feed for avgArticlesPerDay calculation
    const oldestByFeed = await db.article.groupBy({
        by: ["feedId"],
        where: { userId: session.user.id },
        _min: { publishedAt: true },
        _count: { _all: true },
    });
    const oldestMap = new Map(oldestByFeed.map((item) => [item.feedId, item._min.publishedAt]));

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
            articleCount: totalArticles,
            avgArticlesPerDay,
        };
    });
}

export async function applyRetentionPolicies(dryRun = false) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
        where: { id: session.user.id },
        include: { feeds: true },
    });
    if (!user) throw new Error("User not found");

    let deleted = 0;
    for (const feed of user.feeds) {
        const retentionDays = feed.retentionDays ?? user.defaultRetentionDays;
        if (!retentionDays || retentionDays <= 0) continue;

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - retentionDays);

        // Candidates: read, not starred, not read-later, no labels, older than cutoff
        const candidates = await db.article.findMany({
            where: {
                userId: user.id,
                feedId: feed.id,
                isRead: true,
                isStarred: false,
                isReadLater: false,
                labels: { none: {} },
                publishedAt: { lt: cutoff },
            },
            select: { id: true },
            orderBy: { publishedAt: "asc" },
        });

        let toDelete = candidates;
        if (feed.keepMinArticles && feed.keepMinArticles > 0) {
            const totalCount = await db.article.count({
                where: { userId: user.id, feedId: feed.id },
            });
            const maxDeletable = Math.max(0, totalCount - feed.keepMinArticles);
            toDelete = candidates.slice(0, maxDeletable);
        }

        if (toDelete.length === 0) continue;

        if (dryRun) {
            deleted += toDelete.length;
        } else {
            const result = await db.article.deleteMany({
                where: { id: { in: toDelete.map((a) => a.id) } },
            });
            deleted += result.count;
        }
    }

    if (!dryRun) revalidatePath("/");
    return { deleted, dryRun };
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

    const where: any = { userId: session.user.id };

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

    let orderBy: any = { publishedAt: "desc" };

    if (feedId) {
        where.feedId = feedId;
    } else if (category && category !== "All" && category !== "All Articles") {
        if (category === "Starred") {
            where.isStarred = true;
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

    return await db.article.findMany({
        where,
        include: {
            feed: true,
            labels: {
                include: { label: true },
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
            feeds: feeds.map((f) => ({
                name: f.name,
                url: f.url,
                category: f.category?.name ?? null,
                icon: f.icon,
                updateFrequency: f.updateFrequency,
                retentionDays: f.retentionDays,
            })),
            labels: labels.map((l) => ({ name: l.name, color: l.color })),
            savedSearches: savedSearches.map((s) => ({ name: s.name, query: s.query })),
            autoReadRules: autoReadRules.map((r) => ({
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

    const outlines = await parseOpml(xml);
    const report = {
        feedsAdded: 0,
        feedsUpdated: 0,
        categoriesAdded: 0,
        categoriesUpdated: 0,
        errors: [] as string[],
    };

    const getOrCreateCategory = async (name: string, parentId?: string | null, opmlUrl?: string | null) => {
        const existingCategory = await db.category.findUnique({
            where: {
                userId_name_parentId: {
                    userId,
                    name,
                    parentId: (parentId || null) as any,
                },
            },
        });
        const category = await db.category.upsert({
            where: {
                userId_name_parentId: {
                    userId,
                    name,
                    parentId: (parentId || null) as any,
                },
            },
            update: opmlUrl !== undefined ? { opmlUrl } : {},
            create: {
                userId,
                name,
                parentId: parentId || undefined,
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
        const frss = outline.frss ?? {};
        const sourceType = normalizeSourceType(outline.type);
        return {
            url: outline.xmlUrl!,
            name: outline.text,
            categoryId,
            sourceType,
            htmlUrl: outline.htmlUrl || null,
            description: outline.description || null,
            priority: frss.priority || "main",
            unicityCriteria: frss.unicityCriteria || "id",
            unicityCriteriaForced: frss.unicityCriteriaForced === "true" || frss.unicityCriteriaForced === "1",
            scraperConfig: stringifyNonEmpty(scraperConfig),
            httpOptions: stringifyNonEmpty(httpOptions),
            fullTextSelector: frss.cssFullContent || null,
            fullTextConditions: frss.cssFullContentConditions || null,
            fullTextRemoveSelectors: frss.cssContentFilter || frss.cssFullContentFilter || null,
            filtersActionRead: frss.filtersActionRead || null,
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
            const category = await getOrCreateCategory(outline.text, categoryId, outline.frss?.opmlUrl ?? null);

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

    const response = await fetch(article.link, {
        headers: {
            "User-Agent": "FeedFerret/1.0 (+https://github.com/moby3012/feedferret)",
            Accept: "text/html,application/xhtml+xml",
        },
        signal: AbortSignal.timeout(12_000),
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch article: ${response.status}`);
    }

    const html = await response.text();
    const { JSDOM } = await import("jsdom");
    const { default: DOMPurify } = await import("isomorphic-dompurify");
    const dom = new JSDOM(html, { url: article.link });
    const document = dom.window.document;

    document.querySelectorAll("script, style, nav, footer, header, aside, form, iframe, noscript, svg").forEach((node) => node.remove());
    document.querySelectorAll("a[href], img[src]").forEach((node) => {
        const attr = node instanceof dom.window.HTMLImageElement ? "src" : "href";
        const value = node.getAttribute(attr);
        if (!value) return;
        try {
            node.setAttribute(attr, new URL(value, article.link).toString());
        } catch {
            // Ignore malformed URLs.
        }
    });

    const selectors = [
        "article",
        "main",
        "[role='main']",
        ".post-content",
        ".entry-content",
        ".article-content",
        ".content",
    ];

    const candidates = selectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .concat(Array.from(document.body.children));

    const best = candidates
        .map((element) => ({
            element,
            score:
                (element.textContent?.trim().length || 0) +
                element.querySelectorAll("p").length * 250 -
                element.querySelectorAll("a").length * 20,
        }))
        .sort((a, b) => b.score - a.score)[0]?.element;

    if (!best) throw new Error("Could not extract article content");

    const sanitized = DOMPurify.sanitize(best.innerHTML, {
        ADD_ATTR: ["target", "rel"],
    }).trim();
    const plain = DOMPurify.sanitize(sanitized, { ALLOWED_TAGS: [] }).replace(/\s+/g, " ").trim();

    if (plain.length < 400 || plain.length <= (article.content || "").replace(/<[^>]*>?/gm, "").length) {
        throw new Error("Full text could not improve this article");
    }

    return await db.article.update({
        where: { id: article.id, userId: session.user.id },
        data: {
            content: sanitized,
            excerpt: plain.slice(0, 240),
        },
        include: {
            feed: true,
            labels: { include: { label: true } },
        },
    });
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

    await db.article.updateMany({
        where,
        data: { isRead: true, readAt: new Date() },
    });

    revalidatePath("/");
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

export async function createAutoReadRule(data: {
    name: string;
    query: string;
    action: string;
}) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    if (!data.name.trim() || !data.query.trim() || !data.action.trim()) {
        throw new Error("Name, query and action are required");
    }
    const rule = await db.autoReadRule.create({
        data: {
            userId: session.user.id,
            name: data.name.trim(),
            query: data.query.trim(),
            action: data.action.trim(),
        },
    });
    revalidatePath("/");
    return rule;
}

export async function updateAutoReadRule(
    ruleId: string,
    data: Partial<{ name: string; query: string; action: string; enabled: boolean; order: number }>,
) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const rule = await db.autoReadRule.update({
        where: { id: ruleId, userId: session.user.id },
        data,
    });
    revalidatePath("/");
    return rule;
}

export async function deleteAutoReadRule(ruleId: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    await db.autoReadRule.delete({
        where: { id: ruleId, userId: session.user.id },
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

export async function previewAutoReadRule(query: string, limit = 10) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const { previewAutoReadRuleMatches } = await import("@/lib/auto-read-rules");
    return previewAutoReadRuleMatches(session.user.id, query, limit);
}

export async function previewFeedExtraction(feedId: string, articleUrl: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const feed = await db.feed.findFirst({
        where: { id: feedId, userId: session.user.id },
        select: { fullTextSelector: true, fullTextRemoveSelectors: true },
    });
    if (!feed) throw new Error("Feed not found");

    const response = await fetch(articleUrl, {
        headers: {
            "User-Agent": "FeedFerret/1.0",
            Accept: "text/html,application/xhtml+xml",
        },
        signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);

    const html = await response.text();
    const { JSDOM } = await import("jsdom");
    const { default: DOMPurify } = await import("isomorphic-dompurify");
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

    let best: Element | undefined;
    if (feed.fullTextSelector) {
        best = document.querySelector(feed.fullTextSelector) ?? undefined;
    }
    if (!best) {
        const candidates = ["article", "main", "[role='main']", ".post-content", ".entry-content", ".article-content", ".content"]
            .flatMap((s) => Array.from(document.querySelectorAll(s)))
            .concat(Array.from(document.body.children));
        best = candidates
            .map((el) => ({
                el,
                score: (el.textContent?.trim().length || 0) + el.querySelectorAll("p").length * 250 - el.querySelectorAll("a").length * 20,
            }))
            .sort((a, b) => b.score - a.score)[0]?.el;
    }

    if (!best) throw new Error("Could not find article content");

    const sanitized = DOMPurify.sanitize(best.innerHTML, { ADD_ATTR: ["target", "rel"] }).trim();
    const plain = DOMPurify.sanitize(sanitized, { ALLOWED_TAGS: [] }).replace(/\s+/g, " ").trim();

    return {
        html: sanitized.slice(0, 50_000),
        charCount: plain.length,
        selectorUsed: feed.fullTextSelector || "(auto-detect)",
    };
}
