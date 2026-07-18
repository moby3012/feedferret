// Optional browser-fingerprint fetch engine (Feed Intelligence M7 Tier 0).
//
// Some sites return 403 / soft-block a plain Node `fetch` (its TLS/JA3+JA4 and
// HTTP2 fingerprint doesn't look like a browser) but serve a real Chrome
// request fine. `impit` is a Rust-core HTTP client with real browser TLS+HTTP2
// fingerprints and a WHATWG-fetch-compatible API. We use it ONLY on the
// "convert a web page" paths (page→feed suggestion, AI config, full-text
// extraction) where impersonation actually helps — NOT on routine feed-XML
// sync, which already works and shouldn't have its proven fetch path changed.
//
// This never bypasses SSRF protection: callers still drive the redirect loop in
// lib/ssrf.ts and re-validate every hop; impit is only the transport, invoked
// with `redirect: "manual"` exactly like the native `fetch` it replaces.
//
// Safety valves:
//   - FEEDFERRET_DISABLE_IMPIT=1 → fall back to native fetch everywhere.
//   - If the native impit binary can't load on this platform, we log once and
//     permanently fall back to native fetch (never throws to the caller).

import { logger } from "./logger";

// The subset of the WHATWG Response the SSRF fetch loop actually touches. Both
// native `fetch` and impit's ImpitResponse satisfy this structurally.
export type FetchResponseLike = {
  status: number;
  ok: boolean;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
};

export type FetchLike = (url: string, init: RequestInit) => Promise<FetchResponseLike>;

function proxyFromEnv(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    undefined
  );
}

// Lazy singleton. `undefined` = not yet initialized; `null` = disabled/unavailable.
let cached: FetchLike | null | undefined;

/**
 * Returns a browser-impersonating fetch function, or `null` when impersonation
 * is disabled or unavailable (caller should then use native `fetch`). The
 * impit instance is created once and reused (it holds a connection pool).
 */
export function getImpitFetch(): FetchLike | null {
  if (cached !== undefined) return cached;

  if (process.env.FEEDFERRET_DISABLE_IMPIT) {
    cached = null;
    return cached;
  }

  try {
    // Require synchronously so a broken native binary is caught here, once.
     
    const { Impit } = require("impit") as typeof import("impit");
    const proxyUrl = proxyFromEnv();
    const instance = new Impit({
      browser: "chrome",
      // Preserve behaviour for self-hosters behind a corporate proxy: native
      // fetch honours *_PROXY env vars, impit needs it passed explicitly.
      ...(proxyUrl ? { proxyUrl } : {}),
    });
    cached = (url: string, init: RequestInit) =>
      // impit's RequestInit narrows `method` to a HttpMethod union; ours is the
      // wider WHATWG string. The call sites only ever pass real HTTP methods.
      instance.fetch(url, init as Parameters<typeof instance.fetch>[1]) as unknown as Promise<FetchResponseLike>;
  } catch (err) {
    logger.warn(
      "[impit] native fetch engine unavailable on this platform; falling back to plain fetch",
      err,
    );
    cached = null;
  }

  return cached;
}
