// Parse-free feed item types and field coercion helpers, shared by the
// fetcher (main thread) and the XPath engine (lib/feed-parse-core.ts, HTML
// worker only).

export type FetchedFeedArticle = {
  /** Display title; synthesized from content when the feed supplied none. */
  title: string;
  /** `title` was synthesized from content (provenance — never a real title). */
  titleSynthetic?: true;
  /**
   * Title as stored before synthesis existed (`raw || "Untitled"`): the
   * dedupe-key input for title-based unicityCriteria. Defaults to `title`.
   */
  identityTitle?: string;
  link: string;
  content: string;
  summary?: string | null;
  author?: string | null;
  publishedAt?: Date | null;
  imageUrl?: string | null;
  enclosures?: Array<{ href: string; type: string; length?: number }>;
  /** `media:content` with an audio/video type (used when there is no such enclosure). */
  media?: { url: string; type: string } | null;
  /** `itunes:duration` / `media:content@duration`, in seconds. */
  durationSecs?: number | null;
  externalId?: string | null;
  /** The item's own guid/id as published (no link fallback); FreshRSS `sha1:*` unicity needs it. */
  guid?: string | null;
  categories?: string[];
  /** RSS `<source>` element text (publisher name on aggregators like Google News). */
  sourceName?: string | null;
};

export type FetchedFeed = {
  title?: string | null;
  description?: string | null;
  htmlUrl?: string | null;
  articles: FetchedFeedArticle[];
  /** True when the server responded 304 Not Modified — `articles` will be empty and callers should skip processing. */
  notModified?: boolean;
  /** New `ETag`/`Last-Modified` response headers, to be persisted for the next conditional GET. */
  etag?: string | null;
  lastModifiedHeader?: string | null;
};

/**
 * xml2js (used by rss-parser) represents an XML element that has BOTH
 * attributes and text content — e.g. `<category domain="...">Foo</category>`
 * — as `{ _: "Foo", $: { domain: "..." } }`, and that object has a `null`
 * prototype. `String()`/template-literal coercion on a null-prototype object
 * throws "Cannot convert object to primitive value" (no inherited
 * `toString`/`valueOf`/`Symbol.toPrimitive`), which previously crashed the
 * whole feed sync. Extract the text node explicitly instead of coercing.
 */
export function htmlText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const text = (value as { _?: unknown })._;
    return typeof text === "string" ? text.trim() : "";
  }
  return String(value).trim();
}

export function dateFrom(value: unknown, format?: string) {
  if (!value) return null;
  const raw = htmlText(value);
  if (!raw) return null;
  if (format === "U") {
    const n = Number(raw);
    if (Number.isFinite(n)) return new Date(raw.length > 10 ? n : n * 1000);
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function categoriesFrom(value: unknown) {
  if (Array.isArray(value)) return value.map(htmlText).filter(Boolean);
  const raw = htmlText(value);
  return raw ? raw.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

