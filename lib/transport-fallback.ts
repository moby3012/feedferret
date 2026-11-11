// Generic HTTP transport fallback (no host lists): some sites refuse the
// plain undici client (heise answers 402, XenForo boards 403), others refuse
// the browser-fingerprint client (impit). When one transport is refused or
// gets an empty body, the same request is tried ONCE with the other one.
// Both go through the SSRF-protected fetch; only `impersonate` differs.
//
// A rate limit is NOT a refusal: 429 — or any response that carries a
// Retry-After — is never retried on the other transport (that would just be a
// second request the server asked us not to send). Callers record it and stop
// probing the host (lib/discovery-budget.ts).

import { isRateLimitResponse } from "./discovery-budget";

const REFUSAL_STATUSES = new Set(["401", "402", "403"]);

/** The SSRF fetch's "Fetch failed: <status>" refusals that another transport may get past. */
export function isTransportRefusal(err: unknown): boolean {
  if (isRateLimitResponse(err)) return false;
  const status = /^Fetch failed: (\d{3})\b/.exec(err instanceof Error ? err.message : String(err))?.[1];
  return status !== undefined && REFUSAL_STATUSES.has(status);
}

/** impit only applies to https and when it is not disabled. */
function alternateTransportAvailable(url: string): boolean {
  if (process.env.FEEDFERRET_DISABLE_IMPIT) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export type TransportFallbackOptions<T> = {
  primaryImpersonate?: boolean;
  /** A "successful" result that is really a refusal (empty 200 bot-wall body). */
  isEmpty?: (result: T) => boolean;
  /** Asked right before the second attempt (request budget, deadline, host block). False = no retry. */
  beforeRetry?: () => boolean;
  /** Every failed attempt (both transports), e.g. to block a rate-limited host. */
  onFailure?: (err: unknown) => void;
};

/**
 * Runs `attempt(impersonate)` with the primary transport and, on a refusal
 * (401/402/403) or an empty result, once with the other one. The second
 * attempt's result wins only when it is usable; otherwise the FIRST outcome
 * (result or error) is reported, so hints such as "blocked" stay accurate.
 */
export async function withTransportFallback<T>(
  url: string,
  attempt: (impersonate: boolean) => Promise<T>,
  options: TransportFallbackOptions<T> = {},
): Promise<T> {
  const primary = options.primaryImpersonate ?? false;
  const isEmpty = options.isEmpty ?? (() => false);
  let firstError: unknown;
  let firstResult: T | undefined;
  try {
    firstResult = await attempt(primary);
    if (!isEmpty(firstResult)) return firstResult;
  } catch (err) {
    options.onFailure?.(err);
    if (!isTransportRefusal(err)) throw err;
    firstError = err;
  }
  const report = (): T => {
    if (firstError !== undefined) throw firstError;
    return firstResult as T;
  };
  if (!alternateTransportAvailable(url)) return report();
  if (options.beforeRetry && !options.beforeRetry()) return report();
  try {
    const second = await attempt(!primary);
    if (!isEmpty(second)) return second;
  } catch (err) {
    options.onFailure?.(err);
  }
  return report();
}
