// Parse-free feed item types and field coercion helpers, shared by the
// fetcher (main thread) and the XPath engine (lib/feed-parse-core.ts, HTML
// worker only).

import { parsePhpDate } from "./php-date-format";

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
  /** Title exactly as supplied by the feed ("" when none); FreshRSS `sha1:*title*` criteria hash it. */
  rawTitle?: string;
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

/** Matches `dd.mm.yyyy` / `d.m.yy` with an optional `HH:mm[:ss]` (and "Uhr") — dot dates are day-first. */
const DOTTED_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*Uhr)?)?$/;

/**
 * Format-less date guess. Dot-separated dates (`12.08.2026`) are day-first as everywhere
 * they are written; the engine's own parser (`new Date`) would read them US-style
 * (Dec 8). Everything else keeps going through `new Date(raw)`.
 */
export function parseLooseDate(raw: string): Date | null {
  const dotted = DOTTED_DATE.exec(raw.trim());
  if (dotted) {
    const [, d, m, y, hh, mm, ss] = dotted;
    const year = y.length === 2 ? (Number(y) < 70 ? 2000 : 1900) + Number(y) : Number(y);
    const format = `d.m.Y${hh ? " H:i" : ""}${ss ? ":s" : ""}`;
    const text = `${d}.${m}.${String(year).padStart(4, "0")}${hh ? ` ${hh}:${mm}` : ""}${ss ? `:${ss}` : ""}`;
    return parsePhpDate(text, format);
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function dateFrom(value: unknown, format?: string) {
  if (!value) return null;
  const raw = htmlText(value);
  if (!raw) return null;
  if (format === "U") {
    const n = Number(raw);
    if (Number.isFinite(n)) return new Date(raw.length > 10 ? n : n * 1000);
  }
  return parseLooseDate(raw);
}

/**
 * Date of a scraped (XPath) item. With a configured PHP `createFromFormat` format the
 * string is parsed strictly by it and a mismatch yields `null` — never a guess. Without
 * a format it falls back to the loose guess of {@link parseLooseDate}.
 */
export function scrapedDateFrom(value: unknown, format?: string): Date | null {
  const raw = htmlText(value);
  if (!raw) return null;
  const phpFormat = format?.trim();
  return phpFormat ? parsePhpDate(raw, phpFormat) : parseLooseDate(raw);
}

export function categoriesFrom(value: unknown) {
  if (Array.isArray(value)) return value.map(htmlText).filter(Boolean);
  const raw = htmlText(value);
  return raw ? raw.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

