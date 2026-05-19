export const dynamic = "force-dynamic";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { generateApiToken, generateFeverKey } from "@/lib/token";

function requireSession() {
  return auth().then((s) => s?.user?.id ?? null);
}

// GET /api/user/tokens — list all tokens (no hash/raw returned)
export async function GET() {
  const userId = await requireSession();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tokens = await db.apiToken.findMany({
    where: { userId },
    select: { id: true, name: true, scope: true, expiresAt: true, lastUsedAt: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({ tokens });
}

// POST /api/user/tokens — create a new token
// Body: { name?: string, scope?: "read"|"write"|"admin", expiresAt?: string|null }
export async function POST(request: Request) {
  const userId = await requireSession();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { /* use defaults */ }

  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : "Default";
  const scope = ["read", "write", "admin"].includes(body.scope as string) ? (body.scope as string) : "write";
  const expiresAt = typeof body.expiresAt === "string" ? new Date(body.expiresAt) : null;

  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  const { raw, hash } = generateApiToken();
  const feverKey = user?.email ? generateFeverKey(user.email, raw) : null;

  const token = await db.apiToken.create({
    data: { userId, tokenHash: hash, feverKey, name, scope, expiresAt },
    select: { id: true, name: true, scope: true, expiresAt: true, createdAt: true },
  });

  return NextResponse.json({ ...token, token: raw }, { status: 201 });
}
