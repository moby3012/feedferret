export const dynamic = "force-dynamic";

import { auth } from "@/auth";
import { sendTestPushNotification } from "@/lib/notifications";
import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/lib/same-origin";

export async function POST(request: Request) {
  // CSRF: the session cookie is ambient; refuse cross-site mutations (audit #2 wave 3).
  if (!isSameOriginRequest(request)) return new Response("Forbidden", { status: 403 });
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const result = await sendTestPushNotification(session.user.id);
  return NextResponse.json(result);
}
