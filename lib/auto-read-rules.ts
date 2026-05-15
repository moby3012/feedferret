import { db } from "./db";
import { buildAdvancedSearchWhere } from "./search";
import { enqueueWebhookDelivery } from "./webhooks";
import { sendPushToUser } from "./push";
import { sendSystemEmail } from "./mail";

export type RuleAction = string;

export function parseRuleActions(rule: { action: string; actions?: string | null }): RuleAction[] {
    if (rule.actions) {
        try {
            const parsed = JSON.parse(rule.actions);
            if (Array.isArray(parsed)) {
                const list = parsed.filter((item) => typeof item === "string" && item.trim().length > 0);
                if (list.length) return list;
            }
        } catch {}
    }
    if (rule.action) return [rule.action];
    return ["mark_read"];
}

function scopeWhere(scope: string | null | undefined): any {
    if (!scope || scope === "all") return {};
    if (scope.startsWith("feed:")) return { feedId: scope.slice("feed:".length) };
    if (scope.startsWith("category:")) {
        return { feed: { categoryId: scope.slice("category:".length) } };
    }
    return {};
}

type MatchArticle = {
    id: string;
    title: string;
    link: string;
    excerpt: string | null;
    publishedAt: Date;
    isRead: boolean;
    isStarred: boolean;
    isReadLater: boolean;
    feed: { id: string; name: string };
};

async function applySingleAction(
    userId: string,
    rule: { id: string; name: string; query: string },
    action: RuleAction,
    matches: MatchArticle[],
    cache: { userEmail?: string | null },
): Promise<number> {
    if (matches.length === 0) return 0;

    if (action === "mark_read") {
        const ids = matches.filter((a) => !a.isRead).map((a) => a.id);
        if (ids.length === 0) return 0;
        await db.article.updateMany({
            where: { id: { in: ids } },
            data: { isRead: true, readAt: new Date() },
        });
        for (const a of matches) if (ids.includes(a.id)) a.isRead = true;
        return ids.length;
    }

    if (action === "mark_unread") {
        const ids = matches.filter((a) => a.isRead).map((a) => a.id);
        if (ids.length === 0) return 0;
        await db.article.updateMany({
            where: { id: { in: ids } },
            data: { isRead: false, readAt: null },
        });
        for (const a of matches) if (ids.includes(a.id)) a.isRead = false;
        return ids.length;
    }

    if (action === "star") {
        const ids = matches.filter((a) => !a.isStarred).map((a) => a.id);
        if (ids.length === 0) return 0;
        await db.article.updateMany({ where: { id: { in: ids } }, data: { isStarred: true } });
        for (const a of matches) if (ids.includes(a.id)) a.isStarred = true;
        return ids.length;
    }

    if (action === "unstar") {
        const ids = matches.filter((a) => a.isStarred).map((a) => a.id);
        if (ids.length === 0) return 0;
        await db.article.updateMany({ where: { id: { in: ids } }, data: { isStarred: false } });
        for (const a of matches) if (ids.includes(a.id)) a.isStarred = false;
        return ids.length;
    }

    if (action === "read_later") {
        const ids = matches.filter((a) => !a.isReadLater).map((a) => a.id);
        if (ids.length === 0) return 0;
        await db.article.updateMany({ where: { id: { in: ids } }, data: { isReadLater: true } });
        for (const a of matches) if (ids.includes(a.id)) a.isReadLater = true;
        return ids.length;
    }

    if (action === "remove_read_later") {
        const ids = matches.filter((a) => a.isReadLater).map((a) => a.id);
        if (ids.length === 0) return 0;
        await db.article.updateMany({ where: { id: { in: ids } }, data: { isReadLater: false } });
        for (const a of matches) if (ids.includes(a.id)) a.isReadLater = false;
        return ids.length;
    }

    if (action === "delete") {
        const ids = matches.map((a) => a.id);
        await db.article.deleteMany({ where: { id: { in: ids } } });
        return ids.length;
    }

    if (action === "mark_spoiler") {
        const ids = matches.map((a) => a.id);
        if (ids.length === 0) return 0;
        await db.article.updateMany({
            where: { id: { in: ids }, isSpoiler: false },
            data: { isSpoiler: true, spoilerAt: new Date() },
        });
        return ids.length;
    }

    if (action === "remove_spoiler") {
        const ids = matches.map((a) => a.id);
        if (ids.length === 0) return 0;
        await db.article.updateMany({
            where: { id: { in: ids }, isSpoiler: true },
            data: { isSpoiler: false, spoilerAt: null },
        });
        return ids.length;
    }

    if (action.startsWith("label:")) {
        const labelId = action.slice("label:".length);
        const label = await db.label.findFirst({ where: { id: labelId, userId } });
        if (!label) return 0;
        let added = 0;
        for (const a of matches) {
            const existing = await db.articleLabel.findUnique({
                where: { articleId_labelId: { articleId: a.id, labelId } },
            });
            if (existing) continue;
            await db.articleLabel.create({ data: { articleId: a.id, labelId, userId } });
            added += 1;
        }
        return added;
    }

    if (action.startsWith("remove_label:")) {
        const labelId = action.slice("remove_label:".length);
        const result = await db.articleLabel.deleteMany({
            where: { userId, labelId, articleId: { in: matches.map((a) => a.id) } },
        });
        return result.count;
    }

    if (action === "clear_labels") {
        const result = await db.articleLabel.deleteMany({
            where: { userId, articleId: { in: matches.map((a) => a.id) } },
        });
        return result.count;
    }

    if (action.startsWith("webhook:")) {
        const webhookId = action.slice("webhook:".length);
        const webhook = await db.webhook.findFirst({
            where: { id: webhookId, userId, enabled: true },
            select: { id: true },
        });
        if (!webhook) return 0;
        for (const article of matches) {
            await enqueueWebhookDelivery(webhook.id, "rule_match", {
                ruleId: rule.id,
                ruleName: rule.name,
                article: {
                    id: article.id,
                    title: article.title,
                    link: article.link,
                    excerpt: article.excerpt,
                    publishedAt: article.publishedAt,
                    feed: article.feed,
                },
            });
        }
        return matches.length;
    }

    if (action === "notify_inapp") {
        const now = new Date();
        await db.notification.createMany({
            data: matches.map((article) => ({
                userId,
                type: "rule_match",
                title: rule.name,
                body: `${article.title} · ${article.feed.name}`,
                articleId: article.id,
                feedId: article.feed.id,
                ruleId: rule.id,
                createdAt: now,
            })),
        });
        return matches.length;
    }

    if (action === "notify_push") {
        const first = matches[0];
        await sendPushToUser(userId, {
            title: `Rule: ${rule.name}`,
            body: matches.length === 1 ? first.title : `${matches.length} matching articles`,
            url: matches.length === 1 ? `/?article=${encodeURIComponent(first.id)}` : "/?view=new",
            articleId: matches.length === 1 ? first.id : undefined,
            feedId: matches.length === 1 ? first.feed.id : undefined,
            tag: `rule:${rule.id}`,
        }).catch((error) => console.warn("[auto-read-rules] push failed", error));
        return matches.length;
    }

    if (action === "notify_email") {
        if (cache.userEmail === undefined) {
            const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
            cache.userEmail = user?.email ?? null;
        }
        if (!cache.userEmail) return 0;
        const articleRows = matches
            .map((a) => `<li><a href="${a.link}">${a.title}</a> — ${a.feed.name}</li>`)
            .join("");
        const html = `<p>Rule <strong>${rule.name}</strong> matched ${matches.length} article${matches.length > 1 ? "s" : ""}:</p><ul>${articleRows}</ul>`;
        const text =
            `Rule "${rule.name}" matched:\n` +
            matches.map((a) => `- ${a.title} (${a.feed.name})\n  ${a.link}`).join("\n");
        try {
            await sendSystemEmail({
                to: cache.userEmail,
                subject: `Rule fired: ${rule.name}`,
                html,
                text,
            });
        } catch (e) {
            console.warn("[auto-read-rules] email failed:", e);
        }
        return matches.length;
    }

    return 0;
}

export async function applyAutoReadRules(
    userId: string,
    options: { onlyArticleIds?: string[] } = {},
): Promise<{ applied: number }> {
    const rules = await db.autoReadRule.findMany({
        where: { userId, enabled: true },
        orderBy: { order: "asc" },
    });

    if (rules.length === 0) return { applied: 0 };

    let applied = 0;

    for (const rule of rules) {
        const searchWhere = await buildAdvancedSearchWhere(userId, rule.query);
        if (!Object.keys(searchWhere).length) continue;

        const baseWhere: any = { userId, ...scopeWhere(rule.scope), ...searchWhere };
        if (options.onlyArticleIds && options.onlyArticleIds.length > 0) {
            baseWhere.id = { in: options.onlyArticleIds };
        }

        try {
            const matches = await db.article.findMany({
                where: baseWhere,
                select: {
                    id: true,
                    title: true,
                    link: true,
                    excerpt: true,
                    publishedAt: true,
                    isRead: true,
                    isStarred: true,
                    isReadLater: true,
                    feed: { select: { id: true, name: true } },
                },
                orderBy: { publishedAt: "desc" },
                take: 500,
            });

            if (matches.length === 0) continue;

            const actions = parseRuleActions(rule);
            const cache: { userEmail?: string | null } = {};
            let ruleApplied = 0;
            const liveMatches = [...matches];

            for (const action of actions) {
                ruleApplied += await applySingleAction(userId, rule, action, liveMatches, cache);
                if (action === "delete") break; // No further actions after delete
            }

            applied += ruleApplied;

            if (ruleApplied > 0) {
                await db.autoReadRule.update({
                    where: { id: rule.id },
                    data: { lastTriggeredAt: new Date() },
                });
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
    scope: string | null = null,
    limit = 10,
): Promise<{ id: string; title: string; feedName: string; publishedAt: Date }[]> {
    const searchWhere = await buildAdvancedSearchWhere(userId, query);
    if (!Object.keys(searchWhere).length) return [];

    const articles = await db.article.findMany({
        where: { userId, ...scopeWhere(scope), ...searchWhere },
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
