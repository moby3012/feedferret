import { db } from "./db";
import { buildAdvancedSearchWhere } from "./search";
import { executeWebhookCall, getWebhookConfig } from "./webhooks";
import { sendPushToUser } from "./push";
import { sendSystemEmail } from "./mail";
import {
  sendTelegramNotification,
  sendGotifyNotification,
  sendNtfyNotification,
} from "./notification-channels";

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

type ChannelCache = {
    userEmail?: string | null;
    channels?: {
        telegram: { enabled: boolean; botToken: string | null; chatId: string | null };
        gotify: { enabled: boolean; url: string | null; token: string | null };
        ntfy: { enabled: boolean; url: string | null; token: string | null };
    };
};

async function loadChannelConfig(userId: string, cache: ChannelCache) {
    if (cache.channels !== undefined) return cache.channels;
    const u = await db.user.findUnique({
        where: { id: userId },
        select: {
            telegramEnabled: true, telegramBotToken: true, telegramChatId: true,
            gotifyEnabled: true, gotifyUrl: true, gotifyToken: true,
            ntfyEnabled: true, ntfyUrl: true, ntfyToken: true,
        },
    });
    cache.channels = {
        telegram: { enabled: u?.telegramEnabled ?? false, botToken: u?.telegramBotToken ?? null, chatId: u?.telegramChatId ?? null },
        gotify: { enabled: u?.gotifyEnabled ?? false, url: u?.gotifyUrl ?? null, token: u?.gotifyToken ?? null },
        ntfy: { enabled: u?.ntfyEnabled ?? false, url: u?.ntfyUrl ?? null, token: u?.ntfyToken ?? null },
    };
    return cache.channels;
}

async function applySingleAction(
    userId: string,
    rule: { id: string; name: string; query: string },
    action: RuleAction,
    matches: MatchArticle[],
    cache: ChannelCache,
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
            data: { isSpoiler: true, spoilerAt: new Date(), spoilerRuleId: rule.id },
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

    if (action.startsWith("webhook_call:")) {
        const indexStr = action.slice("webhook_call:".length);
        const idx = Number.parseInt(indexStr, 10);
        if (!Number.isFinite(idx) || idx < 0) return 0;
        const config = getWebhookConfig({ webhookConfigs: (rule as any).webhookConfigs ?? null }, idx);
        if (!config) return 0;
        let fired = 0;
        const now = new Date();
        for (const article of matches) {
            const result = await executeWebhookCall(config, {
                event: "rule_match",
                timestamp: now.toISOString(),
                rule_id: rule.id,
                rule_name: rule.name,
                article_id: article.id,
                article_title: article.title,
                article_link: article.link,
                article_excerpt: article.excerpt ?? "",
                published_at: article.publishedAt.toISOString(),
                feed_id: article.feed.id,
                feed_name: article.feed.name,
            });
            if (result.ok) fired += 1;
            else console.warn(`[auto-read-rules] webhook ${config.url} failed (${result.status ?? "no-response"}): ${result.error}`);
        }
        return fired;
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

    if (action === "notify_telegram") {
        const ch = await loadChannelConfig(userId, cache);
        if (!ch.telegram.enabled || !ch.telegram.botToken || !ch.telegram.chatId) return 0;
        const first = matches[0];
        const body = matches.length === 1 ? first.title : `${matches.length} matching articles`;
        await sendTelegramNotification(
            { botToken: ch.telegram.botToken, chatId: ch.telegram.chatId },
            { title: `Rule: ${rule.name}`, body, url: matches.length === 1 ? first.link : undefined },
        ).catch((e) => console.warn("[auto-read-rules] telegram failed:", e));
        return matches.length;
    }

    if (action === "notify_gotify") {
        const ch = await loadChannelConfig(userId, cache);
        if (!ch.gotify.enabled || !ch.gotify.url || !ch.gotify.token) return 0;
        const first = matches[0];
        const body = matches.length === 1 ? first.title : matches.map((a) => `• ${a.title}`).join("\n");
        await sendGotifyNotification(
            { url: ch.gotify.url, token: ch.gotify.token },
            { title: `Rule: ${rule.name}`, body, url: matches.length === 1 ? first.link : undefined },
        ).catch((e) => console.warn("[auto-read-rules] gotify failed:", e));
        return matches.length;
    }

    if (action === "notify_ntfy") {
        const ch = await loadChannelConfig(userId, cache);
        if (!ch.ntfy.enabled || !ch.ntfy.url) return 0;
        const first = matches[0];
        const body = matches.length === 1 ? first.title : matches.map((a) => `• ${a.title}`).join("\n");
        await sendNtfyNotification(
            { url: ch.ntfy.url, token: ch.ntfy.token ?? undefined },
            { title: `Rule: ${rule.name}`, body, url: matches.length === 1 ? first.link : undefined },
        ).catch((e) => console.warn("[auto-read-rules] ntfy failed:", e));
        return matches.length;
    }

    return 0;
}

export async function applyAutoReadRules(
    userId: string,
    options: { onlyArticleIds?: string[] } = {},
): Promise<{ applied: number }> {
    const rules = await db.autoReadRule.findMany({
        where: { userId, enabled: true, trigger: "article" },
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

export async function applyFeedErrorRules(
    userId: string,
    payload: { feedId: string; feedName: string; feedUrl: string; error: string },
): Promise<{ fired: number }> {
    const rules = await db.autoReadRule.findMany({
        where: { userId, enabled: true, trigger: "feed_error" },
        orderBy: { order: "asc" },
    });
    if (rules.length === 0) return { fired: 0 };

    let fired = 0;
    const now = new Date();

    for (const rule of rules) {
        // Scope filter: "all" matches every error, "feed:<id>" only that feed,
        // "category:<id>" only feeds inside that category.
        const scope = rule.scope ?? null;
        if (scope && scope !== "all") {
            if (scope.startsWith("feed:") && scope.slice(5) !== payload.feedId) continue;
            if (scope.startsWith("category:")) {
                const categoryId = scope.slice("category:".length);
                const feed = await db.feed.findUnique({
                    where: { id: payload.feedId },
                    select: { categoryId: true },
                });
                if (feed?.categoryId !== categoryId) continue;
            }
        }

        const actions = parseRuleActions(rule);
        const cache: { userEmail?: string | null } = {};
        let ruleFired = false;

        for (const action of actions) {
            if (action === "notify_inapp") {
                await db.notification.create({
                    data: {
                        userId,
                        type: "feed_error",
                        title: rule.name,
                        body: `${payload.feedName}: ${payload.error.slice(0, 280)}`,
                        feedId: payload.feedId,
                        ruleId: rule.id,
                        createdAt: now,
                    },
                });
                ruleFired = true;
            } else if (action === "notify_push") {
                await sendPushToUser(userId, {
                    title: `Feed error: ${rule.name}`,
                    body: `${payload.feedName} — ${payload.error.slice(0, 140)}`,
                    feedId: payload.feedId,
                    tag: `rule:${rule.id}`,
                }).catch((error) => console.warn("[auto-read-rules] push failed", error));
                ruleFired = true;
            } else if (action === "notify_email") {
                if (cache.userEmail === undefined) {
                    const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
                    cache.userEmail = user?.email ?? null;
                }
                if (cache.userEmail) {
                    const html = `<p>Rule <strong>${rule.name}</strong> matched a feed error:</p><p><strong>${payload.feedName}</strong> (<code>${payload.feedUrl}</code>)</p><pre>${payload.error}</pre>`;
                    const text = `Rule "${rule.name}" fired — feed error.\n${payload.feedName} (${payload.feedUrl})\n\n${payload.error}`;
                    try {
                        await sendSystemEmail({
                            to: cache.userEmail,
                            subject: `Feed error: ${payload.feedName}`,
                            html,
                            text,
                        });
                        ruleFired = true;
                    } catch (e) {
                        console.warn("[auto-read-rules] email failed:", e);
                    }
                }
            } else if (action.startsWith("webhook_call:")) {
                const indexStr = action.slice("webhook_call:".length);
                const idx = Number.parseInt(indexStr, 10);
                if (!Number.isFinite(idx) || idx < 0) continue;
                const config = getWebhookConfig({ webhookConfigs: rule.webhookConfigs }, idx);
                if (!config) continue;
                const result = await executeWebhookCall(config, {
                    event: "feed_error",
                    timestamp: now.toISOString(),
                    rule_id: rule.id,
                    rule_name: rule.name,
                    feed_id: payload.feedId,
                    feed_name: payload.feedName,
                    feed_url: payload.feedUrl,
                    error: payload.error,
                });
                if (result.ok) ruleFired = true;
                else console.warn(`[auto-read-rules] webhook ${config.url} failed (${result.status ?? "no-response"}): ${result.error}`);
            } else if (action === "notify_telegram") {
                const ch = await loadChannelConfig(userId, cache);
                if (ch.telegram.enabled && ch.telegram.botToken && ch.telegram.chatId) {
                    const res = await sendTelegramNotification(
                        { botToken: ch.telegram.botToken, chatId: ch.telegram.chatId },
                        { title: `Feed error: ${payload.feedName}`, body: payload.error.slice(0, 280) },
                    ).catch(() => ({ ok: false }));
                    if (res.ok) ruleFired = true;
                }
            } else if (action === "notify_gotify") {
                const ch = await loadChannelConfig(userId, cache);
                if (ch.gotify.enabled && ch.gotify.url && ch.gotify.token) {
                    const res = await sendGotifyNotification(
                        { url: ch.gotify.url, token: ch.gotify.token },
                        { title: `Feed error: ${payload.feedName}`, body: payload.error.slice(0, 280) },
                    ).catch(() => ({ ok: false }));
                    if (res.ok) ruleFired = true;
                }
            } else if (action === "notify_ntfy") {
                const ch = await loadChannelConfig(userId, cache);
                if (ch.ntfy.enabled && ch.ntfy.url) {
                    const res = await sendNtfyNotification(
                        { url: ch.ntfy.url, token: ch.ntfy.token ?? undefined },
                        { title: `Feed error: ${payload.feedName}`, body: payload.error.slice(0, 280) },
                    ).catch(() => ({ ok: false }));
                    if (res.ok) ruleFired = true;
                }
            }
            // Other action types are ignored for feed_error triggers.
        }

        if (ruleFired) {
            fired += 1;
            await db.autoReadRule.update({
                where: { id: rule.id },
                data: { lastTriggeredAt: now },
            });
        }
    }

    return { fired };
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
