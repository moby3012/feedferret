/**
 * Simple in-memory rate limiter for API routes.
 * Uses sliding window algorithm per identifier (IP, userId, etc.)
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Safety cap so a flood of distinct identifiers (spoofed IPs, etc.) can't grow the
// store unbounded between the periodic GC passes below.
const MAX_STORE_ENTRIES = 50_000;

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.resetAt < now) store.delete(key);
  }
}, 5 * 60 * 1000);

/**
 * Evicts the oldest-inserted entries (Map preserves insertion order) when the store
 * is at capacity, making room for a new key. This is a cheap mitigation, not a
 * replacement for a shared/cross-instance store.
 */
function evictOldestIfAtCapacity() {
  if (store.size < MAX_STORE_ENTRIES) return;
  const excess = store.size - MAX_STORE_ENTRIES + 1;
  let removed = 0;
  for (const key of store.keys()) {
    if (removed >= excess) break;
    store.delete(key);
    removed++;
  }
}

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
    if (!store.has(key)) evictOldestIfAtCapacity();
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

/** Inspect failed-attempt budgets without consuming a request. */
export function peekRateLimit(identifier: string, config: RateLimitConfig): RateLimitResult {
  const now = Date.now();
  const entry = store.get(`${config.prefix}:${identifier}`);
  const count = entry && entry.resetAt >= now ? entry.count : 0;
  const resetAt = entry && entry.resetAt >= now ? entry.resetAt : now + config.windowSecs * 1000;
  return { success: count < config.limit, remaining: Math.max(0, config.limit - count), resetAt };
}

/**
 * Gives back one unit taken by `checkRateLimit` (e.g. a reserved login attempt
 * that turned out to be valid). No-op for an expired or missing window.
 */
export function releaseRateLimit(identifier: string, config: RateLimitConfig): void {
  const entry = store.get(`${config.prefix}:${identifier}`);
  if (entry && entry.resetAt >= Date.now() && entry.count > 0) entry.count -= 1;
}

/**
 * Adds `amount` units to a window without refusing (quota accounting after the
 * work, e.g. imported article rows). Pair with `peekRateLimit` before the work.
 */
export function consumeRateLimit(identifier: string, config: RateLimitConfig, amount: number): void {
  if (!(amount > 0)) return;
  const key = `${config.prefix}:${identifier}`;
  const now = Date.now();
  let entry = store.get(key);
  if (!entry || entry.resetAt < now) {
    if (!entry) evictOldestIfAtCapacity();
    entry = { count: 0, resetAt: now + config.windowSecs * 1000 };
    store.set(key, entry);
  }
  entry.count += Math.trunc(amount);
}

// Presets for different API endpoints
export const RATE_LIMITS = {
  // Manual "Fetch full text" (server action, REST v1, MCP): each call may
  // escalate to the render sidecar / hosted API, so keep it human-paced.
  fullTextFetch: {
    limit: 10,
    windowSecs: 60,
    prefix: "full-text-fetch",
  } satisfies RateLimitConfig,

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

  // AI feed-config proposal: hits the user's BYOK AI provider and fetches a
  // page, so keep it conservative — 10 req/min per user.
  aiFeedConfig: {
    limit: 10,
    windowSecs: 60,
    prefix: "ai-feed-config",
  } satisfies RateLimitConfig,

  // Admin "Test connection" buttons (Twitch, RSSHub): each call makes a real
  // outbound request with admin-supplied credentials — 10 req/min per admin.
  adminConnectionTest: {
    limit: 10,
    windowSecs: 60,
    prefix: "admin-connection-test",
  } satisfies RateLimitConfig,

  // RSSHub route proposal (M5a): same cost profile as aiFeedConfig — hits the
  // user's BYOK AI provider, then a real RSSHub round-trip to validate.
  rsshubRoute: {
    limit: 10,
    windowSecs: 60,
    prefix: "rsshub-route",
  } satisfies RateLimitConfig,

  // Auth: sign-in attempts — 10 per 15 minutes per IP
  authSignIn: {
    limit: 10,
    windowSecs: 15 * 60,
    prefix: "auth-signin",
  } satisfies RateLimitConfig,

  // Auth: sign-out. Not a credential guess, so it must NEVER draw from the sign-in budget: a refused
  // sign-out leaves the session cookie valid while the client has already wiped the device's offline
  // data and told its other tabs it is gone. A loose cap only stops a request flood.
  authSignOut: {
    limit: 60,
    windowSecs: 15 * 60,
    prefix: "auth-signout",
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

  // OPML import (UI action, REST v1, MCP): each call parses a document and writes
  // many rows — 10 per minute per user.
  opmlImport: {
    limit: 10,
    windowSecs: 60,
    prefix: "opml-import",
  } satisfies RateLimitConfig,

  // FreshRSS migration upload (ZIP/JSON, dry-run and real): heavy parse + bulk
  // writes — 6 per 10 minutes per user.
  freshrssImport: {
    limit: 6,
    windowSecs: 10 * 60,
    prefix: "freshrss-import",
  } satisfies RateLimitConfig,

  // N9: article rows one user may import per day (FreshRSS migration; sum of
  // created + updated rows of real runs). A full FreshRSS history of a heavy
  // user fits in one or two days; a loop cannot insert millions of rows.
  importedArticles: {
    limit: 200_000,
    windowSecs: 24 * 60 * 60,
    prefix: "imported-articles",
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

  // "↑ N neu" head probe: one per counts poll (~2 min), focus, reconnect or
  // refresh — 30/min per user leaves room for several tabs and stops a
  // runaway loop.
  headProbe: {
    limit: 30,
    windowSecs: 60,
    prefix: "head-probe",
  } satisfies RateLimitConfig,

  // N13 — expensive per-user reads/writes. Sized so normal use (incl. several
  // tabs and sync clients such as Reeder / NetNewsWire) never hits them; they
  // only stop scripted loops. See docs/security.md "Rate limits".
  //
  // Ad-hoc search (`q`, ILIKE over text columns): typing is debounced, one list
  // page + one count per settled query — 60/min is several queries per second
  // of sustained typing.
  articleSearch: {
    limit: 60,
    windowSecs: 60,
    prefix: "article-search",
  } satisfies RateLimitConfig,

  // `/api/app/articles/count` (saved searches and search only).
  articleCount: {
    limit: 120,
    windowSecs: 60,
    prefix: "article-count",
  } satisfies RateLimitConfig,

  // "Alles bis hier als gelesen" range (up to 20k rows in one transaction).
  rangeMark: {
    limit: 20,
    windowSecs: 60,
    prefix: "range-mark",
  } satisfies RateLimitConfig,

  // Hot toggle batches (`applyArticleStateOps`): the client batcher flushes at
  // most every 400 ms–1 s, so normal use stays well below 150/min.
  stateOps: {
    limit: 300,
    windowSecs: 60,
    prefix: "state-ops",
  } satisfies RateLimitConfig,

  // Bulk "mark feed/folder/all read" over GReader (`mark-all-as-read`) and
  // Fever (`mark=feed|group`). Generous burst (a client marking a folder may
  // send one call per feed) but caps a sustained loop at 0.5/s. Shared bucket.
  apiBulkMark: {
    limit: 300,
    windowSecs: 10 * 60,
    prefix: "api-bulk-mark",
  } satisfies RateLimitConfig,

  // "Defekte Feeds": a manual re-test runs a real sync of one feed (outbound
  // fetch + article upsert). The bulk "Alle erneut testen" walks the list with
  // a few in flight, so allow a full list per 10 minutes but stop scripted loops.
  feedRetest: {
    limit: 150,
    windowSecs: 10 * 60,
    prefix: "feed-retest",
  } satisfies RateLimitConfig,

  // "Test connection" in AI settings: a real provider round-trip.
  aiConnectionTest: {
    limit: 10,
    windowSecs: 10 * 60,
    prefix: "ai-connection-test",
  } satisfies RateLimitConfig,

  // N1 PR D: RFC 8058 one-click unsubscribe (server-side POST to a sender URL), 10/min per user
  newsletterUnsubscribe: {
    limit: 10,
    windowSecs: 60,
    prefix: "newsletter-unsubscribe",
  } satisfies RateLimitConfig,

  // N1 PR C: inbound-email webhook (spec §6.3), 60 mails/min per source + client IP
  inboundEmailWebhook: {
    limit: 60,
    windowSecs: 60,
    prefix: "inbound-email-webhook",
  } satisfies RateLimitConfig,

  // N1 PR C: wrong signature / password on the webhook, 10 per 5 min per source + client IP
  inboundEmailWebhookAuthFail: {
    limit: 10,
    windowSecs: 5 * 60,
    prefix: "inbound-email-webhook-auth-fail",
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
  if (forwarded) {
    const hops = forwarded.split(",").map(hop => hop.trim());
    const configured = Number(process.env.TRUSTED_PROXY_COUNT ?? 1);
    const count = Number.isSafeInteger(configured) && configured >= 1 ? configured : 1;
    return `ip:${hops[Math.max(0, hops.length - count)] || "unknown"}`;
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return `ip:${realIp}`;

  // Fallback to unknown (still rate-limited globally)
  return "ip:unknown";
}

/** Which limiter guards a POST to the Auth.js route (`/api/auth/<action>/…`). */
export function authRateLimitFor(pathname: string): RateLimitConfig {
  const path = pathname.toLowerCase();
  if (path.includes("sendverificationrequest") || path.includes("email")) return RATE_LIMITS.authMagicLink;
  if (path.split("/").filter(Boolean)[2] === "signout") return RATE_LIMITS.authSignOut;
  return RATE_LIMITS.authSignIn;
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
