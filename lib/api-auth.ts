import { auth } from "@/auth";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { hashApiToken } from "@/lib/token";

export type ApiUser = {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
  tokenScope?: string;  // undefined = session auth (full access)
  tokenId?: string;
};

export async function resolveApiUser(request: Request): Promise<ApiUser | null> {
  const session = await auth();
  if (session?.user?.id) {
    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });
    if (user?.isActive) return user;
  }

  const authHeader = request.headers.get("authorization");
  const token = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return null;

  const tokenRecord = await db.apiToken.findUnique({
    where: { tokenHash: hashApiToken(token) },
    include: {
      user: { select: { id: true, email: true, name: true, role: true, isActive: true } },
    },
  });

  if (!tokenRecord?.user?.isActive) return null;
  if (tokenRecord.expiresAt && tokenRecord.expiresAt < new Date()) return null;

  // Update lastUsedAt without blocking the request
  db.apiToken.update({ where: { id: tokenRecord.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

  return { ...tokenRecord.user, tokenScope: tokenRecord.scope, tokenId: tokenRecord.id };
}

export async function requireApiUser(request: Request): Promise<ApiUser | NextResponse> {
  const user = await resolveApiUser(request);
  if (!user) return apiError("Unauthorized", 401);
  return user;
}

export function apiError(message: string, status = 400, details?: unknown) {
  return NextResponse.json(
    { error: { message, ...(details === undefined ? {} : { details }) } },
    { status },
  );
}

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

export function parseBool(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  if (["true", "1", "yes"].includes(value.toLowerCase())) return true;
  if (["false", "0", "no"].includes(value.toLowerCase())) return false;
  return undefined;
}

export function clampInt(value: string | number | null | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

const SCOPE_LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 };

/**
 * Returns a 403 error response if the user's token scope is below the required level.
 * Returns null if access is allowed (scope is sufficient, or user has session auth with no token scope).
 */
export function scopeError(user: ApiUser, required: "read" | "write" | "admin"): NextResponse | null {
  // Session auth (no tokenScope) always has full access
  if (user.tokenScope === undefined) return null;
  const userLevel = SCOPE_LEVEL[user.tokenScope] ?? 0;
  const requiredLevel = SCOPE_LEVEL[required];
  if (userLevel < requiredLevel) {
    return apiError("Insufficient token scope", 403);
  }
  return null;
}
