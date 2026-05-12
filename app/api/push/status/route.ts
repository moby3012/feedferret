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

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const data: {
    pushEnabled?: boolean;
    pushFrequency?: string;
    pushFeedIds?: string[];
    pushPrivatePayloads?: boolean;
  } = {};

  if (typeof body.pushEnabled === "boolean") data.pushEnabled = body.pushEnabled;
  if (["off", "immediate", "hourly", "daily"].includes(body.pushFrequency)) {
    data.pushFrequency = body.pushFrequency;
  }
  if (Array.isArray(body.pushFeedIds)) {
    const ids = body.pushFeedIds.filter((id: unknown) => typeof id === "string");
    data.pushFeedIds = ids;
  }
  if (typeof body.pushPrivatePayloads === "boolean") {
    data.pushPrivatePayloads = body.pushPrivatePayloads;
  }

  await db.user.update({
    where: { id: session.user.id },
    data: {
      ...(data.pushEnabled !== undefined ? { pushEnabled: data.pushEnabled } : {}),
      ...(data.pushFrequency !== undefined ? { pushFrequency: data.pushFrequency } : {}),
      ...(data.pushPrivatePayloads !== undefined ? { pushPrivatePayloads: data.pushPrivatePayloads } : {}),
      ...(data.pushFeedIds !== undefined ? { pushFeedIds: data.pushFeedIds.length ? JSON.stringify(data.pushFeedIds) : null } : {}),
    },
  });

  return NextResponse.json({ ok: true });
}
