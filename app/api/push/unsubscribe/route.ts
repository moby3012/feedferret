export const dynamic = "force-dynamic";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : null;

  if (endpoint) {
    await db.pushSubscription.updateMany({
      where: { userId: session.user.id, endpoint },
      data: { disabledAt: new Date() },
    });
  } else {
    await db.pushSubscription.updateMany({
      where: { userId: session.user.id, disabledAt: null },
      data: { disabledAt: new Date() },
    });
    await db.user.update({ where: { id: session.user.id }, data: { pushEnabled: false } });
  }

  return NextResponse.json({ ok: true });
}
