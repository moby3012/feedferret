import { db } from "./db";

export interface ResolvedSettings {
    updateFrequency: number; // in minutes
}

/**
 * Resolves the effective settings for a feed based on the hierarchy:
 * Feed -> Subcategory -> Category -> User Global -> Site Default
 */
export async function getEffectiveSettings(userId: string, feedId: string): Promise<ResolvedSettings> {
    const feed = await db.feed.findUnique({
        where: { id: feedId, userId },
        include: {
            category: {
                include: {
                    parent: true,
                },
            },
            user: true,
        },
    });

    if (!feed) {
        throw new Error("Feed not found");
    }

    // 1. Check Feed Level
    if (feed.updateFrequency !== null) {
        return { updateFrequency: feed.updateFrequency };
    }

    // 2. Check Subcategory Level (if category has parent)
    if (feed.category && feed.category.parentId) {
        if (feed.category.updateFrequency !== null) {
            return { updateFrequency: feed.category.updateFrequency };
        }
    }

    // 3. Check Category Level (top-level or parent)
    if (feed.category) {
        const topLevelCategory = feed.category.parentId
            ? await db.category.findUnique({ where: { id: feed.category.parentId } })
            : feed.category;

        if (topLevelCategory?.updateFrequency !== null && topLevelCategory?.updateFrequency !== undefined) {
            return { updateFrequency: topLevelCategory.updateFrequency };
        }
    }

    // 4. Check User Global Level
    if (feed.user.defaultUpdateFrequency) {
        return { updateFrequency: feed.user.defaultUpdateFrequency };
    }

    // 5. Site Default
    return { updateFrequency: 60 };
}
