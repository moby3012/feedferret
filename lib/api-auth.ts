import { auth } from "@/auth";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { hashApiToken } from "@/lib/token";
import { isSameOriginRequest } from "@/lib/same-origin";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";

const gzip = promisify(gzipCallback);

export type ApiUser = {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
  tokenScope?: string;  // undefined = session auth (full access)
  tokenId?: string;
  authenticatedAt?: number;
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Session cookie OR `Authorization: Bearer <apiToken>`.
 *
 * CSRF: the session cookie is ambient, so for state-changing methods it only
 * counts when the request is same-origin (`isSameOriginRequest`). A
 * cross-site form/fetch POST to /api/v1, /api/mcp or /api/read-later is then
 * treated as unauthenticated unless it carries a bearer token — which a
 * cross-site page cannot attach.
 */
export async function resolveApiUser(request: Request): Promise<ApiUser | null> {
  const cookieAuthAllowed = SAFE_METHODS.has(request.method.toUpperCase()) || isSameOriginRequest(request);
  const session = cookieAuthAllowed ? await auth() : null;
  if (session?.user?.id) {
    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });
    if (user?.isActive) return user;
  }

  const authHeader = request.headers.get("authorization");
  // eslint-disable-next-line regexp/no-super-linear-backtracking -- HTTP header values cannot contain line terminators, so `.+$` never fails after the whitespace run
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

/**
 * Session-cookie-only auth for the first-party app endpoints under
 * `/api/app/*` (the reader UI). Bearer API tokens are deliberately NOT
 * accepted there: those endpoints are internal to the web app, not part of
 * the public REST/GReader/Fever/MCP surfaces. Inactive users are rejected
 * exactly like `resolveApiUser` does.
 */
export async function resolveSessionUser(): Promise<ApiUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, email: true, name: true, role: true, isActive: true },
  });
  if (!user?.isActive) return null;
  return { id: user.id, email: user.email, name: user.name, role: user.role, authenticatedAt: session.authenticatedAt };
}

const APP_HEADERS = { "Cache-Control": "private, no-store" } as const;
const GZIP_MIN_BYTES = 1024;

/**
 * Whether an `Accept-Encoding` header allows gzip (RFC 9110 §12.5.3):
 * `gzip`/`x-gzip` or `*` with a q-value above 0; an explicit `gzip;q=0`
 * refuses it even when `*` is listed.
 */
export function acceptsGzip(header: string | null | undefined): boolean {
  if (!header) return false;
  let gzipQ: number | null = null;
  let starQ: number | null = null;
  for (const part of header.split(",")) {
    const [rawName, ...params] = part.trim().split(";");
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    for (const param of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param);
      if (m) q = Number(m[1]);
    }
    if (!Number.isFinite(q)) q = 0;
    if (name === "gzip" || name === "x-gzip") gzipQ = Math.max(gzipQ ?? 0, q);
    else if (name === "*") starQ = q;
  }
  return (gzipQ ?? starQ ?? 0) > 0;
}

/**
 * JSON response for `/api/app/*`: per-user data, never cached by browsers or
 * proxies. Gzipped here when the client accepts it: Next's built-in
 * compression does not apply to App Router route-handler responses, and the
 * article list is the hottest payload of the app.
 */
export async function appJson(body: unknown, opts: { request?: Request; status?: number } = {}) {
  const json = JSON.stringify(body);
  const status = opts.status ?? 200;
  if (json.length >= GZIP_MIN_BYTES && acceptsGzip(opts.request?.headers.get("accept-encoding"))) {
    // Async: compression runs on the libuv pool, not the request thread.
    return new NextResponse(new Uint8Array(await gzip(json)), {
      status,
      headers: { ...APP_HEADERS, "Content-Type": "application/json", "Content-Encoding": "gzip", Vary: "Accept-Encoding" },
    });
  }
  return new NextResponse(json, { status, headers: { ...APP_HEADERS, "Content-Type": "application/json", Vary: "Accept-Encoding" } });
}

export function appError(message: string, status = 400) {
  return NextResponse.json({ error: { message } }, { status, headers: APP_HEADERS });
}
