import { createHash } from "crypto";

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
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
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

export function computeContentHash(link: string): string {
  return createHash("sha256")
    .update(normalizeArticleUrl(link))
    .digest("hex")
    .slice(0, 32);
}
