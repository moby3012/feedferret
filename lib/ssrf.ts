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
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(ip: string) {
  const lower = ip.toLowerCase();
  return (
    lower === "::1" ||
    lower === "::" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80:") ||
    lower.startsWith("::ffff:127.") ||
    lower.startsWith("::ffff:10.") ||
    lower.startsWith("::ffff:192.168.") ||
    lower.startsWith("::ffff:169.254.")
  );
}

export function isPrivateIp(ip: string) {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
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

  const hostname = url.hostname.toLowerCase();
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

  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    await assertSafeFetchUrl(current, options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(current, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        current = (await assertSafeFetchUrl(new URL(response.headers.get("location")!, current).toString(), options)).toString();
        continue;
      }

      const etag = response.headers.get("etag");
      const lastModified = response.headers.get("last-modified");

      if (response.status === 304) {
        return { notModified: true, etag, lastModified };
      }

      if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
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
