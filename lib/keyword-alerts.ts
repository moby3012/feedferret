import { db } from "@/lib/db";
import { buildAdvancedSearchWhere } from "@/lib/search";
import { sendPushToUser } from "@/lib/push";

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

  for (const alert of alerts) {
    const searchWhere = await buildAdvancedSearchWhere(userId, alert.query);
    const matches = await db.article.findMany({
      where: {
        userId,
        id: { in: articleIds },
        ...scopeWhere(alert.scope),
        ...searchWhere,
      },
      include: { feed: { select: { id: true, name: true } } },
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
