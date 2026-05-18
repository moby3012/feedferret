import { db } from "@/lib/db";
import { buildAdvancedSearchWhere } from "@/lib/search";
import { sendPushToUser } from "@/lib/push";
import { sendSystemEmail } from "@/lib/mail";
import {
  sendTelegramNotification,
  sendGotifyNotification,
  sendNtfyNotification,
} from "@/lib/notification-channels";

function parseActions(value: string | null | undefined) {
  if (!value) return ["notify_inapp"];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : ["notify_inapp"];
  } catch {
    return ["notify_inapp"];
  }
}

function scopeWhere(scope: string) {
  if (scope.startsWith("feed:")) return { feedId: scope.slice("feed:".length) };
  if (scope.startsWith("category:")) {
    return { feed: { categoryId: scope.slice("category:".length) } };
  }
  return {};
}

export async function applyKeywordAlerts(userId: string, articleIds: string[]) {
  if (articleIds.length === 0) return { alertsChecked: 0, notificationsCreated: 0 };

  const alerts = await db.keywordAlert.findMany({
    where: { userId, enabled: true },
    orderBy: { createdAt: "asc" },
  });

  let notificationsCreated = 0;
  let userEmail: string | null | undefined = undefined;
  let channelConfig:
    | {
        telegram: { enabled: boolean; botToken: string | null; chatId: string | null };
        gotify: { enabled: boolean; url: string | null; token: string | null };
        ntfy: { enabled: boolean; url: string | null; token: string | null };
      }
    | undefined = undefined;

  async function loadChannels() {
    if (channelConfig !== undefined) return channelConfig;
    const u = await db.user.findUnique({
      where: { id: userId },
      select: {
        telegramEnabled: true, telegramBotToken: true, telegramChatId: true,
        gotifyEnabled: true, gotifyUrl: true, gotifyToken: true,
        ntfyEnabled: true, ntfyUrl: true, ntfyToken: true,
      },
    });
    channelConfig = {
      telegram: { enabled: u?.telegramEnabled ?? false, botToken: u?.telegramBotToken ?? null, chatId: u?.telegramChatId ?? null },
      gotify: { enabled: u?.gotifyEnabled ?? false, url: u?.gotifyUrl ?? null, token: u?.gotifyToken ?? null },
      ntfy: { enabled: u?.ntfyEnabled ?? false, url: u?.ntfyUrl ?? null, token: u?.ntfyToken ?? null },
    };
    return channelConfig;
  }

  for (const alert of alerts) {
    const searchWhere = await buildAdvancedSearchWhere(userId, alert.query);
    const matches = await db.article.findMany({
      where: {
        userId,
        id: { in: articleIds },
        ...scopeWhere(alert.scope),
        ...searchWhere,
      },
      select: { id: true, title: true, link: true, publishedAt: true, feed: { select: { id: true, name: true } } },
      orderBy: { publishedAt: "desc" },
      take: 50,
    });

    if (matches.length === 0) continue;

    const actions = parseActions(alert.actions);
    const now = new Date();

    if (actions.includes("notify_inapp")) {
      await db.notification.createMany({
        data: matches.map((article) => ({
          userId,
          type: "keyword_alert",
          title: alert.name,
          body: `${article.title} · ${article.feed.name}`,
          articleId: article.id,
          feedId: article.feed.id,
          alertId: alert.id,
          createdAt: now,
        })),
      });
      notificationsCreated += matches.length;
    }

    if (actions.includes("notify_push")) {
      const first = matches[0];
      await sendPushToUser(userId, {
        title: `Keyword alert: ${alert.name}`,
        body: matches.length === 1 ? first.title : `${matches.length} matching articles`,
        url: matches.length === 1 ? `/?article=${encodeURIComponent(first.id)}` : "/?view=new",
        articleId: matches.length === 1 ? first.id : undefined,
        feedId: matches.length === 1 ? first.feed.id : undefined,
        tag: `keyword-alert:${alert.id}`,
      }).catch((error) => console.warn("[keyword-alerts] push failed", error));
    }

    if (actions.includes("notify_email")) {
      // Lazy-load user email once
      if (userEmail === undefined) {
        const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
        userEmail = user?.email ?? null;
      }
      if (userEmail) {
        const articleRows = matches
          .map((a) => `<li><a href="${a.link}">${a.title}</a> — ${a.feed.name}</li>`)
          .join("");
        const html = `<p>Keyword alert <strong>${alert.name}</strong> matched ${matches.length} article${matches.length > 1 ? "s" : ""}:</p><ul>${articleRows}</ul>`;
        const text = `Keyword alert "${alert.name}" matched:\n` + matches.map((a) => `- ${a.title} (${a.feed.name})\n  ${a.link}`).join("\n");
        sendSystemEmail({
          to: userEmail,
          subject: `Keyword alert: ${alert.name}`,
          html,
          text,
        }).catch((e) => console.warn("[keyword-alerts] email failed:", e));
      }
    }

    if (actions.includes("notify_telegram")) {
      const ch = await loadChannels();
      if (ch.telegram.enabled && ch.telegram.botToken && ch.telegram.chatId) {
        const first = matches[0];
        const body =
          matches.length === 1
            ? first.title
            : `${matches.length} matching articles`;
        sendTelegramNotification(
          { botToken: ch.telegram.botToken, chatId: ch.telegram.chatId },
          { title: `Keyword alert: ${alert.name}`, body, url: matches.length === 1 ? first.link : undefined },
        ).catch((e) => console.warn("[keyword-alerts] telegram failed:", e));
      }
    }

    if (actions.includes("notify_gotify")) {
      const ch = await loadChannels();
      if (ch.gotify.enabled && ch.gotify.url && ch.gotify.token) {
        const first = matches[0];
        const body =
          matches.length === 1
            ? first.title
            : matches.map((a) => `• ${a.title}`).join("\n");
        sendGotifyNotification(
          { url: ch.gotify.url, token: ch.gotify.token },
          { title: `Keyword alert: ${alert.name}`, body, url: matches.length === 1 ? first.link : undefined },
        ).catch((e) => console.warn("[keyword-alerts] gotify failed:", e));
      }
    }

    if (actions.includes("notify_ntfy")) {
      const ch = await loadChannels();
      if (ch.ntfy.enabled && ch.ntfy.url) {
        const first = matches[0];
        const body =
          matches.length === 1
            ? first.title
            : matches.map((a) => `• ${a.title}`).join("\n");
        sendNtfyNotification(
          { url: ch.ntfy.url, token: ch.ntfy.token ?? undefined },
          { title: `Keyword alert: ${alert.name}`, body, url: matches.length === 1 ? first.link : undefined },
        ).catch((e) => console.warn("[keyword-alerts] ntfy failed:", e));
      }
    }

    await db.keywordAlert.update({
      where: { id: alert.id },
      data: { lastTriggeredAt: now },
    });
  }

  return { alertsChecked: alerts.length, notificationsCreated };
}

export async function previewKeywordAlert(userId: string, query: string, scope = "all", limit = 10) {
  const searchWhere = await buildAdvancedSearchWhere(userId, query);
  if (!Object.keys(searchWhere).length) return [];

  const articles = await db.article.findMany({
    where: {
      userId,
      ...scopeWhere(scope),
      ...searchWhere,
    },
    select: {
      id: true,
      title: true,
      publishedAt: true,
      feed: { select: { name: true } },
    },
    orderBy: { publishedAt: "desc" },
    take: limit,
  });

  return articles.map((article) => ({
    id: article.id,
    title: article.title,
    feedName: article.feed.name,
    publishedAt: article.publishedAt,
  }));
}
