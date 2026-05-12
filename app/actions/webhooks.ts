"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { generateWebhookSecret, signPayload } from "@/lib/webhooks";
import { revalidatePath } from "next/cache";

async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session;
}

export async function getWebhooks() {
  const session = await requireUser();
  return db.webhook.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      url: true,
      enabled: true,
      events: true,
      feedFilter: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { deliveries: true } },
    },
  });
}

export async function createWebhook(data: {
  name: string;
  url: string;
  events: string[];
  feedFilter?: string[] | null;
}) {
  const session = await requireUser();
  const secret = generateWebhookSecret();
  const webhook = await db.webhook.create({
    data: {
      userId: session.user.id,
      name: data.name,
      url: data.url,
      secret,
      enabled: true,
      events: JSON.stringify(data.events),
      feedFilter: data.feedFilter?.length ? JSON.stringify(data.feedFilter) : null,
    },
  });
  revalidatePath("/settings");
  // Return secret once so UI can display it
  return { ...webhook, secret };
}

export async function updateWebhook(
  id: string,
  data: { name?: string; url?: string; enabled?: boolean; events?: string[]; feedFilter?: string[] | null },
) {
  const session = await requireUser();
  const update: Record<string, unknown> = {};
  if (data.name !== undefined) update.name = data.name;
  if (data.url !== undefined) update.url = data.url;
  if (data.enabled !== undefined) update.enabled = data.enabled;
  if (data.events !== undefined) update.events = JSON.stringify(data.events);
  if (data.feedFilter !== undefined) {
    update.feedFilter = data.feedFilter?.length ? JSON.stringify(data.feedFilter) : null;
  }
  await db.webhook.updateMany({ where: { id, userId: session.user.id }, data: update });
  revalidatePath("/settings");
}

export async function deleteWebhook(id: string) {
  const session = await requireUser();
  await db.webhook.deleteMany({ where: { id, userId: session.user.id } });
  revalidatePath("/settings");
}

export async function rotateWebhookSecret(id: string) {
  const session = await requireUser();
  const secret = generateWebhookSecret();
  await db.webhook.updateMany({ where: { id, userId: session.user.id }, data: { secret } });
  revalidatePath("/settings");
  return { secret };
}

export async function getWebhookDeliveries(webhookId: string) {
  const session = await requireUser();
  const webhook = await db.webhook.findFirst({
    where: { id: webhookId, userId: session.user.id },
    select: { id: true },
  });
  if (!webhook) throw new Error("Not found");
  return db.webhookDelivery.findMany({
    where: { webhookId },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: {
      id: true,
      event: true,
      status: true,
      statusCode: true,
      error: true,
      attempts: true,
      nextRetryAt: true,
      deliveredAt: true,
      createdAt: true,
    },
  });
}

export async function sendTestWebhook(id: string) {
  const session = await requireUser();
  const webhook = await db.webhook.findFirst({
    where: { id, userId: session.user.id },
  });
  if (!webhook) throw new Error("Not found");

  const payload = JSON.stringify({
    event: "test",
    timestamp: new Date().toISOString(),
    data: { message: "FeedFerret webhook test ping" },
  });
  const sig = signPayload(webhook.secret, payload);

  try {
    const res = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-FeedFerret-Signature": sig,
        "X-FeedFerret-Event": "test",
        "User-Agent": "FeedFerret-Webhooks/1.0",
      },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: null, error: String(err) };
  }
}
