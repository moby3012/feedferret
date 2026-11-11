import { createHash } from "crypto";
import { stripFragment, trimTrailingSlashes } from "@/lib/linear-text";

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "fbclid", "gclid", "msclkid", "mc_cid", "mc_eid",
  "ref", "source", "origin", "referrer",
  "_ga", "igshid", "s_cid", "yclid", "zanpid",
]);

export function normalizeArticleUrl(url: string): string {
  try {
    const u = new URL(url);
    u.protocol = "https:";
    u.hostname = u.hostname.replace(/^www\./, "").toLowerCase();
    u.pathname = trimTrailingSlashes(u.pathname) || "/";
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        u.searchParams.delete(key);
      }
    }
    u.searchParams.sort();
    u.hash = "";
    return u.toString();
  } catch {
    return url.trim().toLowerCase();
  }
}

// Extra query parameters that never select a different page: session ids and
// campaign/click trackers beyond TRACKING_PARAMS (whose exact set feeds
// contentHash and therefore stays unchanged).
const VOLATILE_PARAM = /^(?:utm_.*|_hs[a-z]+|mkt_tok|oly_.*|vero_.*|ck_subscriber_id|sid|sessionid|session_id|phpsessid|jsessionid|aspsessionid.*|cfid|cftoken|_+ga|_gl)$/i;

/**
 * Normalised form of an article link for "is this the same page?" checks:
 * scheme-insensitive, lower-case host without www., no fragment, no trailing
 * slash, tracking/session params removed, remaining params sorted. Only for
 * comparison — never stored.
 */
export function normalizeLinkForComparison(url: string): string {
  try {
    const u = new URL(normalizeArticleUrl(url));
    for (const key of [...u.searchParams.keys()]) {
      if (VOLATILE_PARAM.test(key)) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    const query = u.searchParams.toString();
    return `${u.hostname}${u.port ? `:${u.port}` : ""}${trimTrailingSlashes(u.pathname) || "/"}${query ? `?${query}` : ""}`;
  } catch {
    return trimTrailingSlashes(stripFragment(url.trim().toLowerCase()));
  }
}

export function computeContentHash(link: string): string {
  return createHash("sha256")
    .update(normalizeArticleUrl(link))
    .digest("hex")
    .slice(0, 32);
}
