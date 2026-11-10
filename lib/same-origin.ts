/**
 * CSRF guard for cookie-authenticated, state-changing route handlers that Next's
 * server-action origin check does not cover. Browsers always attach `Sec-Fetch-Site`
 * (and `Origin` on cross-origin POSTs); API clients without a browser send neither and
 * are not CSRF-able because they hold no ambient cookie.
 */
export function isSameOriginRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";

  const origin = request.headers.get("origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    const host = request.headers.get("x-forwarded-host")?.split(",")[0].trim() || request.headers.get("host") || new URL(request.url).host;
    return originHost === host;
  }
  return true;
}
