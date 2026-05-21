/**
 * Simple in-memory rate limiter for API routes.
 * Uses sliding window algorithm per identifier (IP, userId, etc.)
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.resetAt < now) store.delete(key);
  }
}, 5 * 60 * 1000);

export interface RateLimitConfig {
  /** Max requests allowed in the window */
  limit: number;
  /** Window size in seconds */
  windowSecs: number;
  /** Prefix for the store key (e.g., "discovery-search") */
  prefix: string;
}

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetAt: number;
  retryAfterSecs?: number;
}

export function checkRateLimit(
  identifier: string,
  config: RateLimitConfig
): RateLimitResult {
  const key = `${config.prefix}:${identifier}`;
  const now = Date.now();
  const windowMs = config.windowSecs * 1000;

  let entry = store.get(key);

  // Window expired or no entry → reset
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + windowMs };
    store.set(key, entry);
  }

  entry.count++;

  if (entry.count > config.limit) {
    const retryAfterSecs = Math.ceil((entry.resetAt - now) / 1000);
    return {
      success: false,
      remaining: 0,
      resetAt: entry.resetAt,
      retryAfterSecs,
    };
  }

  return {
    success: true,
    remaining: config.limit - entry.count,
    resetAt: entry.resetAt,
  };
}

// Presets for different API endpoints
export const RATE_LIMITS = {
  // Feedsearch.dev: be respectful, 10 req/min per user
  discoverySearch: {
    limit: 10,
    windowSecs: 60,
    prefix: "discovery-search",
  } satisfies RateLimitConfig,

  // Discovery catalog browse: more lenient, 30 req/min
  discoveryCatalog: {
    limit: 30,
    windowSecs: 60,
    prefix: "discovery-catalog",
  } satisfies RateLimitConfig,

  // URL discovery (existing): 20 req/min
  urlDiscover: {
    limit: 20,
    windowSecs: 60,
    prefix: "url-discover",
  } satisfies RateLimitConfig,

  // Auth: sign-in attempts — 10 per 15 minutes per IP
  authSignIn: {
    limit: 10,
    windowSecs: 15 * 60,
    prefix: "auth-signin",
  } satisfies RateLimitConfig,

  // Auth: magic link / email verification requests — 3 per 10 minutes per IP
  authMagicLink: {
    limit: 3,
    windowSecs: 10 * 60,
    prefix: "auth-magic",
  } satisfies RateLimitConfig,

  // REST API v1 write operations — 60 per minute per user/IP
  apiV1Write: {
    limit: 60,
    windowSecs: 60,
    prefix: "api-v1-write",
  } satisfies RateLimitConfig,

  // REST API v1 read operations — 200 per minute per user/IP
  apiV1Read: {
    limit: 200,
    windowSecs: 60,
    prefix: "api-v1-read",
  } satisfies RateLimitConfig,

  // MCP endpoint — 100 per minute per user/IP
  mcp: {
    limit: 100,
    windowSecs: 60,
    prefix: "mcp",
  } satisfies RateLimitConfig,

  // Internal provisioning API — 30 per minute
  internalApi: {
    limit: 30,
    windowSecs: 60,
    prefix: "internal-api",
  } satisfies RateLimitConfig,

  // Fever compatible API — 120 req/min per user
  fever: {
    limit: 120,
    windowSecs: 60,
    prefix: "fever",
  } satisfies RateLimitConfig,

  // Google Reader compatible API — 120 req/min per user
  greader: {
    limit: 120,
    windowSecs: 60,
    prefix: "greader",
  } satisfies RateLimitConfig,
} as const;

/**
 * Build a standard 429 response with rate limit headers.
 */
export function rateLimitResponse(result: RateLimitResult): Response {
  return new Response(
    JSON.stringify({ error: { message: "Too Many Requests" } }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        ...rateLimitHeaders(result),
      },
    }
  );
}

/**
 * Helper to get identifier from request (IP or user ID)
 */
export function getClientIdentifier(
  request: Request,
  userId?: string | null
): string {
  if (userId) return `user:${userId}`;

  // Try common proxy headers
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return `ip:${forwarded.split(",")[0].trim()}`;

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return `ip:${realIp}`;

  // Fallback to unknown (still rate-limited globally)
  return "ip:unknown";
}

/**
 * Returns rate limit headers for response
 */
export function rateLimitHeaders(result: RateLimitResult): HeadersInit {
  return {
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.floor(result.resetAt / 1000)),
    ...(result.retryAfterSecs
      ? { "Retry-After": String(result.retryAfterSecs) }
      : {}),
  };
}
