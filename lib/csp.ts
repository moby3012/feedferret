import { legacyCsp } from "./csp-legacy.mjs";

export { legacyCsp };

/**
 * L3 rollout switch (`FEEDFERRET_CSP`, read per request, so a restart flips it):
 * - `report` (default): the old static policy (next.config.mjs) stays ENFORCED and the
 *   nonce policy is added as `Content-Security-Policy-Report-Only` — no behaviour change,
 *   only reports.
 * - `legacy`: rollback — no nonce, no report-only policy, no reports; only the old policy.
 * Unknown values fall back to `report`. Enforcing the nonce policy is PR 7.
 */
export type CspMode = "report" | "legacy";

export function cspMode(value: string | undefined): CspMode {
  return value === "legacy" ? "legacy" : "report";
}

/** 128 random bits, base64 — matches Next's nonce regex (`[A-Za-z0-9+/_-]+={0,2}`). */
export function createNonce(): string {
  return btoa(crypto.randomUUID());
}

export function nonceCsp(nonce: string, development = false): string {
  return [
    "default-src 'self'",
    // CSP3: 'strict-dynamic' trusts chunks loaded by nonce'd scripts and ignores 'self';
    // 'self' stays as the CSP2 fallback. React refresh needs eval in dev only.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    // The old `blob:` worker allowance is unused (push runs in /sw.js).
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "frame-src https://www.youtube-nocookie.com https://player.vimeo.com https://www.dailymotion.com https://player.twitch.tv https://clips.twitch.tv",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "report-to csp",
    "report-uri /api/csp-report",
  ].join("; ");
}

export const REPORTING_ENDPOINTS = 'csp="/api/csp-report"';

export interface CspHeaders {
  /** Forwarded to the renderer as the request's `content-security-policy`: Next reads
   * the nonce from it (parse-request-headers.js) and stamps its framework / Flight
   * scripts. Never sent to clients. Absent in legacy mode. */
  requestPolicy?: string;
  /** `x-nonce` for the root layout (next-themes); absent in legacy mode. */
  nonce?: string;
  /**
   * Added to the proxy response (pages and auth redirects). Never an enforced
   * `Content-Security-Policy`: Next copies every proxy response header onto the request
   * too (router-utils/resolve-routes.js), so an enforced header here would replace
   * `requestPolicy` and Next would render without a nonce. The enforced policy comes
   * from next.config.mjs, which only touches the response.
   */
  response: Record<string, string>;
}

export function cspHeaders(mode: CspMode, nonce: string, development = false): CspHeaders {
  if (mode === "legacy") return { response: {} };
  const policy = nonceCsp(nonce, development);
  return {
    requestPolicy: policy,
    nonce,
    response: { "Content-Security-Policy-Report-Only": policy, "Reporting-Endpoints": REPORTING_ENDPOINTS },
  };
}
