import { NextResponse } from "next/server";
import { readGReaderBody } from "@/lib/bounded-body";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { resolveSessionUser } from "@/lib/api-auth";
import { isSameOriginRequest } from "@/lib/same-origin";
import { randomBytes } from "crypto";
import { verifyTotpToken } from "@/lib/totp";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hashApiToken, generateFeverKey } from "@/lib/token";

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
  const limit = checkRateLimit(user.id, { prefix: "api-password-step-up", limit: 10, windowSecs: 900 });
  if (!limit.success) return rateLimitResponse(limit);
  const account = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { password: true, twoFactorEnabled: true, twoFactorSecret: true } });
  const passwordMatches = typeof body.currentPassword === "string" && Buffer.byteLength(body.currentPassword) <= 72 && account.password && await bcrypt.compare(body.currentPassword, account.password);
  const totpMatches = typeof body.totp === "string" && account.twoFactorEnabled && account.twoFactorSecret && verifyTotpToken(account.twoFactorSecret, body.totp);
  if (!passwordMatches && !totpMatches) return new Response("Current login password or TOTP required", { status: 403 });
  const { required, revoke, policyOnly } = body;
  const password = (body.password === undefined || body.password === "") ? randomBytes(32).toString("base64url") : body.password;
  if (typeof required !== "boolean" || (revoke !== true && policyOnly !== true && (typeof password !== "string" || password.length < 24 || Buffer.byteLength(password) > 72))) {
    return new Response("Password must contain 24–72 bytes", { status: 400 });
  }
  if (policyOnly === true) {
    await db.user.update({ where: { id: user.id }, data: { apiPasswordRequired: required, apiTokenVersion: { increment: 1 } } });
    return NextResponse.json({ ok: true });
  }
  await db.user.update({ where: { id: user.id }, data: {
    apiPasswordHash: revoke ? null : await bcrypt.hash(password, 12),
    apiFeverKey: !revoke && user.email ? hashApiToken(generateFeverKey(user.email, password)) : null,
    apiPasswordCreatedAt: revoke ? null : new Date(), apiPasswordLastUsedAt: null,
    // Revoking must not silently re-enable the login-password fallback.
    apiPasswordRequired: revoke ? true : required, apiTokenVersion: { increment: 1 },
  } });
  return NextResponse.json({ ok: true, ...(!revoke ? { password } : {}) }, { headers: { "Cache-Control": "no-store" } });
}
