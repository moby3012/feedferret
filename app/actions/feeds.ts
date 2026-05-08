"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { syncUserFeeds, syncFeed } from "@/lib/rss-sync";
import { parseOpml, generateOpml, OpmlOutline } from "@/lib/opml";
import Parser from "rss-parser";

const parser = new Parser();

export async function refreshAllFeeds() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const result = await syncUserFeeds(session.user.id);
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

export async function updateFeed(feedId: string, data: { name?: string; categoryId?: string | null; updateFrequency?: number | null; retentionDays?: number | null }) {
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

    return feeds.map((feed) => ({
        ...feed,
        unreadCount: unreadByFeed.get(feed.id) || 0,
        articleCount: feed._count.articles,
    }));
}

export async function applyRetentionPolicies() {
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
        const result = await db.article.deleteMany({
            where: {
                userId: user.id,
                feedId: feed.id,
                isRead: true,
                isStarred: false,
                publishedAt: { lt: cutoff },
            },
        });
        deleted += result.count;
    }

    revalidatePath("/");
    return { deleted };
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

function tokenizeSearch(query: string) {
    const tokens: string[] = [];
    const re = /"([^"]+)"|'([^']+)'|(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(query)) !== null) {
        tokens.push(match[1] || match[2] || match[3]);
    }
    return tokens;
}

function parseDateToken(value: string) {
    const now = new Date();
    const relative = value.match(/^(\d+)(d|w|m|y)$/i);
    if (relative) {
        const amount = Number(relative[1]);
        const unit = relative[2].toLowerCase();
        const date = new Date(now);
        if (unit === "d") date.setDate(date.getDate() - amount);
        if (unit === "w") date.setDate(date.getDate() - amount * 7);
        if (unit === "m") date.setMonth(date.getMonth() - amount);
        if (unit === "y") date.setFullYear(date.getFullYear() - amount);
        return date;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function buildAdvancedSearchWhere(userId: string, query?: string) {
    if (!query?.trim()) return {};

    const tokens = tokenizeSearch(query.trim());
    const and: any[] = [];
    const freeText: string[] = [];

    for (const rawToken of tokens) {
        const negated = rawToken.startsWith("-") || rawToken.startsWith("!");
        const token = negated ? rawToken.slice(1) : rawToken;
        const [rawKey, ...rest] = token.split(":");
        const hasField = rest.length > 0;
        const key = rawKey.toLowerCase();
        const value = hasField ? rest.join(":").trim() : token.trim();
        if (!value) continue;

        let condition: any | null = null;

        if (token.startsWith("#")) {
            condition = {
                labels: {
                    some: {
                        label: {
                            userId,
                            name: { contains: token.slice(1) },
                        },
                    },
                },
            };
        } else if (hasField) {
            if (["author", "by"].includes(key)) {
                condition = { author: { contains: value } };
            } else if (["intitle", "title"].includes(key)) {
                condition = { title: { contains: value } };
            } else if (["intext", "text", "content"].includes(key)) {
                condition = {
                    OR: [
                        { content: { contains: value } },
                        { excerpt: { contains: value } },
                    ],
                };
            } else if (["inurl", "url", "link"].includes(key)) {
                condition = { link: { contains: value } };
            } else if (["feed", "f"].includes(key)) {
                condition = {
                    feed: {
                        OR: [
                            { id: value },
                            { name: { contains: value } },
                            { url: { contains: value } },
                        ],
                    },
                };
            } else if (["category", "cat", "c"].includes(key)) {
                condition = {
                    feed: {
                        category: {
                            OR: [
                                { id: value },
                                { name: { contains: value } },
                            ],
                        },
                    },
                };
            } else if (["label", "tag"].includes(key)) {
                condition = {
                    labels: {
                        some: {
                            label: {
                                userId,
                                OR: [
                                    { id: value },
                                    { name: { contains: value } },
                                ],
                            },
                        },
                    },
                };
            } else if (key === "is" || key === "status") {
                const normalized = value.toLowerCase();
                if (["unread", "new"].includes(normalized)) condition = { isRead: false };
                if (["read"].includes(normalized)) condition = { isRead: true };
                if (["starred", "favorite", "favourite"].includes(normalized)) condition = { isStarred: true };
                if (["unstarred"].includes(normalized)) condition = { isStarred: false };
            } else if (["after", "since"].includes(key)) {
                const date = parseDateToken(value);
                if (date) condition = { publishedAt: { gte: date } };
            } else if (["before", "until"].includes(key)) {
                const date = parseDateToken(value);
                if (date) condition = { publishedAt: { lte: date } };
            } else if (key === "date" || key === "pubdate") {
                const date = parseDateToken(value);
                if (date) condition = { publishedAt: { gte: date } };
            }
        }

        if (!condition) {
            freeText.push(value);
            continue;
        }

        and.push(negated ? { NOT: condition } : condition);
    }

    for (const term of freeText) {
        and.push({
            OR: [
                { title: { contains: term } },
                { content: { contains: term } },
                { excerpt: { contains: term } },
                { author: { contains: term } },
                { link: { contains: term } },
                { feed: { name: { contains: term } } },
                { labels: { some: { label: { name: { contains: term }, userId } } } },
            ],
        });
    }

    return and.length ? { AND: and } : {};
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

export async function exportOpml() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const feeds = await db.feed.findMany({
        where: { userId: session.user.id },
    });

    return generateOpml(feeds);
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

    const processOutline = async (outline: OpmlOutline, categoryId?: string) => {
        if (outline.type === "rss" && outline.xmlUrl) {
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
                    name: outline.text,
                    categoryId,
                },
                create: {
                    userId: userId,
                    url: outline.xmlUrl,
                    name: outline.text,
                    categoryId,
                },
            });
            if (existing) report.feedsUpdated += 1;
            else report.feedsAdded += 1;
        } else if (outline.children) {
            const existingCategory = await db.category.findUnique({
                where: {
                    userId_name_parentId: {
                        userId: userId,
                        name: outline.text,
                        parentId: (categoryId || null) as any,
                    }
                },
            });
            const category = await db.category.upsert({
                where: {
                    userId_name_parentId: {
                        userId: userId,
                        name: outline.text,
                        parentId: (categoryId || null) as any,
                    }
                },
                update: {},
                create: {
                    userId: userId,
                    name: outline.text,
                    parentId: categoryId,
                }
            });
            if (existingCategory) report.categoriesUpdated += 1;
            else report.categoriesAdded += 1;

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
