import { db } from "@/lib/db";
import { sendPushToUser, type BrowserPushPayload } from "@/lib/push";

function parseFeedIds(value: string | null): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : null;
  } catch {
    return null;
  }
}

function minimumIntervalMs(frequency: string) {
  if (frequency === "daily") return 24 * 60 * 60 * 1000;
  if (frequency === "hourly") return 60 * 60 * 1000;
  return 0;
}

function isDue(lastSentAt: Date | null, frequency: string) {
  const interval = minimumIntervalMs(frequency);
  if (interval === 0) return true;
  if (!lastSentAt) return true;
  return Date.now() - lastSentAt.getTime() >= interval;
}

async function unreadCount(userId: string) {
  return db.article.count({ where: { userId, isRead: false } });
}

async function buildPayload(userId: string, articles: Array<{ id: string; title: string; feedId: string; feed: { name: string } }>, includeTitles: boolean): Promise<BrowserPushPayload> {
  const count = articles.length;
  const first = articles[0];
  const countText = count === 1 ? "1 neuer Artikel" : `${count} neue Artikel`;

  return {
    title: count === 1 && includeTitles ? first.title : countText,
    body: count === 1
      ? includeTitles
        ? first.feed.name
        : "Ein neuer Artikel ist verfügbar."
      : includeTitles
        ? articles.slice(0, 3).map((article) => article.title).join(" · ")
        : "Neue Artikel sind verfügbar.",
    url: count === 1 ? `/?article=${encodeURIComponent(first.id)}` : "/?view=new",
    articleId: count === 1 ? first.id : undefined,
    feedId: count === 1 ? first.feedId : undefined,
    unreadCount: await unreadCount(userId),
    tag: count === 1 ? `article:${first.id}` : "feedferret:new-articles",
  };
}

export async function queueNewArticleNotifications(userId: string, articleIds: string[]) {
  if (articleIds.length === 0) return { skipped: true, reason: "no_articles" };

  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      pushEnabled: true,
      pushFrequency: true,
      pushFeedIds: true,
      pushPrivatePayloads: true,
      pushLastSentAt: true,
      _count: { select: { pushSubscriptions: { where: { disabledAt: null } } } },
    },
  });

  if (!user?.pushEnabled || user.pushFrequency === "off") return { skipped: true, reason: "disabled" };
  if (user._count.pushSubscriptions === 0) return { skipped: true, reason: "no_subscriptions" };

  const allowedFeedIds = parseFeedIds(user.pushFeedIds);
  const articles = await db.article.findMany({
    where: {
      userId,
      id: { in: articleIds },
      ...(allowedFeedIds ? { feedId: { in: allowedFeedIds } } : {}),
    },
    include: { feed: { select: { name: true } } },
    orderBy: { publishedAt: "desc" },
    take: 10,
  });

  if (articles.length === 0) return { skipped: true, reason: "filtered" };

  if (user.pushFrequency !== "immediate" && !isDue(user.pushLastSentAt, user.pushFrequency)) {
    return { skipped: true, reason: "not_due" };
  }

  const payload = await buildPayload(userId, articles, user.pushPrivatePayloads);
  const result = await sendPushToUser(userId, payload);
  if (!result.skipped && result.sent > 0) {
    await db.user.update({ where: { id: userId }, data: { pushLastSentAt: new Date() } });
  }
  return result;
}

export async function flushDueNotifications() {
  const users = await db.user.findMany({
    where: {
      pushEnabled: true,
      pushFrequency: { in: ["hourly", "daily"] },
      pushSubscriptions: { some: { disabledAt: null } },
    },
    select: {
      id: true,
      pushFrequency: true,
      pushFeedIds: true,
      pushPrivatePayloads: true,
      pushLastSentAt: true,
    },
  });

  let sentUsers = 0;
  for (const user of users) {
    if (!isDue(user.pushLastSentAt, user.pushFrequency)) continue;
    const since = user.pushLastSentAt ?? new Date(Date.now() - minimumIntervalMs(user.pushFrequency));
    const allowedFeedIds = parseFeedIds(user.pushFeedIds);
    const articles = await db.article.findMany({
      where: {
        userId: user.id,
        isRead: false,
        createdAt: { gt: since },
        ...(allowedFeedIds ? { feedId: { in: allowedFeedIds } } : {}),
      },
      include: { feed: { select: { name: true } } },
      orderBy: { publishedAt: "desc" },
      take: 10,
    });
    if (articles.length === 0) continue;

    const payload = await buildPayload(user.id, articles, user.pushPrivatePayloads);
    const result = await sendPushToUser(user.id, payload);
    if (!result.skipped && result.sent > 0) {
      sentUsers += 1;
      await db.user.update({ where: { id: user.id }, data: { pushLastSentAt: new Date() } });
    }
  }
  return { sentUsers };
}

export async function sendTestPushNotification(userId: string) {
  const payload: BrowserPushPayload = {
    title: "FeedFerret Test",
    body: "Browser notifications are working.",
    url: "/settings",
    unreadCount: await unreadCount(userId),
    tag: "feedferret:test",
  };
  return sendPushToUser(userId, payload);
}
