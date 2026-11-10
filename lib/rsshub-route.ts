// Pure RSSHub route validation (no DB / fetcher imports), shared by
// lib/rsshub.ts (route validation before a user-proposed route is fetched)
// and lib/connector-secrets.ts (the fetcher only adds the access key and the
// internal-network allowance for routes that pass this check).

/**
 * Rejects route paths that are not ordinary platform routes: RSSHub's own
 * built-in `/rsshub/*` routes (incl. `/rsshub/transform/*`, which fetch an
 * arbitrary URL from inside the RSSHub network), `/api/*`, path traversal,
 * absolute or scheme-relative URLs, percent-encoded separators or an encoded
 * first segment (`/%72sshub/…`), and an attempt to pass its own `key`.
 * Returns the reason, or null when the path is acceptable.
 */
export function rsshubRouteError(routePath: string): string | null {
  const route = String(routePath ?? "").trim();
  if (!route.startsWith("/") || route.startsWith("//")) return "RSSHub route must start with a single \"/\"";
  if (route.length > 512) return "RSSHub route is too long";
  if (/[\\\s#]/.test(route) || /(^|\/)(\.|%2e){1,2}(\/|$|\?)/i.test(route) || /%5c/i.test(route)) {
    return "RSSHub route contains characters that are not allowed";
  }
  const queryAt = route.indexOf("?");
  const path = queryAt === -1 ? route : route.slice(0, queryAt);
  const query = queryAt === -1 ? "" : route.slice(queryAt + 1);
  const segments = path.split("/").slice(1);
  const decoded: string[] = [];
  for (const segment of segments) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return "RSSHub route contains characters that are not allowed";
    }
    // An encoded separator or dot-segment would let the upstream router see a
    // different path than the one checked here.
    if (/[/\\]/.test(value) || value === "." || value === ".." || /[\u0000-\u001f]/.test(value)) {
      return "RSSHub route contains characters that are not allowed";
    }
    decoded.push(value);
  }
  const rawFirst = segments[0] ?? "";
  const first = (decoded[0] ?? "").toLowerCase();
  // The namespace segment must be literal: `/%72sshub/…` decodes to `/rsshub/…`.
  if (!first || rawFirst !== decoded[0]) return "This RSSHub route is not allowed";
  if (first === "rsshub" || first === "api") return "This RSSHub route is not allowed";
  if (new URLSearchParams(query).has("key")) return "RSSHub route must not contain an access key";
  return null;
}

/** changedetection.io: the only route a feed may point at is one watch's RSS feed. */
export function changedetectionRouteError(routePath: string, query: URLSearchParams): string | null {
  if (!/^\/rss\/watch\/[A-Za-z0-9-]{1,64}$/.test(routePath)) return "Only changedetection.io single-watch feeds (/rss/watch/<uuid>) are allowed";
  for (const name of query.keys()) {
    if (name !== "token") return "changedetection.io feed URL must not carry extra parameters";
  }
  return null;
}
