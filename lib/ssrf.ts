import dns from "dns/promises";
import { fetch as undiciFetch } from "undici";
import { isPrivateIp } from "./private-ip";
export { isPrivateIp } from "./private-ip";
import { dispatcherFor } from "./safe-dispatcher";
import net from "net";
import { db } from "@/lib/db";
import { getPinnedImpitFetch, getImpitFetch, type FetchResponseLike } from "./impit-fetch";

export type SsrfCheckOptions = {
  allowInternal?: boolean;
  context?: string;
};

export type SafeFetchTextOptions = SsrfCheckOptions & {
  proxy?: string;
  proxyAllowInternal?: boolean;
  insecureTls?: boolean;
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  // When true, use the browser-fingerprint fetch engine (impit) instead of
  // plain `fetch` — for "convert a web page" paths that hit soft bot
  // protection. SSRF re-validation of every redirect hop is unaffected.
  // Falls back to native fetch when impit is disabled/unavailable.
  impersonate?: boolean;
  // When true, a non-2xx response's error includes a short snippet of the
  // response body (e.g. RSSHub's own "Twitter API is not configured" message)
  // instead of just the bare status code. Opt-in so ordinary feed syncs keep
  // their terse "Fetch failed: N" errors.
  includeErrorBody?: boolean;
  // Decides every redirect hop: returns the URL to follow (possibly
  // rewritten), or null to refuse the redirect (the fetch then fails). Used for
  // trusted connector requests, whose internal-network allowance must not
  // carry over to an arbitrary redirect target.
  redirectGuard?: (nextUrl: string, currentUrl: string) => string | null;
};

function truthy(value?: string) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

export async function isTrustedFeedFetchingAllowed() {
  if (truthy(process.env.TRUSTED_FEED_FETCHING) || truthy(process.env.ALLOW_INTERNAL_FEED_URLS)) {
    return true;
  }
  const settings = await db.globalSettings.findUnique({
    where: { id: "global" },
    select: { allowInternalFeedUrls: true },
  });
  return settings?.allowInternalFeedUrls === true;
}

export async function assertSafeFetchUrl(rawUrl: string, options: SsrfCheckOptions = {}) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${options.context || "Fetch"} URL is invalid`);
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${options.context || "Fetch"} only supports http/https URLs`);
  }

  if (options.allowInternal) return url;

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error(`${options.context || "Fetch"} URL points to localhost`);
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error(`${options.context || "Fetch"} URL points to a private IP`);
    return url;
  }

  const addresses = await dns.lookup(hostname, { all: true, verbatim: false });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error(`${options.context || "Fetch"} hostname resolves to a private IP`);
  }

  return url;
}

/**
 * A per-feed proxy (`CURLOPT_PROXY`) is a network target the server connects to on the
 * user's behalf, so it follows the same rules as a feed URL: http/https only and no
 * private/loopback/link-local address (including hostnames that resolve to one) unless
 * internal fetching is explicitly allowed.
 */
export async function assertSafeProxyUrl(rawUrl: string, options: { allowInternal?: boolean } = {}) {
  return assertSafeFetchUrl(rawUrl, { allowInternal: options.allowInternal, context: "Proxy" });
}

/**
 * Save-time check for a feed's `httpOptions` JSON: rejects it (throws a clear error) when
 * it carries a proxy that fails {@link assertSafeProxyUrl}. Absent/empty options pass.
 * `allowInternal` defaults to the instance-wide trusted-fetching switch.
 */
export async function assertSafeHttpOptionsProxy(httpOptions: unknown, options: { allowInternal?: boolean } = {}) {
  const proxy = proxyFromHttpOptions(httpOptions);
  if (!proxy) return;
  await assertSafeProxyUrl(proxy, { allowInternal: options.allowInternal ?? (await isTrustedFeedFetchingAllowed()) });
}

export function proxyFromHttpOptions(httpOptions: unknown): string | null {
  let parsed: unknown = httpOptions;
  if (typeof httpOptions === "string") {
    if (!httpOptions.trim()) return null;
    try {
      parsed = JSON.parse(httpOptions);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const proxy = (parsed as Record<string, unknown>).CURLOPT_PROXY;
  return proxy === undefined || proxy === null || String(proxy).trim() === "" ? null : String(proxy).trim();
}

export async function readTextWithLimit(response: FetchResponseLike, maxBytes?: number) {
  if (!maxBytes || !response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Response too large (${received} bytes > ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// Reads a short, cleaned snippet of a non-2xx response body for error
// messages (e.g. RSSHub returns "Twitter API is not configured" in the body).
// Returns "" when disabled, empty, or unreadable — never throws, so it can't
// mask the original HTTP-status error.
async function errorBodySuffix(response: FetchResponseLike, include?: boolean): Promise<string> {
  if (!include) return "";
  try {
    const raw = await readTextWithLimit(response, 8192).catch(() => "");
    const snippet = raw
      .replace(/<[^>]*>/g, " ") // drop HTML tags from error pages
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    return snippet ? ` — ${snippet}` : "";
  } catch {
    return "";
  }
}

export type ConditionalFetchResult =
  | { notModified: true; etag: string | null; lastModified: string | null }
  | { notModified: false; text: string; etag: string | null; lastModified: string | null };

/**
 * Same SSRF-protected fetch/redirect loop as `fetchTextWithSsrfProtection`, but surfaces
 * a 304 response (instead of throwing) along with the response's `ETag`/`Last-Modified`
 * headers, so callers doing conditional GET (e.g. feed sync) can short-circuit.
 */
export async function fetchWithSsrfProtection(
  rawUrl: string,
  init: RequestInit = {},
  options: SafeFetchTextOptions = {},
): Promise<ConditionalFetchResult> {
  const maxRedirects = options.maxRedirects ?? 10;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let current = rawUrl;

  const headers = new Headers(init.headers);
  let method = init.method;
  let body = init.body;

  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await safeFetch(current, {
        ...init,
        headers,
        method,
        body,
        redirect: "manual",
        signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
      }, options);

      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        let next = (await assertSafeFetchUrl(new URL(response.headers.get("location")!, current).toString(), options)).toString();
        if (options.redirectGuard) {
          const allowed = options.redirectGuard(next, current);
          if (!allowed) throw new Error(`Redirect refused: ${urlWithoutQuery(next)} is not an allowed target`);
          next = (await assertSafeFetchUrl(allowed, options)).toString();
        }
        if (new URL(next).origin !== new URL(current).origin) {
          for (const name of [...headers.keys()]) {
            if (!/^(accept.*|user-agent|if-.*)$/i.test(name)) headers.delete(name);
          }
          body = undefined;
        }
        if (response.status === 303 || ([301, 302].includes(response.status) && method?.toUpperCase() === "POST")) {
          method = "GET";
          body = undefined;
          headers.delete("content-type");
          headers.delete("content-length");
        }
        await response.body?.cancel();
        current = next;
        continue;
      }

      const etag = response.headers.get("etag");
      const lastModified = response.headers.get("last-modified");

      if (response.status === 304) {
        return { notModified: true, etag, lastModified };
      }

      if (!response.ok) {
        throw new Error(`Fetch failed: ${response.status}${await errorBodySuffix(response, options.includeErrorBody)}`);
      }
      const text = await readTextWithLimit(response, options.maxBytes);
      return { notModified: false, text, etag, lastModified };
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`Too many redirects fetching ${urlWithoutQuery(rawUrl)}`);
}

export async function fetchTextWithSsrfProtection(
  rawUrl: string,
  init: RequestInit = {},
  options: SafeFetchTextOptions = {},
): Promise<string> {
  const result = await fetchWithSsrfProtection(rawUrl, init, options);
  // No existing caller of this function sends conditional-GET headers, so a 304 here
  // would be unexpected; preserve the previous "non-2xx throws" behavior for them.
  if (result.notModified) throw new Error("Fetch failed: 304");
  return result.text;
}

/** Origin + path only: error messages end up in feed.lastError, which users see. */
function urlWithoutQuery(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "URL";
  }
}

/** One hop only: callers must explicitly validate and authorize redirects. */
export async function safeFetch(rawUrl: string, init: RequestInit = {}, options: SafeFetchTextOptions = {}): Promise<Response> {
  const url = await assertSafeFetchUrl(rawUrl, options);
  if (options.proxy) await assertSafeProxyUrl(options.proxy, { allowInternal: options.proxyAllowInternal ?? options.allowInternal });
  // Never accept a caller-supplied dispatcher: it could bypass the socket lookup.
  const { dispatcher: _ignored, ...request } = init as RequestInit & { dispatcher?: unknown };
  void _ignored;
  if (options.impersonate && url.protocol === "https:" && !options.proxy && !options.insecureTls) {
    const impit = options.allowInternal ? getImpitFetch() : await getPinnedImpitFetch();
    if (impit) return await impit(url.toString(), { ...request, redirect: "manual" }) as Response;
  }
  try {
    return await undiciFetch(url, { ...request, redirect: "manual", dispatcher: dispatcherFor(options) } as Parameters<typeof undiciFetch>[1]) as unknown as Response;
  } catch (error) {
    const cause = (error as { cause?: { code?: string } })?.cause;
    if (cause?.code === "ERR_SSRF_PRIVATE_IP") {
      throw new Error(`${options.context || "Fetch"} hostname resolves to a private IP`, { cause });
    }
    throw error;
  }
}
