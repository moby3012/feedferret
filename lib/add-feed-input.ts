// Shared server-side plumbing for every "add a feed from what the user typed"
// entry point (Server Actions, REST v1, MCP): input normalisation with stable
// error codes the UI localises, page-fetch error codes, and the
// discovery-first step ("this page already has a feed — take it?").

import { discoverFeeds, type DiscoveredFeed } from "./feed-discovery";
import { checkRateLimit, RATE_LIMITS } from "./rate-limit";
import { isTlsError, normalizeUrlInput, URL_INPUT_ERROR_TEXT, type UrlInputErrorCode } from "./url-input";

export type AddFeedErrorCode =
  | UrlInputErrorCode
  | "not-a-feed"
  | "no-feed-found"
  | "page-blocked"
  | "page-not-found"
  | "page-rate-limited"
  | "page-http-error"
  | "page-private-address"
  | "page-too-large"
  | "page-unreachable"
  | "page-tls-error"
  | "ai-not-configured"
  | "ai-rate-limited"
  | "ai-unreadable"
  | "ai-no-config"
  | "ai-failed";

export type NormalizedActionUrl =
  | { ok: true; url: string; schemeAssumed: boolean }
  | { ok: false; error: string; errorCode: UrlInputErrorCode };

/** `normalizeUrlInput` with an English fallback text for API/MCP callers. */
export function normalizeActionUrl(raw: unknown): NormalizedActionUrl {
  const n = normalizeUrlInput(raw);
  if (!n.ok) return { ok: false, error: URL_INPUT_ERROR_TEXT[n.code], errorCode: n.code };
  return n;
}

export const TLS_ERROR_TEXT =
  "The secure (HTTPS) connection to this site failed: certificate or TLS error. For your safety we don't switch to unencrypted http automatically. If you trust the site, enter the address with http:// explicitly.";

/** Stable code for a page-fetch failure (the UI shows a localised sentence). */
export function pageFetchErrorCode(error: unknown): AddFeedErrorCode {
  if (isTlsError(error)) return "page-tls-error";
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/private IP|localhost|internal/i.test(message)) return "page-private-address";
  if (/too large/i.test(message)) return "page-too-large";
  const status = /Fetch failed: (\d+)/.exec(message);
  if (status) {
    const code = Number(status[1]);
    if (code === 401 || code === 402 || code === 403) return "page-blocked";
    if (code === 404 || code === 410) return "page-not-found";
    if (code === 429) return "page-rate-limited";
    return "page-http-error";
  }
  return "page-unreachable";
}

/** The client-safe subset of a discovery result row. */
export type ClientDiscoveredFeed = Pick<DiscoveredFeed, "url" | "title" | "type" | "source" | "kind" | "platform" | "via">;

export function discoveredFeedForClient(feed: DiscoveredFeed): ClientDiscoveredFeed {
  return {
    url: feed.url,
    title: feed.title,
    type: feed.type,
    ...(feed.source ? { source: feed.source } : {}),
    ...(feed.kind ? { kind: feed.kind } : {}),
    ...(feed.platform ? { platform: feed.platform } : {}),
    ...(feed.via ? { via: feed.via } : {}),
  };
}

const MAX_OFFERED_FEEDS = 5;

/**
 * Discovery-first: the page's real feeds (advertised, linked, common paths,
 * curated fallback) before any scraping or AI. Shares the `/api/discover`
 * per-user rate limit; when that is exhausted, discovery is skipped (the
 * caller continues with its own path) rather than failing the request.
 * `pageUrl` is the address actually read (redirects / http fallback applied).
 */
export async function discoverExistingFeeds(
  userId: string,
  input: string,
): Promise<{ feeds: ClientDiscoveredFeed[]; pageUrl: string | null; tlsError?: boolean }> {
  if (!checkRateLimit(`user:${userId}`, RATE_LIMITS.urlDiscover).success) return { feeds: [], pageUrl: null };
  try {
    const result = await discoverFeeds(input);
    if (result.mode !== "url") return { feeds: [], pageUrl: null };
    return {
      feeds: result.feeds.slice(0, MAX_OFFERED_FEEDS).map(discoveredFeedForClient),
      pageUrl: result.pageUrl ?? null,
      // The page's https failed on certificate/TLS (the browser-fingerprint
      // transport used later only reports an opaque connect failure).
      ...(result.hint === "tls-error" ? { tlsError: true } : {}),
    };
  } catch {
    return { feeds: [], pageUrl: null };
  }
}

/** Same URL for "is this the address the user gave us?" (scheme, trailing slash, host case). */
export function sameFeedAddress(a: string, b: string): boolean {
  const key = (u: string) => {
    try {
      const url = new URL(u);
      const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
      return `${url.host.toLowerCase()}${path}${url.search}`;
    } catch {
      return u;
    }
  };
  return key(a) === key(b);
}
