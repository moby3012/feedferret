import dns from "dns/promises";
import net from "net";
import { db } from "@/lib/db";
import { getImpitFetch, type FetchResponseLike } from "./impit-fetch";

export type SsrfCheckOptions = {
  allowInternal?: boolean;
  context?: string;
};

export type SafeFetchTextOptions = SsrfCheckOptions & {
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

function isPrivateIpv4(ip: string) {
  const parts = ip.split(".").map(Number);
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    // TEST-NET-1 (RFC 5737) — reserved for documentation, never publicly
    // routed. NOTE: this is 192.0.2.0/24, not all of 192.0.0.0/16 — the rest
    // of that /16 (e.g. 192.0.78.0/23, allocated to Automattic/WordPress.com)
    // is ordinary public space and must not be blocked here.
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(ip: string) {
  // URL canonicalization handles compressed and dotted IPv4-mapped literals.
  let canonical: string;
  try {
    canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  } catch {
    // Zone IDs and unsupported literals must fail closed, never escape guards.
    return true;
  }
  const halves = canonical.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const words = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right].map(v => parseInt(v, 16));
  if (words.slice(0, 5).every(v => v === 0) && words[5] === 0xffff) {
    return isPrivateIpv4(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
  }
  // Only global unicast 2000::/3, excluding special-purpose assignments.
  // This also rejects NAT64 (64:ff9b::/96), ULA, site/link-local and multicast.
  return (words[0] & 0xe000) !== 0x2000 ||
    (words[0] === 0x2001 && (words[1] < 0x200 || words[1] === 0xdb8)) ||
    words[0] === 0x2002 || (words[0] === 0x3fff && words[1] < 0x1000);
}

export function isPrivateIp(ip: string) {
  const normalized = ip.replace(/^\[|\]$/g, "");
  const version = net.isIP(normalized);
  if (version === 4) return isPrivateIpv4(normalized);
  if (version === 6) return isPrivateIpv6(normalized);
  return true;
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

async function readTextWithLimit(response: FetchResponseLike, maxBytes?: number) {
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
  // Browser-fingerprint transport for "convert a web page" callers; plain
  // fetch (unchanged behaviour) otherwise. Either way we drive redirects
  // manually and re-validate every hop below, so SSRF protection is identical.
  const doFetch: (url: string, init: RequestInit) => Promise<FetchResponseLike> =
    options.impersonate ? getImpitFetch() ?? fetch : fetch;
  let current = (await assertSafeFetchUrl(rawUrl, options)).toString();

  const headers = new Headers(init.headers);

  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    await assertSafeFetchUrl(current, options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(current, {
        ...init,
        headers,
        redirect: "manual",
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        const next = (await assertSafeFetchUrl(new URL(response.headers.get("location")!, current).toString(), options)).toString();
        if (new URL(next).origin !== new URL(current).origin) {
          headers.delete("authorization");
          headers.delete("cookie");
          headers.delete("proxy-authorization");
        }
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

  throw new Error(`Too many redirects fetching ${rawUrl}`);
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
