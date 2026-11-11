// Generic HTTP transport fallback (no host lists): some sites refuse the
// plain undici client (heise answers 402, XenForo boards 403), others refuse
// the browser-fingerprint client (impit). When one transport is refused or
// gets an empty body, the same request is tried ONCE with the other one.
// Both go through the SSRF-protected fetch; only `impersonate` differs.

const RETRY_STATUSES = new Set(["401", "402", "403", "429"]);

/** The SSRF fetch's "Fetch failed: <status>" errors that another transport may get past. */
export function isTransportRefusal(err: unknown): boolean {
  const status = /^Fetch failed: (\d{3})\b/.exec(err instanceof Error ? err.message : String(err))?.[1];
  return status !== undefined && RETRY_STATUSES.has(status);
}

/** impit only applies to https without a per-request proxy and when it is not disabled. */
function alternateTransportAvailable(url: string): boolean {
  if (process.env.FEEDFERRET_DISABLE_IMPIT) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Runs `attempt(impersonate)` with the primary transport and, on a refusal
 * (401/402/403/429) or an empty result, once with the other one. The second
 * attempt's result wins only when it is usable; otherwise the FIRST outcome
 * (result or error) is reported, so hints such as "blocked" stay accurate.
 */
export async function withTransportFallback<T>(
  url: string,
  attempt: (impersonate: boolean) => Promise<T>,
  options: { primaryImpersonate?: boolean; isEmpty?: (result: T) => boolean } = {},
): Promise<T> {
  const primary = options.primaryImpersonate ?? false;
  const isEmpty = options.isEmpty ?? (() => false);
  let firstError: unknown;
  let firstResult: T | undefined;
  try {
    firstResult = await attempt(primary);
    if (!isEmpty(firstResult)) return firstResult;
  } catch (err) {
    if (!isTransportRefusal(err)) throw err;
    firstError = err;
  }
  if (!alternateTransportAvailable(url)) {
    if (firstError !== undefined) throw firstError;
    return firstResult as T;
  }
  try {
    const second = await attempt(!primary);
    if (!isEmpty(second)) return second;
  } catch {
    // fall through to the first outcome
  }
  if (firstError !== undefined) throw firstError;
  return firstResult as T;
}
