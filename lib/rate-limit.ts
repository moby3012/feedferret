/**
 * Simple in-memory rate limiter for API routes.
 * Uses sliding window algorithm per identifier (IP, userId, etc.)
 */

import { getClientIpKey } from "@/lib/client-ip";
export { getClientIp, resetProxyCountWarning, warnIfProxyCountUnset } from "@/lib/client-ip";

interface RateLimitEntry {
  count: number;
  resetAt: number;
  /** Limit the entry was last checked against (an entry at/over it is an active lockout). */
  limit: number;
}

/**
 * One store per limiter (`config.prefix`), each with its own capacity. A flood of distinct keys
 * against one limiter (many IPs, attacker-chosen key parts) can therefore only ever evict entries of
 * that same limiter, never e.g. the sign-in lockout.
 *
 * Eviction when a namespace is full (a cheap in-process mitigation, not a cross-instance store):
 *  - ordinary limiters drop expired entries, then the oldest ones;
 *  - `critical` limiters (credential guessing: sign-in, step-up, webhook auth failures, …) are
 *    FAIL-SAFE: expired entries go first, then lightly used entries (below half of their limit), then
 *    any entry that is not yet locked. What happens when only active lockouts are left depends on
 *    `overflow`:
 *      - "refuse" (default): lockouts are never evicted, new keys are refused ("limited") until the
 *        earliest lockout expires. For limiters without a backstop (internal API key, webhook
 *        secret, step-ups). Filling the table needs `cap × limit` requests from `cap` distinct keys.
 *      - "evict-oldest": the oldest lockouts go. For IP-keyed limiters whose accounts are also
 *        protected elsewhere (sign-in: the per-account DB lockout; magic link: the unlock path must
 *        never be globally deniable), so one host cannot deny everyone else.
 */
type Overflow = "refuse" | "evict-oldest";

interface Namespace {
  entries: Map<string, RateLimitEntry>;
  cap: number;
  critical: boolean;
  overflow: Overflow;
  /** Critical namespaces only: while now < this, a full scan already found nothing evictable. */
  saturatedUntil: number;
}

const namespaces = new Map<string, Namespace>();

// Safety cap per limiter so a flood of distinct identifiers can't grow memory unbounded between
// the periodic GC passes below.
export const MAX_STORE_ENTRIES = 50_000;
/** Share of a full namespace freed per eviction pass, so floods don't trigger a full scan per request. */
const EVICTION_BATCH_FRACTION = 0.01;

function namespaceFor(config: RateLimitConfig): Namespace {
  let ns = namespaces.get(config.prefix);
  if (!ns) {
    ns = { entries: new Map(), cap: MAX_STORE_ENTRIES, critical: false, overflow: config.overflow ?? "refuse", saturatedUntil: 0 };
    namespaces.set(config.prefix, ns);
  }
  if (config.critical) ns.critical = true;
  return ns;
}

// Cleanup stale entries every 5 minutes
const gc = setInterval(() => {
  const now = Date.now();
  for (const ns of namespaces.values()) {
    for (const [key, entry] of ns.entries) {
      if (entry.resetAt < now) ns.entries.delete(key);
    }
  }
}, 5 * 60 * 1000);
gc.unref?.();

/** Frees room for one new key. Returns false only for a saturated critical namespace. */
function makeRoom(ns: Namespace, now: number): boolean {
  if (ns.entries.size < ns.cap) return true;
  if (ns.critical && now < ns.saturatedUntil) return false;
  const target = Math.max(1, Math.floor(ns.cap * EVICTION_BATCH_FRACTION));
  let freed = 0;
  const evict = (match: (entry: RateLimitEntry) => boolean) => {
    for (const [key, entry] of ns.entries) {
      if (freed >= target) return;
      if (match(entry)) {
        ns.entries.delete(key);
        freed++;
      }
    }
  };
  evict((entry) => entry.resetAt < now);
  if (ns.critical) {
    evict((entry) => entry.count * 2 < entry.limit);
    evict((entry) => entry.count < entry.limit);
    if (freed === 0 && ns.overflow === "refuse") {
      let earliest = Infinity;
      for (const entry of ns.entries.values()) earliest = Math.min(earliest, entry.resetAt);
      ns.saturatedUntil = earliest;
      return false;
    }
    if (freed > 0) return true;
  }
  evict(() => true);
  return true;
}

export interface RateLimitConfig {
  /** Max requests allowed in the window */
  limit: number;
  /** Window size in seconds */
  windowSecs: number;
  /** Prefix for the store key (e.g., "discovery-search"); also names the limiter's own store. */
  prefix: string;
  /**
   * Credential-guessing / abuse-sensitive limiter: its store evicts fail-safe (active lockouts are
   * never dropped to make room, new keys are refused instead). See `Namespace`.
   */
  critical?: boolean;
  /** Critical limiters only: what to do when the store holds nothing but active lockouts. */
  overflow?: Overflow;
}

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetAt: number;
  retryAfterSecs?: number;
}

/** Number of tracked keys in a limiter's store (diagnostics and tests). */
export function rateLimitStoreSize(prefix: string): number {
  return namespaces.get(prefix)?.entries.size ?? 0;
}

export function checkRateLimit(
  identifier: string,
  config: RateLimitConfig
): RateLimitResult {
  const ns = namespaceFor(config);
  const now = Date.now();
  const windowMs = config.windowSecs * 1000;

  let entry = ns.entries.get(identifier);

  // Window expired or no entry → reset
  if (!entry || entry.resetAt < now) {
    if (!entry && !makeRoom(ns, now)) {
      // Fail-safe: no room and every entry is an active lockout → treat the new key as limited.
      const resetAt = Math.max(ns.saturatedUntil, now + 1000);
      return { success: false, remaining: 0, resetAt, retryAfterSecs: Math.ceil((resetAt - now) / 1000) };
    }
    entry = { count: 0, resetAt: now + windowMs, limit: config.limit };
    ns.entries.set(identifier, entry);
  }

  entry.limit = config.limit;
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

/**
 * Inspect failed-attempt budgets without consuming a request. A key that is not tracked yet counts as
 * limited while its fail-safe (`critical`, `overflow: "refuse"`) store is saturated, exactly like
 * `checkRateLimit` would refuse it: otherwise a caller that peeks BEFORE the work and only charges
 * failures afterwards (the signature webhook) would let every untracked client through forever once
 * the store is full.
 */
export function peekRateLimit(identifier: string, config: RateLimitConfig): RateLimitResult {
  const now = Date.now();
  const ns = namespaces.get(config.prefix);
  const entry = ns?.entries.get(identifier);
  const live = entry && entry.resetAt >= now ? entry : undefined;
  if (!entry && ns?.critical && ns.overflow === "refuse" && !makeRoom(ns, now)) {
    const resetAt = Math.max(ns.saturatedUntil, now + 1000);
    return { success: false, remaining: 0, resetAt, retryAfterSecs: Math.ceil((resetAt - now) / 1000) };
  }
  const count = live ? live.count : 0;
  const resetAt = live ? live.resetAt : now + config.windowSecs * 1000;
  return { success: count < config.limit, remaining: Math.max(0, config.limit - count), resetAt };
}

/**
 * Gives back one unit taken by `checkRateLimit` (e.g. a reserved login attempt
 * that turned out to be valid). No-op for an expired or missing window.
 */
export function releaseRateLimit(identifier: string, config: RateLimitConfig): void {
  const entry = namespaces.get(config.prefix)?.entries.get(identifier);
  if (entry && entry.resetAt >= Date.now() && entry.count > 0) entry.count -= 1;
}

/**
 * Adds `amount` units to a window without refusing (quota accounting after the
 * work, e.g. imported article rows). Pair with `peekRateLimit` before the work.
 */
export function consumeRateLimit(identifier: string, config: RateLimitConfig, amount: number): void {
  if (!(amount > 0)) return;
  const ns = namespaceFor(config);
  const now = Date.now();
  let entry = ns.entries.get(identifier);
  if (!entry || entry.resetAt < now) {
    if (!entry && !makeRoom(ns, now)) return;
    entry = { count: 0, resetAt: now + config.windowSecs * 1000, limit: config.limit };
    ns.entries.set(identifier, entry);
  }
  entry.limit = config.limit;
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

  // Auth: sign-in attempts — 10 per 15 minutes per IP. `critical` (here and on the other
  // credential-guessing limiters): own fail-safe store, see `Namespace`. Spreads of this preset
  // (GReader/Fever/credentials-status) get their own store via their own prefix.
  // The per-ACCOUNT sign-in lockout lives in the database: lib/account-lockout.ts.
  authSignIn: {
    limit: 10,
    windowSecs: 15 * 60,
    prefix: "auth-signin",
    critical: true,
    overflow: "evict-oldest",
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
    critical: true,
    overflow: "evict-oldest",
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
    critical: true,
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
    critical: true,
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
 * Helper to get identifier from request (IP or user ID). The IP part comes from `lib/client-ip.ts`
 * (IPv6 collapses to its /64; forwarded headers are only believed from a trusted proxy peer).
 */
export function getClientIdentifier(
  request: Request,
  userId?: string | null
): string {
  if (userId) return `user:${userId}`;
  return getClientIpKey(request);
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
