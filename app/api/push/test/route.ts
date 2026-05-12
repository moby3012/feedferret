export const dynamic = "force-dynamic";

import { auth } from "@/auth";
import { sendTestPushNotification } from "@/lib/notifications";
import { NextResponse } from "next/server";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const result = await sendTestPushNotification(session.user.id);
  return NextResponse.json(result);
}
