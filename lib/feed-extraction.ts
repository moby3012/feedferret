export const OPML_EXTENSION_NAMESPACE = "https://fresh" + "rss.org/opml";
// FreshRSS reads its attributes by qualified name (`frss:cssFullContent`, lib_opml
// uses DOM `nodeName`), not by namespace URI: any other prefix is silently ignored
// there, so exports must use exactly this one.
export const OPML_EXTENSION_PREFIX = "frss";
/** Prefix used by FeedFerret exports before the FreshRSS-compatible one (still read on import). */
export const LEGACY_OPML_EXTENSION_PREFIXES = ["ffx"] as const;

export const EXTRACTION_SOURCE_TYPES = new Set([
  "rss",
  "HTML+XPath",
  "XML+XPath",
  "JSON+DotNotation",
  "JSON+DotPath",
  "JSONFeed",
  "HTML+XPath+JSON+DotNotation",
]);

export const XPATH_ATTRS = [
  "xPathItem",
  "xPathItemTitle",
  "xPathItemContent",
  "xPathItemUri",
  "xPathItemAuthor",
  "xPathItemTimestamp",
  "xPathItemTimeFormat",
  "xPathItemThumbnail",
  "xPathItemCategories",
  "xPathItemUid",
] as const;

export const JSON_ATTRS = [
  "jsonItem",
  "jsonItemTitle",
  "jsonItemContent",
  "jsonItemUri",
  "jsonItemAuthor",
  "jsonItemTimestamp",
  "jsonItemTimeFormat",
  "jsonItemThumbnail",
  "jsonItemCategories",
  "jsonItemUid",
] as const;

export const HTTP_ATTRS = [
  "CURLOPT_COOKIE",
  "CURLOPT_COOKIEFILE",
  "CURLOPT_FOLLOWLOCATION",
  "CURLOPT_HTTPHEADER",
  "CURLOPT_MAXREDIRS",
  "CURLOPT_POST",
  "CURLOPT_POSTFIELDS",
  "CURLOPT_PROXY",
  "CURLOPT_PROXYTYPE",
  "CURLOPT_USERAGENT",
] as const;

/**
 * Request headers a feed's `CURLOPT_HTTPHEADER` may never set: they would re-target or
 * desync the request (virtual host, framing, connection reuse) instead of describing it.
 * Enforced by the fetcher for every source (import, feed dialog, REST/MCP).
 */
export const BLOCKED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "host", "content-length", "transfer-encoding", "connection", "keep-alive", "upgrade",
  "te", "trailer", "expect", "proxy-connection",
]);
/** Upper bound for `CURLOPT_MAXREDIRS`. */
export const MAX_FEED_REDIRECTS = 20;

export type FeedExtractionConfig = {
  xpath?: Record<string, string>;
  json?: Record<string, string>;
  xPathToJson?: string;
  /** Source-specific extension attributes (e.g. unknown `frss:*` OPML attributes) preserved verbatim. */
  extensions?: Record<string, string>;
  /**
   * Known `frss:*` values that FeedFerret cannot represent exactly in its own fields
   * (e.g. read filters it cannot evaluate, a refresh interval outside its range). Kept
   * only so an export writes the original value back; never used for fetching.
   */
  preserved?: Partial<Record<"filtersActionRead" | "ttl", string>>;
};

export type FeedHttpOptions = Record<string, string | number | boolean>;

export function normalizeSourceType(type?: string | null) {
  if (!type) return "rss";
  const lower = type.toLowerCase();
  if (lower === "json+dotpath") return "JSON+DotNotation";
  for (const known of EXTRACTION_SOURCE_TYPES) {
    if (known.toLowerCase() === lower) return known === "JSON+DotPath" ? "JSON+DotNotation" : known;
  }
  return "rss";
}

export function parseBooleanLike(value?: string | null) {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function parseIntLike(value?: string | null) {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseJsonObject<T extends object>(value?: string | null): T {
  if (!value) return {} as T;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : ({} as T);
  } catch {
    return {} as T;
  }
}

export function stringifyNonEmpty(value: unknown) {
  if (!value || typeof value !== "object") return null;
  if (Object.keys(value).length === 0) return null;
  return JSON.stringify(value);
}
