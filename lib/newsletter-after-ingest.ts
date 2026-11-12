// Side effects for newly stored newsletter items (like rss-sync): auto-read
// rules, keyword alerts, push. Shared by the IMAP poller and the webhook.
import { applyAutoReadRules } from "@/lib/auto-read-rules";
import { applyKeywordAlerts } from "@/lib/keyword-alerts";
import { queueNewArticleNotifications } from "@/lib/notifications";
import { logger } from "@/lib/logger";

export async function afterIngest(created: { userId: string; articleId: string }[], tag = "newsletter-imap") {
  const byUser = new Map<string, string[]>();
  for (const c of created) byUser.set(c.userId, [...(byUser.get(c.userId) ?? []), c.articleId]);
  for (const [userId, ids] of byUser) {
    await applyAutoReadRules(userId, { onlyArticleIds: ids }).catch((e) => logger.error(`[${tag}] auto-read rules failed:`, e));
    await applyKeywordAlerts(userId, ids).catch((e) => logger.error(`[${tag}] keyword alerts failed:`, e));
    await queueNewArticleNotifications(userId, ids).catch((e) => logger.error(`[${tag}] push queue failed:`, e));
  }
}
