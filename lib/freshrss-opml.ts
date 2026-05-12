export const FRSS_NAMESPACE = "https://freshrss.org/opml";

export const FRESHRSS_SOURCE_TYPES = new Set([
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

export type FreshRssScraperConfig = {
  xpath?: Record<string, string>;
  json?: Record<string, string>;
  xPathToJson?: string;
};

export type FreshRssHttpOptions = Record<string, string | number | boolean>;

export function normalizeSourceType(type?: string | null) {
  if (!type) return "rss";
  const lower = type.toLowerCase();
  if (lower === "json+dotpath") return "JSON+DotNotation";
  for (const known of FRESHRSS_SOURCE_TYPES) {
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
