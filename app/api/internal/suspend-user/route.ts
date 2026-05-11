import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { validateInternalApiKey } from "@/lib/internal-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!validateInternalApiKey(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { email?: string; userId?: string } | null = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const email = body?.email?.trim().toLowerCase();
  const userId = body?.userId?.trim();

  if (!email && !userId) {
    return NextResponse.json({ error: "email or userId required" }, { status: 400 });
  }

  const where = email ? { email } : { id: userId! };
  const user = await db.user.findUnique({ where });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (!user.isActive) {
    return NextResponse.json({ suspended: true, userId: user.id, email: user.email, alreadySuspended: true });
  }

  await db.user.update({ where: { id: user.id }, data: { isActive: false } });

  return NextResponse.json({ suspended: true, userId: user.id, email: user.email });
}
