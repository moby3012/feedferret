export const dynamic = "force-dynamic";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { hasPushConfig } from "@/lib/push";
import { NextResponse } from "next/server";

type IncomingSubscription = {
  endpoint?: string;
  keys?: {
    p256dh?: string;
    auth?: string;
  };
};

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasPushConfig()) return NextResponse.json({ error: "Push is not configured" }, { status: 503 });

  const body = await request.json().catch(() => ({}));
  const subscription = (body.subscription ?? body) as IncomingSubscription;

  if (!subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    return NextResponse.json({ error: "Invalid push subscription" }, { status: 400 });
  }

  await db.pushSubscription.upsert({
    where: { endpoint: subscription.endpoint },
    update: {
      userId: session.user.id,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: request.headers.get("user-agent"),
      platform: typeof body.platform === "string" ? body.platform : null,
      disabledAt: null,
    },
    create: {
      userId: session.user.id,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: request.headers.get("user-agent"),
      platform: typeof body.platform === "string" ? body.platform : null,
    },
  });

  await db.user.update({
    where: { id: session.user.id },
    data: {
      pushEnabled: true,
      pushFrequency: typeof body.frequency === "string" ? body.frequency : undefined,
    },
  });

  return NextResponse.json({ ok: true });
}
