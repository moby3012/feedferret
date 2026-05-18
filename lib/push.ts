import { db } from "@/lib/db";
import webpush, { type PushSubscription as WebPushSubscription } from "web-push";
import { logger } from "@/lib/logger";

export type BrowserPushPayload = {
  title: string;
  body?: string;
  url?: string;
  articleId?: string;
  feedId?: string;
  unreadCount?: number;
  tag?: string;
};

let configured = false;

export function getVapidPublicKey() {
  return process.env.WEB_PUSH_VAPID_PUBLIC_KEY || "";
}

export function hasPushConfig() {
  return Boolean(
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY &&
      process.env.WEB_PUSH_VAPID_PRIVATE_KEY &&
      process.env.WEB_PUSH_CONTACT,
  );
}

function configureWebPush() {
  if (configured || !hasPushConfig()) return;
  webpush.setVapidDetails(
    process.env.WEB_PUSH_CONTACT!,
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY!,
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY!,
  );
  configured = true;
}

function toWebPushSubscription(subscription: {
  endpoint: string;
  p256dh: string;
  auth: string;
}): WebPushSubscription {
  return {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.p256dh,
      auth: subscription.auth,
    },
  };
}

function isGone(error: unknown) {
  const statusCode = (error as { statusCode?: number })?.statusCode;
  return statusCode === 404 || statusCode === 410;
}

export async function sendPushToUser(userId: string, payload: BrowserPushPayload) {
  if (!hasPushConfig()) {
    return { skipped: true, reason: "missing_vapid_config", sent: 0, failed: 0, disabled: 0 };
  }
  configureWebPush();

  const subscriptions = await db.pushSubscription.findMany({
    where: { userId, disabledAt: null },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });

  let sent = 0;
  let failed = 0;
  let disabled = 0;
  const body = JSON.stringify(payload);

  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(toWebPushSubscription(subscription), body);
      sent += 1;
      await db.pushSubscription.update({
        where: { id: subscription.id },
        data: { lastUsedAt: new Date() },
      });
    } catch (error) {
      failed += 1;
      if (isGone(error)) {
        disabled += 1;
        await db.pushSubscription.update({
          where: { id: subscription.id },
          data: { disabledAt: new Date() },
        });
      } else {
        logger.warn("[push] send failed", error);
      }
    }
  }

  return { skipped: false, sent, failed, disabled };
}

export async function getActivePushSubscriptionCount(userId: string) {
  return db.pushSubscription.count({ where: { userId, disabledAt: null } });
}
