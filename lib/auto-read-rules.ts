import { db } from "./db";
import { buildAdvancedSearchWhere } from "./search";

export async function applyAutoReadRules(userId: string): Promise<{ applied: number }> {
    const rules = await db.autoReadRule.findMany({
        where: { userId, enabled: true },
        orderBy: { order: "asc" },
    });

    if (rules.length === 0) return { applied: 0 };

    let applied = 0;

    for (const rule of rules) {
        const searchWhere = await buildAdvancedSearchWhere(userId, rule.query);
        const baseWhere: any = { userId, ...searchWhere };

        try {
            if (rule.action === "mark_read") {
                const result = await db.article.updateMany({
                    where: { ...baseWhere, isRead: false },
                    data: { isRead: true, readAt: new Date() },
                });
                applied += result.count;
            } else if (rule.action === "star") {
                const result = await db.article.updateMany({
                    where: { ...baseWhere, isStarred: false },
                    data: { isStarred: true },
                });
                applied += result.count;
            } else if (rule.action.startsWith("label:")) {
                const labelId = rule.action.slice("label:".length);
                const label = await db.label.findFirst({
                    where: { id: labelId, userId },
                });
                if (!label) continue;

                const articles = await db.article.findMany({
                    where: {
                        ...baseWhere,
                        labels: { none: { labelId } },
                    },
                    select: { id: true },
                    take: 500,
                });

                for (const a of articles) {
                    await db.articleLabel.upsert({
                        where: { articleId_labelId: { articleId: a.id, labelId } },
                        create: { articleId: a.id, labelId, userId },
                        update: {},
                    });
                }
                applied += articles.length;
            }
        } catch (error) {
            console.error(`[auto-read-rules] rule "${rule.name}" failed:`, error);
        }
    }

    return { applied };
}

export async function previewAutoReadRuleMatches(
    userId: string,
    query: string,
    limit = 10,
): Promise<{ id: string; title: string; feedName: string; publishedAt: Date }[]> {
    const searchWhere = await buildAdvancedSearchWhere(userId, query);
    if (!Object.keys(searchWhere).length) return [];

    const articles = await db.article.findMany({
        where: { userId, ...searchWhere },
        select: {
            id: true,
            title: true,
            publishedAt: true,
            feed: { select: { name: true } },
        },
        orderBy: { publishedAt: "desc" },
        take: limit,
    });

    return articles.map((a) => ({
        id: a.id,
        title: a.title,
        feedName: a.feed.name,
        publishedAt: a.publishedAt,
    }));
}
