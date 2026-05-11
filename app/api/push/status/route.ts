export const dynamic = "force-dynamic";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActivePushSubscriptionCount, getVapidPublicKey, hasPushConfig } from "@/lib/push";
import { NextResponse } from "next/server";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [user, activeSubscriptions] = await Promise.all([
    db.user.findUnique({
      where: { id: session.user.id },
      select: {
        pushEnabled: true,
        pushFrequency: true,
        pushFeedIds: true,
        pushPrivatePayloads: true,
        pushLastSentAt: true,
      },
    }),
    getActivePushSubscriptionCount(session.user.id),
  ]);

  return NextResponse.json({
    configured: hasPushConfig(),
    publicKey: getVapidPublicKey(),
    activeSubscriptions,
    settings: {
      pushEnabled: user?.pushEnabled ?? false,
      pushFrequency: user?.pushFrequency ?? "immediate",
      pushFeedIds: user?.pushFeedIds ? JSON.parse(user.pushFeedIds) : [],
      pushPrivatePayloads: user?.pushPrivatePayloads ?? true,
      pushLastSentAt: user?.pushLastSentAt ?? null,
    },
  });
}
