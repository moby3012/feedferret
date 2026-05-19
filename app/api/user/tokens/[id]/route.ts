export const dynamic = "force-dynamic";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";

// DELETE /api/user/tokens/:id — revoke one token
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const result = await db.apiToken.deleteMany({ where: { id, userId: session.user.id } });
  if (!result.count) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ revoked: true, id });
}

// PATCH /api/user/tokens/:id — rename a token
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { /* ignore */ }

  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : undefined;
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });

  const result = await db.apiToken.updateMany({ where: { id, userId: session.user.id }, data: { name } });
  if (!result.count) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const token = await db.apiToken.findFirst({
    where: { id, userId: session.user.id },
    select: { id: true, name: true, scope: true, expiresAt: true, lastUsedAt: true, createdAt: true },
  });
  return NextResponse.json(token);
}
