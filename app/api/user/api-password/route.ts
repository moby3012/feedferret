import { NextResponse } from "next/server";
import { readGReaderBody } from "@/lib/bounded-body";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { resolveSessionUser } from "@/lib/api-auth";
import { isSameOriginRequest } from "@/lib/same-origin";
import { generateFeverKey } from "@/lib/token";

export async function GET() {
  const user = await resolveSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const settings = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: {
    apiPasswordCreatedAt: true, apiPasswordLastUsedAt: true, apiPasswordRequired: true,
  } });
  return NextResponse.json(settings, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return new Response("Forbidden", { status: 403 });
  const user = await resolveSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (Number(request.headers.get("content-length")) > 4096) return new Response("Too large", { status: 413 });
  let body;
  try { body = JSON.parse(await readGReaderBody(request, 4096)); } catch { return new Response("Invalid JSON", { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return new Response("Invalid JSON", { status: 400 });
  const { password, required, revoke, policyOnly } = body;
  if (typeof required !== "boolean" || (revoke !== true && policyOnly !== true && (typeof password !== "string" || password.length < 16 || Buffer.byteLength(password) > 72))) {
    return new Response("Password must contain 16–72 bytes", { status: 400 });
  }
  if (policyOnly === true) {
    await db.user.update({ where: { id: user.id }, data: { apiPasswordRequired: required, apiTokenVersion: { increment: 1 } } });
    return NextResponse.json({ ok: true });
  }
  await db.user.update({ where: { id: user.id }, data: {
    apiPasswordHash: revoke ? null : await bcrypt.hash(password, 12),
    apiFeverKey: !revoke && user.email ? generateFeverKey(user.email, password) : null,
    apiPasswordCreatedAt: revoke ? null : new Date(), apiPasswordLastUsedAt: null,
    // Revoking must not silently re-enable the login-password fallback.
    apiPasswordRequired: revoke ? true : required, apiTokenVersion: { increment: 1 },
  } });
  return NextResponse.json({ ok: true });
}
