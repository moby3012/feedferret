"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { syncAllFeeds, syncFeed } from "@/lib/rss-sync";
import { parseOpml, generateOpml, OpmlOutline } from "@/lib/opml";
import Parser from "rss-parser";

const parser = new Parser();

export async function refreshAllFeeds() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    await syncAllFeeds();
    revalidatePath("/");
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

export async function updateFeed(feedId: string, data: { name?: string; categoryId?: string | null }) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    await db.feed.update({
        where: { id: feedId, userId: session.user.id },
        data,
    });

    revalidatePath("/");
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
        data: { isRead },
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

export async function getArticles(feedId?: string | null, category?: string, search?: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const where: any = { userId: session.user.id };

    // Search filter
    if (search && search.trim()) {
        where.OR = [
            { title: { contains: search.trim() } },
            { content: { contains: search.trim() } },
            { excerpt: { contains: search.trim() } },
            { author: { contains: search.trim() } },
        ];
    }

    if (feedId) {
        where.feedId = feedId;
    } else if (category && category !== "All" && category !== "All Articles") {
        if (category === "Starred") {
            where.isStarred = true;
        } else if (category === "Recently Read") {
            where.isRead = true;
        } else if (category === "New Articles") {
            where.isRead = false;
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
        },
        orderBy: { publishedAt: "desc" },
        take: 100, // Limit results for performance
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

    const processOutline = async (outline: OpmlOutline, categoryId?: string) => {
        if (outline.type === "rss" && outline.xmlUrl) {
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
        } else if (outline.children) {
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

            for (const child of outline.children) {
                await processOutline(child, category.id);
            }
        }
    };

    for (const outline of outlines) {
        await processOutline(outline);
    }

    revalidatePath("/");
}
