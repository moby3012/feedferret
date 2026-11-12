// "Defekte Feeds": pure helpers for the triage overview (no DB, no I/O).
//
// A feed is "broken" when the sync auto-muted it (F6, lib/feed-auto-mute.ts)
// or its current failure streak is non-empty. The server action
// (app/actions/broken-feeds.ts) and the client badge both use `isBrokenFeed`,
// so the count in the sidebar always matches the list.

import { redact } from "./redact";
import { NEWSLETTER_SOURCE_TYPE } from "./newsletter-constants";

export const STALE_BROKEN_FEED_DAYS = 30;

/** Default for `User.inactiveFeedDays`: a feed that fetches fine but published nothing for this long is "inactive". */
export const DEFAULT_INACTIVE_FEED_DAYS = 180;
export const MIN_INACTIVE_FEED_DAYS = 7;
export const MAX_INACTIVE_FEED_DAYS = 3650;

/** Clamps a stored / submitted threshold to the supported range (garbage falls back to the default). */
export function normalizeInactiveDays(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_INACTIVE_FEED_DAYS;
  return Math.min(MAX_INACTIVE_FEED_DAYS, Math.max(MIN_INACTIVE_FEED_DAYS, Math.round(n)));
}

export type BrokenFeedCategory =
  | "access"
  | "not-found"
  | "rate-limited"
  | "server"
  | "unreachable"
  | "invalid-feed"
  | "rsshub"
  | "unsafe-target"
  | "unknown";

export type BrokenFeedLike = {
  sourceType?: string | null;
  autoMuted?: boolean | null;
  lastStatus?: string | null;
  lastError?: string | null;
  consecutiveFailureCount?: number | null;
};

/** Newsletter feeds have no URL and are never fetched: they can't be "broken". */
export function isBrokenFeed(feed: BrokenFeedLike): boolean {
  if (feed.sourceType === NEWSLETTER_SOURCE_TYPE) return false;
  return feed.autoMuted === true || (feed.consecutiveFailureCount ?? 0) > 0
    || (feed.lastStatus === "attention" && feed.lastError === "HTTP 403: feed_blocked");
}

export function countBrokenFeeds(feeds: readonly BrokenFeedLike[]): number {
  let n = 0;
  for (const feed of feeds) if (isBrokenFeed(feed)) n++;
  return n;
}

/** Muted first, then the longest failure streak first, then by name. */
export function compareBrokenFeeds(
  a: { autoMuted: boolean; consecutiveFailureCount: number; name: string },
  b: { autoMuted: boolean; consecutiveFailureCount: number; name: string },
): number {
  if (a.autoMuted !== b.autoMuted) return a.autoMuted ? -1 : 1;
  if (a.consecutiveFailureCount !== b.consecutiveFailureCount) return b.consecutiveFailureCount - a.consecutiveFailureCount;
  return a.name.localeCompare(b.name);
}

/** HTTP status our fetchers put into their errors ("Fetch failed: 404 …", "Status code 500", "HTTP 403"). */
export function statusFromError(text: string): number | null {
  const m =
    /Fetch failed: (\d{3})\b/.exec(text) ??
    /\b(?:HTTP(?:\/[\d.]+)?|status(?: code)?|response)[\s:]+(\d{3})\b/i.exec(text) ??
    /\berror (\d{3})\b/i.exec(text);
  if (!m) return null;
  const status = Number(m[1]);
  return status >= 100 && status <= 599 ? status : null;
}

const NETWORK_ERROR =
  /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR|socket hang up|getaddrinfo|network|timed? ?out|timeout|aborted|certificate|\bTLS\b|\bSSL\b|impit fetch failed|Too many redirects|Redirect refused/i;
const PARSE_ERROR =
  /not (?:a )?valid (?:feed|rss|atom|xml)|not recognized as|no feed|feed not|invalid (?:feed|rss|atom|xml|json)|non-whitespace before first tag|unexpected close tag|unexpected end|unable to parse|could not parse|failed to parse|parse error|xml|json|unrecognized|mismatched tag|text data outside of root|unclosed|doctype|html instead|no items?|not well-formed/i;

/**
 * Plain-category for a stored `Feed.lastError`. `url` (the stored, secret-free
 * feed URL) only disambiguates RSSHub feeds. The input is redacted first, so a
 * caller may pass the raw column.
 */
export function categorizeFeedError(lastError: string | null | undefined, url?: string | null): BrokenFeedCategory {
  const text = redact(lastError ?? "").trim();
  const rsshubFeed = /\/rsshub\/|rsshub/i.test(url ?? "");
  if (!text) return "unknown";
  if (/private IP|localhost|only supports http|URL is invalid|is not an allowed target/i.test(text)) return "unsafe-target";
  const status = statusFromError(text);
  if (/rsshub/i.test(text) && (status === null || status >= 400)) return "rsshub";
  if (status !== null) {
    if (rsshubFeed && (status === 404 || status >= 500)) return "rsshub";
    if (status === 401 || status === 403 || status === 407) return "access";
    if (status === 404 || status === 410) return "not-found";
    if (status === 429) return "rate-limited";
    if (status >= 500) return "server";
    if (status >= 400) return "unknown";
  }
  if (rsshubFeed && NETWORK_ERROR.test(text)) return "rsshub";
  if (NETWORK_ERROR.test(text)) return "unreachable";
  if (PARSE_ERROR.test(text)) return "invalid-feed";
  return "unknown";
}

/**
 * How a broken feed fails, coarser than {@link BrokenFeedCategory}:
 * - `gone`: the address answers 404/410 — the feed moved or was removed (repair / remove).
 * - `blocked`: 403/429, typically bot protection or rate limiting against this server's IP. The feed
 *   may still work from elsewhere, but delivers nothing new here — worth a retry or a proxy, not a repair.
 * - `error`: everything else (5xx, DNS/TLS/timeouts, unparsable body, bad credentials …).
 */
export type BrokenFeedKind = "gone" | "blocked" | "error";

export function brokenKindOf(category: BrokenFeedCategory, lastError: string | null | undefined): BrokenFeedKind {
  if (category === "not-found") return "gone";
  if (category === "rate-limited") return "blocked";
  if (category === "access") {
    const status = statusFromError(redact(lastError ?? ""));
    return status === 403 ? "blocked" : "error";
  }
  return "error";
}

/** Host of a feed URL for display. Never includes userinfo, path or query (those can carry credentials). */
export function feedHost(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * Start of the current failure streak. Rows written before the `failingSince`
 * column existed fall back to their last attempt — which understates the streak,
 * so the ">30 days" bulk removal can never hit a feed that is not provably old.
 */
export function failingSinceOf(feed: {
  failingSince?: Date | null;
  lastFetchedAt?: Date | null;
  consecutiveFailureCount?: number | null;
}): Date | null {
  if (feed.failingSince) return feed.failingSince;
  if ((feed.consecutiveFailureCount ?? 0) > 0) return feed.lastFetchedAt ?? null;
  return null;
}

/** True when the failure streak began more than `days` ago (never for an unknown start). */
export function isStaleBroken(
  feed: BrokenFeedLike & { failingSince?: Date | null; lastFetchedAt?: Date | null },
  now: Date,
  days = STALE_BROKEN_FEED_DAYS,
): boolean {
  if (!isBrokenFeed(feed)) return false;
  // A feed that is merely muted by hand (no failure streak) is never "stale broken".
  const since = failingSinceOf(feed);
  if (!since) return false;
  return now.getTime() - since.getTime() > days * 86_400_000;
}

// --- Inactive feeds: they fetch fine, they just never publish anything new. -------------------------

export type InactiveFeedLike = BrokenFeedLike & {
  archivedAt?: Date | null;
  lastFetchedAt?: Date | null;
  createdAt: Date;
};

/**
 * Newest item date of a feed, falling back to the feed's creation date when it never delivered an
 * item (we have then known it for that long without receiving anything).
 */
export function lastItemAtOf(newestPublishedAt: Date | null | undefined, feed: { createdAt: Date }): Date {
  return newestPublishedAt ?? feed.createdAt;
}

/**
 * Inactive = healthy (no failure streak, not muted), already fetched at least once, not archived, and
 * the newest item is older than `days`. Broken feeds are never inactive: their silence is explained
 * by the error, which is the more actionable diagnosis.
 */
export function isInactiveFeed(
  feed: InactiveFeedLike,
  newestPublishedAt: Date | null | undefined,
  now: Date,
  days: number,
): boolean {
  if (feed.sourceType === NEWSLETTER_SOURCE_TYPE) return false;
  if (feed.archivedAt) return false;
  if (isBrokenFeed(feed)) return false;
  if (!feed.lastFetchedAt) return false;
  return now.getTime() - lastItemAtOf(newestPublishedAt, feed).getTime() > normalizeInactiveDays(days) * 86_400_000;
}

/** Whole days between `date` and `now` (never negative). */
export function daysSince(date: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86_400_000));
}
