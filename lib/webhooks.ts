import { createHmac, randomBytes } from "crypto";
import { db } from "./db";

export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

export function signPayload(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

export function verifyWebhookSignature(secret: string, body: string, signature: string): boolean {
  const expected = signPayload(secret, body);
  return signature === expected;
}

// Bounded exponential backoff: attempt index → delay ms before next retry
// Index 0 = first attempt (immediate), index 1 = after first failure, etc.
const RETRY_DELAYS_MS = [0, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 8 * 3_600_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;

export type WebhookEvent = "new_article" | "keyword_match" | "feed_error";

export async function dispatchWebhookEvent(
  userId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
  feedId?: string,
): Promise<void> {
  const webhooks = await db.webhook.findMany({
    where: { userId, enabled: true },
  });
  if (webhooks.length === 0) return;

  const payload = JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    data,
  });

  for (const webhook of webhooks) {
    const events: string[] = JSON.parse(webhook.events);
    if (!events.includes(event)) continue;

    if (feedId && webhook.feedFilter) {
      const allowed: string[] = JSON.parse(webhook.feedFilter);
      if (!allowed.includes(feedId)) continue;
    }

    await db.webhookDelivery.create({
      data: {
        webhookId: webhook.id,
        event,
        payload,
        status: "pending",
        nextRetryAt: new Date(),
      },
    });
  }
}

export async function retryWebhookDeliveries(): Promise<void> {
  const due = await db.webhookDelivery.findMany({
    where: { status: "pending", nextRetryAt: { lte: new Date() } },
    include: { webhook: { select: { url: true, secret: true } } },
    orderBy: { nextRetryAt: "asc" },
    take: 50,
  });

  await Promise.allSettled(due.map(attemptDelivery));
}

async function attemptDelivery(delivery: {
  id: string;
  payload: string;
  attempts: number;
  webhook: { url: string; secret: string };
}): Promise<void> {
  const attemptNum = delivery.attempts + 1;
  const body = delivery.payload;
  const sig = signPayload(delivery.webhook.secret, body);
  let statusCode: number | null = null;
  let error: string | null = null;
  let success = false;

  try {
    const res = await fetch(delivery.webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-FeedFerret-Signature": sig,
        "X-FeedFerret-Event": (JSON.parse(body) as { event: string }).event,
        "User-Agent": "FeedFerret-Webhooks/1.0",
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    statusCode = res.status;
    success = res.ok;
    if (!success) error = `HTTP ${res.status}`;
  } catch (err) {
    error = String(err).slice(0, 500);
  }

  const nextDelay = RETRY_DELAYS_MS[attemptNum];
  const exhausted = attemptNum >= MAX_ATTEMPTS || nextDelay == null;

  await db.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      attempts: attemptNum,
      status: success ? "success" : exhausted ? "failed" : "pending",
      statusCode,
      error,
      deliveredAt: success ? new Date() : undefined,
      nextRetryAt: !success && !exhausted ? new Date(Date.now() + nextDelay!) : null,
    },
  });
}
