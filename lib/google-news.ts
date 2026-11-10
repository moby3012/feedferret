// Google News keyword feeds (G1): server-side helpers — origin override,
// article-link decoding and bounded, cached link resolution at ingest.
//
// Google News RSS items link to `news.google.com/rss/articles/<id>`, not to the
// publisher. Since mid-2024 the base64url `<id>` is an opaque token (protobuf
// `08 13 22 <varint len> "AU_yqL…"`); plain HTTP redirects never reach the
// publisher (the URL 302s to itself and serves an HTML splash page). The
// publisher URL is only available through Google's internal `batchexecute`
// RPC, which needs a per-article signature + timestamp scraped from that
// splash page:
//
//   1. GET  /rss/articles/<id>?hl&gl&ceid   → data-n-a-sg="<sig>" data-n-a-ts="<ts>"
//   2. POST /_/DotsSplashUi/data/batchexecute  f.req=[[["Fbv4je", "[\"garturlreq\",[…],\"<id>\",<ts>,\"<sig>\"]", null, "<reqId>"], …]]
//      → )]}'\n\n[["wrb.fr","Fbv4je","[\"garturlres\",\"<publisher url>\",1]",…,"<reqId>"],…]
//
// Old-format ids (payload is the URL itself) are still decoded offline first.
// The RPC is undocumented and costs ~600 KB per article page, so resolution is
// bounded (time budget, per-sync cap, global concurrency), cached in-process
// (positive + negative), backs off globally on 429/503, and always falls back
// to the Google link.

import { fetchWithSsrfProtection, type ConditionalFetchResult, type SafeFetchTextOptions } from "./ssrf";
import { GOOGLE_NEWS_ORIGIN, googleNewsLocaleParams, isGoogleNewsRssUrl, parseGoogleNewsSearchUrl } from "./google-news-url";
import { logger } from "./logger";

/* -------------------------------------------------------------------------- */
/* Origin                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The Google News origin this instance talks to.
 *
 * `FEEDFERRET_GOOGLE_NEWS_BASE_URL` is a TEST-ONLY override (the e2e harness
 * points it at the local fixture server's fake Google). Never set it in
 * production: that one origin is trusted past the SSRF private-address block
 * (feed fetches only on its `/rss/…` paths; the link resolver only calls its
 * fixed `/rss/articles/…` and batchexecute endpoints, redirects confined to
 * the origin).
 */
export function googleNewsOrigin(): string {
  const raw = process.env.FEEDFERRET_GOOGLE_NEWS_BASE_URL?.trim();
  if (!raw) return GOOGLE_NEWS_ORIGIN;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return GOOGLE_NEWS_ORIGIN;
    return u.origin;
  } catch {
    return GOOGLE_NEWS_ORIGIN;
  }
}

function overrideOrigins(): string[] {
  const origin = googleNewsOrigin();
  return origin === GOOGLE_NEWS_ORIGIN ? [] : [origin];
}

/** Google News RSS URL on the public or the configured origin. */
export function isGoogleNewsFeedUrl(url: string | null | undefined): boolean {
  return isGoogleNewsRssUrl(url, overrideOrigins());
}

/** Same as `parseGoogleNewsSearchUrl`, accepting the configured origin too. */
export function parseGoogleNewsFeedUrl(url: string | null | undefined) {
  return parseGoogleNewsSearchUrl(url, overrideOrigins());
}

/**
 * True only for an RSS path (`/rss/…`) on the test-only override origin —
 * never for the public origin, never for any other path on the override host.
 */
export function isTrustedGoogleNewsOverrideUrl(url: string): boolean {
  const extra = overrideOrigins();
  if (extra.length === 0) return false;
  try {
    const u = new URL(url);
    return u.origin === extra[0] && u.pathname.startsWith("/rss/");
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Article ids                                                                */
/* -------------------------------------------------------------------------- */

const ARTICLE_PATH = /^\/(?:rss\/)?(?:articles|read)\/([A-Za-z0-9_-]{10,})\/?$/;

/** `https://news.google.com/rss/articles/CBMi…?oc=5` → `CBMi…`; null for any other link. */
export function extractGoogleNewsArticleId(link: string | null | undefined): string | null {
  if (!link) return null;
  try {
    const u = new URL(link);
    if (u.origin !== GOOGLE_NEWS_ORIGIN && !overrideOrigins().includes(u.origin)) return null;
    return ARTICLE_PATH.exec(u.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Is this still an unresolved Google News article link? */
export function isGoogleNewsArticleLink(link: string | null | undefined): boolean {
  return extractGoogleNewsArticleId(link) !== null;
}

function readVarint(bytes: Uint8Array, start: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  for (let i = start; i < bytes.length && i < start + 5; i++) {
    value |= (bytes[i] & 0x7f) << shift;
    if ((bytes[i] & 0x80) === 0) return { value: value >>> 0, next: i + 1 };
    shift += 7;
  }
  return null;
}

/** Accepts only absolute http(s) URLs that do not point back at Google News. */
export function safePublisherUrl(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string" || raw.length > 4096) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.hostname === "news.google.com" || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Offline decode of an old-format id, whose protobuf payload is the publisher
 * URL itself (`08 13 22 <varint len> <url>`). New-format ids (payload
 * `AU_yqL…`) return null — they need `batchexecute`.
 */
export function decodeGoogleNewsArticleIdOffline(id: string): string | null {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(id, "base64url"));
  } catch {
    return null;
  }
  if (bytes.length < 4 || bytes[0] !== 0x08 || bytes[1] !== 0x13 || bytes[2] !== 0x22) return null;
  const len = readVarint(bytes, 3);
  if (!len || len.value <= 0 || len.next + len.value > bytes.length) return null;
  const payload = Buffer.from(bytes.subarray(len.next, len.next + len.value)).toString("utf8");
  if (!/^https?:\/\//i.test(payload)) return null;
  return safePublisherUrl(payload);
}

/* -------------------------------------------------------------------------- */
/* batchexecute                                                               */
/* -------------------------------------------------------------------------- */

export type DecodingParams = { id: string; signature: string; timestamp: number };

/** Reads `data-n-a-sg` / `data-n-a-ts` from an article splash page. */
export function parseDecodingParams(html: string, id: string): DecodingParams | null {
  const sg = /data-n-a-sg="([^"]{8,600})"/.exec(html)?.[1];
  const ts = /data-n-a-ts="(\d{6,14})"/.exec(html)?.[1];
  if (!sg || !ts) return null;
  return { id, signature: sg, timestamp: Number(ts) };
}

/** Form body for one batchexecute POST decoding several articles; request id = list index. */
export function buildBatchExecuteBody(items: DecodingParams[]): string {
  const envelopes = items.map((item, index) => [
    "Fbv4je",
    JSON.stringify([
      "garturlreq",
      [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
      item.id,
      item.timestamp,
      item.signature,
    ]),
    null,
    String(index),
  ]);
  return `f.req=${encodeURIComponent(JSON.stringify([envelopes]))}`;
}

/**
 * Parses a batchexecute response into `article id → publisher URL`. Rows are
 * matched to requests by their request-id cell (the list index used in
 * `buildBatchExecuteBody`); malformed rows are skipped.
 */
export function parseBatchExecuteResponse(text: string, items: DecodingParams[]): Map<string, string> {
  const out = new Map<string, string>();
  const body = text.replace(/^\)\]\}'\s*/, "");
  // The payload is one JSON array, sometimes preceded by chunk-length lines.
  const start = body.indexOf("[");
  if (start < 0) return out;
  let rows: unknown;
  try {
    rows = JSON.parse(body.slice(start));
  } catch {
    // Chunked framing: try each line that looks like an array.
    rows = body
      .split("\n")
      .filter((line) => line.startsWith("["))
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      });
  }
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!Array.isArray(row) || row[0] !== "wrb.fr" || row[1] !== "Fbv4je" || typeof row[2] !== "string") continue;
    let inner: unknown;
    try {
      inner = JSON.parse(row[2]);
    } catch {
      continue;
    }
    if (!Array.isArray(inner) || inner[0] !== "garturlres") continue;
    const url = safePublisherUrl(typeof inner[1] === "string" ? inner[1] : null);
    if (!url) continue;
    const reqCell = [...row].reverse().find((cell) => cell !== null && cell !== undefined);
    const index = Number(reqCell);
    const item = Number.isInteger(index) && index >= 0 && index < items.length ? items[index] : items.length === 1 ? items[0] : null;
    if (item) out.set(item.id, url);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Resolution with budget, cache and backoff                                  */
/* -------------------------------------------------------------------------- */

type FetchFn = (url: string, init: RequestInit, options: SafeFetchTextOptions) => Promise<ConditionalFetchResult>;

const POSITIVE_CACHE_MAX = 5_000;
const NEGATIVE_TTL_MS = 60 * 60_000;
const BLOCK_BACKOFF_MS = 15 * 60_000;
const GLOBAL_CONCURRENCY = 3;
/**
 * Process-wide request budget towards Google (splash GETs + batchexecute
 * POSTs), shared by every feed and sync tick: a token bucket refilling
 * LOOKUPS_PER_MINUTE tokens per minute (burst = one minute's worth). With N
 * keyword feeds syncing in one tick the total stays bounded; whatever does not
 * fit keeps its Google link and is retried on later syncs.
 */
export const GOOGLE_NEWS_LOOKUPS_PER_MINUTE = 20;
// Live splash pages are ~600 KB; anything far bigger is not a splash page.
const SPLASH_MAX_BYTES = 1024 * 1024;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const positiveCache = new Map<string, string>();
const negativeCache = new Map<string, number>();
let blockedUntil = 0;
let active = 0;
type Waiter = { grant: (ok: boolean) => void };
const waiters: Waiter[] = [];
let tokens = GOOGLE_NEWS_LOOKUPS_PER_MINUTE;
let tokensAt = Date.now();

/** Takes `n` request tokens from the process-wide bucket, all or nothing. */
function takeTokens(n: number, now: number): boolean {
  const refill = ((now - tokensAt) / 60_000) * GOOGLE_NEWS_LOOKUPS_PER_MINUTE;
  if (refill > 0) {
    tokens = Math.min(GOOGLE_NEWS_LOOKUPS_PER_MINUTE, tokens + refill);
    tokensAt = now;
  }
  if (tokens < n) return false;
  tokens -= n;
  return true;
}

function cacheGet(id: string): string | null | undefined {
  const hit = positiveCache.get(id);
  if (hit) {
    positiveCache.delete(id);
    positiveCache.set(id, hit); // LRU touch
    return hit;
  }
  const until = negativeCache.get(id);
  if (until !== undefined) {
    if (until > Date.now()) return null;
    negativeCache.delete(id);
  }
  return undefined;
}

function cachePut(id: string, url: string | null) {
  if (url) {
    positiveCache.set(id, url);
    negativeCache.delete(id);
    if (positiveCache.size > POSITIVE_CACHE_MAX) positiveCache.delete(positiveCache.keys().next().value!);
  } else {
    negativeCache.set(id, Date.now() + NEGATIVE_TTL_MS);
    if (negativeCache.size > POSITIVE_CACHE_MAX) negativeCache.delete(negativeCache.keys().next().value!);
  }
}

/**
 * Acquires one of the GLOBAL_CONCURRENCY slots, waiting at most `waitMs`.
 * Resolves false (no slot held) when the wait runs out.
 */
function acquireSlot(waitMs: number): Promise<boolean> {
  if (active < GLOBAL_CONCURRENCY) {
    active++;
    return Promise.resolve(true);
  }
  if (waitMs <= 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const waiter: Waiter = {
      grant: (ok) => {
        clearTimeout(timer);
        resolve(ok);
      },
    };
    const timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      resolve(false);
    }, waitMs);
    waiters.push(waiter);
  });
}

/** Releases a slot: handed straight to the next waiter (no window for a newcomer to jump in). */
function releaseSlot() {
  const next = waiters.shift();
  if (next) next.grant(true);
  else active = Math.max(0, active - 1);
}

/** Runs `fn` in a slot, or returns `undefined` when no slot frees up within `waitMs`. */
async function withSlot<T>(waitMs: number, fn: () => Promise<T>): Promise<T | undefined> {
  if (!(await acquireSlot(waitMs))) return undefined;
  try {
    return await fn();
  } finally {
    releaseSlot();
  }
}

function isThrottleError(error: unknown): boolean {
  return /Fetch failed: (429|503)\b/.test(String(error));
}

/** Test hook: clears caches, backoff and the concurrency gate. */
export function resetGoogleNewsResolverState() {
  positiveCache.clear();
  negativeCache.clear();
  blockedUntil = 0;
  for (const waiter of waiters.splice(0)) waiter.grant(false);
  active = 0;
  tokens = GOOGLE_NEWS_LOOKUPS_PER_MINUTE;
  tokensAt = Date.now();
}

export type ResolveOptions = {
  /** Wall-clock budget for the whole call (ms). */
  budgetMs?: number;
  /** Max articles to resolve over the network in this call (cache hits are free). */
  maxNetwork?: number;
  /** Edition for the splash-page request (`de-DE`). */
  edition?: string;
  /** Injected for tests; defaults to the SSRF-protected fetch. */
  fetchImpl?: FetchFn;
  now?: () => number;
};

/**
 * Resolves Google News article links to publisher URLs. Returns only the links
 * it could resolve (link → publisher URL); everything else keeps its Google
 * link. Never throws, never exceeds `budgetMs` by more than one request's
 * timeout.
 */
export async function resolveGoogleNewsLinks(links: string[], options: ResolveOptions = {}): Promise<Map<string, string>> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? 8_000);
  const maxNetwork = options.maxNetwork ?? 20;
  const fetchImpl: FetchFn = options.fetchImpl ?? fetchWithSsrfProtection;
  const origin = googleNewsOrigin();
  const allowInternal = origin !== GOOGLE_NEWS_ORIGIN;
  const sameOrigin = (next: string) => (new URL(next).origin === origin ? next : null);
  const { hl, gl, ceid } = googleNewsLocaleParams(options.edition || "de-DE");

  const resolved = new Map<string, string>();
  const pending: Array<{ link: string; id: string }> = [];
  for (const link of links) {
    const id = extractGoogleNewsArticleId(link);
    if (!id) continue;
    const cached = cacheGet(id);
    if (cached) {
      resolved.set(link, cached);
      continue;
    }
    if (cached === null) continue; // recently failed
    const offline = decodeGoogleNewsArticleIdOffline(id);
    if (offline) {
      cachePut(id, offline);
      resolved.set(link, offline);
      continue;
    }
    if (!pending.some((p) => p.id === id)) pending.push({ link, id });
  }

  if (pending.length === 0 || now() < blockedUntil) return resolved;
  const work = pending.slice(0, maxNetwork);
  const remaining = () => deadline - now();
  const headers = {
    "User-Agent": BROWSER_UA,
    "Accept-Language": `${hl},${hl.split("-")[0]};q=0.9`,
    // EU clients are otherwise bounced to consent.google.com.
    Cookie: "CONSENT=YES+cb; SOCS=CAI",
  };

  // Step 1: signatures, bounded by the global gate and the time budget.
  const params: DecodingParams[] = [];
  let throttled = false;
  let outOfTokens = false;
  // The batchexecute POST needs a token too: reserved with the first splash GET.
  let postReserved = false;
  let cursor = 0;
  const worker = async () => {
    while (cursor < work.length && !throttled && !outOfTokens) {
      const item = work[cursor++];
      if (remaining() < 150) return;
      await withSlot(remaining() - 150, async () => {
        if (throttled || outOfTokens || remaining() < 150) return;
        if (!takeTokens(postReserved ? 1 : 2, now())) {
          outOfTokens = true;
          return;
        }
        postReserved = true;
        try {
          const page = await fetchImpl(
            `${origin}/rss/articles/${item.id}?hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}&ceid=${encodeURIComponent(ceid)}`,
            { headers },
            { allowInternal, redirectGuard: sameOrigin, maxRedirects: 3, maxBytes: SPLASH_MAX_BYTES, timeoutMs: Math.min(5_000, remaining()), context: "Google News link" },
          );
          const found = page.notModified ? null : parseDecodingParams(page.text, item.id);
          if (found) params.push(found);
          else cachePut(item.id, null);
        } catch (error) {
          if (isThrottleError(error)) {
            throttled = true;
            blockedUntil = now() + BLOCK_BACKOFF_MS;
            logger.warn("[google-news] throttled by Google; pausing link resolution for 15 min");
          } else {
            cachePut(item.id, null);
          }
        }
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(GLOBAL_CONCURRENCY, work.length) }, worker));

  // Step 2: one batched RPC for every signature we got.
  if (params.length > 0 && remaining() >= 100) {
    try {
      const response = await withSlot(remaining() - 100, () =>
        fetchImpl(
          `${origin}/_/DotsSplashUi/data/batchexecute`,
          {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
            body: buildBatchExecuteBody(params),
          },
          { allowInternal, maxRedirects: 0, maxBytes: 512 * 1024, timeoutMs: Math.max(100, Math.min(6_000, remaining())), context: "Google News link" },
        ),
      );
      // No slot within the budget: leave these uncached so a later sync retries.
      if (response) {
        const urls = response.notModified ? new Map<string, string>() : parseBatchExecuteResponse(response.text, params);
        for (const p of params) cachePut(p.id, urls.get(p.id) ?? null);
      }
    } catch (error) {
      if (isThrottleError(error)) {
        blockedUntil = now() + BLOCK_BACKOFF_MS;
        logger.warn("[google-news] batchexecute throttled; pausing link resolution for 15 min");
      } else {
        logger.warn("[google-news] batchexecute failed:", String(error).slice(0, 200));
      }
    }
  }

  for (const item of work) {
    const url = positiveCache.get(item.id);
    if (url) resolved.set(item.link, url);
  }
  // Same id under a different link (e.g. ?oc=5 vs none) also benefits.
  for (const p of pending) {
    if (!resolved.has(p.link)) {
      const url = positiveCache.get(p.id);
      if (url) resolved.set(p.link, url);
    }
  }
  return resolved;
}

/* -------------------------------------------------------------------------- */
/* Feed items                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Google News titles end in " - <Publisher>"; with a `<source>` element we
 * know the publisher, so strip it (and use it as the author).
 */
export function cleanGoogleNewsTitle(title: string, source: string | null | undefined): string {
  const src = source?.trim();
  if (!src) return title;
  const suffix = ` - ${src}`;
  return title.endsWith(suffix) && title.length > suffix.length ? title.slice(0, -suffix.length).trim() : title;
}
