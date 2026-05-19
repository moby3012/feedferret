export const dynamic = "force-dynamic";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { generateApiToken } from "@/lib/token";
import { generateFeverKey } from "@/lib/token";

// GET /api/user/token — returns { hasToken: boolean } for backward compat
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const count = await db.apiToken.count({ where: { userId: session.user.id } });
  return NextResponse.json({ hasToken: count > 0 });
}

// POST /api/user/token — revoke all + generate new "Default write" token
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await db.user.findUnique({ where: { id: session.user.id }, select: { email: true } });
  const { raw, hash } = generateApiToken();
  const feverKey = user?.email ? generateFeverKey(user.email, raw) : null;

  await db.$transaction([
    db.apiToken.deleteMany({ where: { userId: session.user.id } }),
    db.apiToken.create({
      data: { userId: session.user.id, tokenHash: hash, feverKey, name: "Default", scope: "write" },
    }),
  ]);

  return NextResponse.json({ token: raw });
}

// DELETE /api/user/token — revoke all tokens
export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await db.apiToken.deleteMany({ where: { userId: session.user.id } });
  return NextResponse.json({ revoked: true });
}
