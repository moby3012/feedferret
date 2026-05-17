import { auth } from "@/auth";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { hashApiToken } from "@/lib/token";

export type ApiUser = {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
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

  const user = await db.user.findUnique({
    where: { apiToken: hashApiToken(token) },
    select: { id: true, email: true, name: true, role: true, isActive: true },
  });

  if (!user?.isActive) return null;
  return user;
}

export async function requireApiUser(request: Request): Promise<ApiUser | NextResponse> {
  const user = await resolveApiUser(request);
  if (!user) return apiError("Unauthorized", 401);
  return user;
}

export function apiError(message: string, status = 400, details?: unknown) {
  return NextResponse.json(
    {
      error: {
        message,
        ...(details === undefined ? {} : { details }),
      },
    },
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
