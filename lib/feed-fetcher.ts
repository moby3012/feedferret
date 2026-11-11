import Parser from "rss-parser";
import { JSDOM } from "jsdom";
import {
  FeedHttpOptions,
  FeedExtractionConfig,
  normalizeSourceType,
  parseBooleanLike,
  parseIntLike,
  parseJsonObject,
} from "./feed-extraction";
import { assertSafeProxyUrl, fetchWithSsrfProtection, isTrustedFeedFetchingAllowed, type ConditionalFetchResult } from "./ssrf";
import { logger } from "./logger";
import { readFeedCredentials } from "./feed-secrets";
import { isTrustedGoogleNewsOverrideUrl } from "./google-news";
import { stripStyleBlocks } from "./html-utils";
import { parseDurationSecs } from "./article-kind";
import { resolveItemTitle } from "./title-synthesis";
import { firstImgSrc } from "@/lib/linear-text";

export type FeedFetchConfig = {
  url: string;
  name?: string | null;
  sourceType?: string | null;
  authType?: string | null;
  authUsername?: string | null;
  authPassword?: string | null;
  customUserAgent?: string | null;
  fetchTimeoutSecs?: number | null;
  sslVerify?: boolean;
  maxSizeKb?: number | null;
  scraperConfig?: string | null;
  httpOptions?: string | null;
  /** Previously-stored conditional-GET headers; when present, sent as If-None-Match / If-Modified-Since. */
  etag?: string | null;
  lastModifiedHeader?: string | null;
  /**
   * Force-allow internal/private fetch targets for this one fetch, bypassing
   * the SSRF private-address block. Used by trusted optional connectors
   * (RSSHub route validation) whose base URL is a private Docker hostname.
   * When unset, internal access is allowed only if the instance-wide
   * "allow internal feed URLs" setting is on, or the URL is an allowed feed
   * route on a configured connector (see lib/connector-secrets.ts).
   */
  allowInternal?: boolean;
  /**
   * When true, a non-2xx response surfaces a snippet of the upstream error
   * body (e.g. RSSHub's "Twitter API is not configured") instead of a bare
   * "Fetch failed: N". Used by RSSHub route validation to give actionable
   * errors; left off for ordinary syncs.
   */
  includeErrorBody?: boolean;
  /** Aborts the fetch (feed discovery's run deadline). */
  signal?: AbortSignal;
  /**
   * Called for every redirect hop before any other redirect policy; false
   * refuses the hop (feed discovery counts hops against its request budget).
   */
  onRedirect?: (nextUrl: string) => boolean;
};

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

// `media:content` is collected under a private key so the existing
// `item["media:content"]` image fallback below keeps its current behaviour.
const parser = new Parser({ customFields: { item: [["media:content", "ffMediaContent", { keepArray: true }], ["source", "ffSource"]] } });

type MediaContentNode = { $?: { url?: string; type?: string; medium?: string; duration?: string } };

/** First audio/video `media:content` (+ its duration) of an rss-parser item. */
export function mediaFromItem(item: { ffMediaContent?: unknown; itunes?: { duration?: unknown } }): {
  media: { url: string; type: string } | null;
  durationSecs: number | null;
} {
  const nodes = Array.isArray(item.ffMediaContent) ? (item.ffMediaContent as MediaContentNode[]) : [];
  let media: { url: string; type: string } | null = null;
  let mediaDuration: number | null = null;
  for (const node of nodes) {
    const attrs = node?.$;
    const url = typeof attrs?.url === "string" ? attrs.url.trim() : "";
    if (!url) continue;
    const type = typeof attrs?.type === "string" ? attrs.type.trim().toLowerCase() : "";
    const medium = typeof attrs?.medium === "string" ? attrs.medium.trim().toLowerCase() : "";
    const resolved = /^(audio|video)\//.test(type) ? type : medium === "audio" || medium === "video" ? `${medium}/*` : "";
    if (!resolved) continue;
    media = { url, type: resolved };
    mediaDuration = parseDurationSecs(attrs?.duration);
    break;
  }
  return { media, durationSecs: parseDurationSecs(htmlText(item.itunes?.duration)) ?? mediaDuration };
}

function splitHeaderLines(value?: unknown) {
  if (typeof value !== "string") return [];
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

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

function dotGet(input: unknown, path?: string): unknown {
  if (!path) return input;
  const tokens = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  let current: any = input;
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;
    current = current[token];
  }
  return current;
}

function dateFrom(value: unknown, format?: string) {
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

function firstString(value: unknown) {
  if (Array.isArray(value)) return htmlText(value[0]);
  return htmlText(value);
}

export function categoriesFrom(value: unknown) {
  if (Array.isArray(value)) return value.map(htmlText).filter(Boolean);
  const raw = htmlText(value);
  return raw ? raw.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function itemContent(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function buildJsonArticles(json: unknown, config: FeedExtractionConfig): FetchedFeed {
  const settings = config.json ?? {};
  const itemsValue = dotGet(json, settings.jsonItem || settings.item || "items");
  const items = Array.isArray(itemsValue) ? itemsValue : [];

  return {
    title: firstString(dotGet(json, "title")),
    description: firstString(dotGet(json, "description")),
    htmlUrl: firstString(dotGet(json, "home_page_url")) || firstString(dotGet(json, "feed_url")),
    articles: items.map((item) => {
      const content = itemContent(dotGet(item, settings.jsonItemContent || settings.itemContent || "content_html")) || itemContent(dotGet(item, "content_text"));
      const summary = firstString(dotGet(item, "summary"));
      const rawTitle = firstString(dotGet(item, settings.jsonItemTitle || settings.itemTitle || "title"));
      return {
        ...resolveItemTitle(rawTitle, content, summary),
        link: firstString(dotGet(item, settings.jsonItemUri || settings.itemUri || "url")) || firstString(dotGet(item, "external_url")),
        content,
        summary,
        author: firstString(dotGet(item, settings.jsonItemAuthor || settings.itemAuthor || "author.name")) || firstString(dotGet(item, "author")),
        publishedAt: dateFrom(dotGet(item, settings.jsonItemTimestamp || settings.itemTimestamp || "date_published"), settings.jsonItemTimeFormat || settings.itemTimeFormat),
        imageUrl: firstString(dotGet(item, settings.jsonItemThumbnail || settings.itemThumbnail || "image")) || firstString(dotGet(item, "banner_image")),
        externalId: firstString(dotGet(item, settings.jsonItemUid || settings.itemUid || "id")),
        categories: categoriesFrom(dotGet(item, settings.jsonItemCategories || settings.itemCategories || "tags")),
      };
    }),
  };
}

function evaluateString(xpath: XPathEvaluator, expression: string | undefined, context: Node) {
  if (!expression) return "";
  try {
    const result = xpath.evaluate(expression, context, null, 2, null);
    return result.stringValue.trim();
  } catch {
    return "";
  }
}

function evaluateContent(xpath: XPathEvaluator, expression: string | undefined, context: Node) {
  if (!expression) return "";
  try {
    const result = xpath.evaluate(expression, context, null, 0, null);
    if (result.resultType === 4 || result.resultType === 5) {
      const node = result.iterateNext();
      if (!node) return "";
      if (node.nodeType === 1) return (node as Element).innerHTML;
      return node.textContent?.trim() ?? "";
    }
    if (result.resultType === 2) return result.stringValue.trim();
    return String(result.stringValue ?? "").trim();
  } catch {
    return "";
  }
}

export function buildXPathArticles(raw: string, feedUrl: string, config: FeedExtractionConfig, contentType: "text/html" | "text/xml"): FetchedFeed {
  // Strip <style> from HTML pages so jsdom's CSS parser can't crash on
  // `border: var(--border-width,…)` shorthands (see html-utils). XML feeds
  // have no style blocks, so leave those untouched.
  const source = contentType === "text/html" ? stripStyleBlocks(raw) : raw;
  const dom = new JSDOM(source, { url: feedUrl, contentType });
  try {
    return buildXPathArticlesFromDocument(dom.window.document, new dom.window.XPathEvaluator(), feedUrl, config);
  } finally {
    dom.window.close();
  }
}

/**
 * The XPath extraction engine over an already-parsed document. The page →
 * feed suggester validates many candidate configs against one page; parsing
 * the (up to 2 MiB) HTML once per candidate instead exhausted memory on large
 * news homepages. `buildXPathArticles` is the single-config entry point.
 */
export function buildXPathArticlesFromDocument(
  document: Document,
  xpath: XPathEvaluator,
  feedUrl: string,
  config: FeedExtractionConfig,
  /** Optional out-param: receives the matched item nodes (saves the caller a second evaluation). */
  itemNodes?: Node[],
): FetchedFeed {
  const settings = config.xpath ?? {};
  const itemExpression = settings.xPathItem || settings.item;
  if (!itemExpression) return { articles: [] };

  const result = xpath.evaluate(itemExpression, document, null, 7, null);
  const articles: FetchedFeedArticle[] = [];
  for (let i = 0; i < result.snapshotLength; i++) {
    const node = result.snapshotItem(i);
    if (!node) continue;
    itemNodes?.push(node);
    const rawLink = evaluateString(xpath, settings.xPathItemUri || settings.itemUri, node);
    const link = rawLink ? new URL(rawLink, feedUrl).toString() : "";
    const rawImage = evaluateString(xpath, settings.xPathItemThumbnail || settings.itemThumbnail, node);
    const content = evaluateContent(xpath, settings.xPathItemContent || settings.itemContent, node);
    const rawTitle = evaluateString(xpath, settings.xPathItemTitle || settings.itemTitle, node);
    articles.push({
      ...resolveItemTitle(rawTitle, content),
      link,
      content,
      author: evaluateString(xpath, settings.xPathItemAuthor || settings.itemAuthor, node) || null,
      publishedAt: dateFrom(evaluateString(xpath, settings.xPathItemTimestamp || settings.itemTimestamp, node), settings.xPathItemTimeFormat || settings.itemTimeFormat),
      imageUrl: rawImage ? new URL(rawImage, feedUrl).toString() : null,
      externalId: evaluateString(xpath, settings.xPathItemUid || settings.itemUid, node) || link,
      categories: categoriesFrom(evaluateString(xpath, settings.xPathItemCategories || settings.itemCategories, node)),
    });
  }

  return {
    title: evaluateString(xpath, settings.feedTitle, document) || null,
    articles,
  };
}

export function extractImageFromHtml(html: string) {
  // Feed item HTML is attacker-controlled and parsed in the background sync:
  // linear scanner instead of `/<img[^>]+src=…/` (O(n²) on "<img <img <img …").
  return firstImgSrc(html);
}

function parseHttpOptions(feed: FeedFetchConfig) {
  return parseJsonObject<FeedHttpOptions>(feed.httpOptions);
}

function headersFromFeed(feed: FeedFetchConfig, http: FeedHttpOptions) {
  const headers: Record<string, string> = {};
  for (const header of splitHeaderLines(http.CURLOPT_HTTPHEADER)) {
    const idx = header.indexOf(":");
    if (idx > 0) headers[header.slice(0, idx).trim()] = header.slice(idx + 1).trim();
  }
  const userAgent = String(http.CURLOPT_USERAGENT || feed.customUserAgent || "FeedFerret/1.0 (+https://github.com/moby3012/feedferret)");
  headers["User-Agent"] = userAgent;
  if (feed.authType === "basic" && feed.authUsername) {
    const creds = `${feed.authUsername}:${feed.authPassword ?? ""}`;
    headers.Authorization = `Basic ${Buffer.from(creds).toString("base64")}`;
  }
  if (http.CURLOPT_COOKIE) headers.Cookie = String(http.CURLOPT_COOKIE);
  if (feed.etag) headers["If-None-Match"] = feed.etag;
  if (feed.lastModifiedHeader) headers["If-Modified-Since"] = feed.lastModifiedHeader;
  return headers;
}

async function fetchText(storedFeed: FeedFetchConfig, accept: string): Promise<ConditionalFetchResult> {
  // Decrypts v2-sealed credentials; an undecryptable value throws (fetch error status, M8).
  const feed = readFeedCredentials(storedFeed);
  const http = parseHttpOptions(feed);
  const timeoutMs = (feed.fetchTimeoutSecs ?? 30) * 1000;
  const maxBytes = feed.maxSizeKb ? feed.maxSizeKb * 1024 : 5 * 1024 * 1024;
  const maxRedirects = parseIntLike(String(http.CURLOPT_MAXREDIRS ?? "")) ?? 10;
  const follow = http.CURLOPT_FOLLOWLOCATION === undefined ? true : parseBooleanLike(String(http.CURLOPT_FOLLOWLOCATION));
  const headers = headersFromFeed(feed, http);
  headers.Accept = accept;
  const init: RequestInit = {
    method: parseBooleanLike(String(http.CURLOPT_POST ?? "")) ? "POST" : "GET",
    body: http.CURLOPT_POSTFIELDS ? String(http.CURLOPT_POSTFIELDS) : undefined,
    headers,
    ...(feed.signal ? { signal: feed.signal } : {}),
  };

  // Internal fetch targets are allowed when: the caller forced it (trusted
  // connector validation), OR the instance-wide switch is on, OR the URL is an
  // allowed feed route on a configured optional connector (RSSHub platform
  // route / changedetection.io single-watch feed on the private Docker
  // network). Only those routes also get the connector secret (RSSHub key,
  // changedetection.io token), which is never stored in feed URLs or shown to
  // users: any other path on the connector host (`/rsshub/transform/…`, …)
  // gets neither, so it can't be used as a read-SSRF proxy (N3).
  const trustedInstance = feed.allowInternal === true || (await isTrustedFeedFetchingAllowed());
  const { getConnectorSecretRules, resolveConnectorRequestWith, stripConnectorSecretsWith } = await import("./connector-secrets");
  const secretRules = await getConnectorSecretRules();
  let connector = resolveConnectorRequestWith(secretRules, feed.url);
  if (http.CURLOPT_PROXY) {
    // A user-chosen proxy sees the full request URL (plain HTTP, or the
    // CONNECT target), so it would receive the admin's connector secret. Such
    // a feed is fetched like any external URL instead: keyless (legacy keyed
    // rows stripped too), no internal-network allowance.
    // Applies to untrusted rows too (legacy keyed URL on a no-longer-allowed route).
    connector = { url: stripConnectorSecretsWith(secretRules, connector.url), trusted: false };
  }
  // TEST-ONLY Google News origin override (FEEDFERRET_GOOGLE_NEWS_BASE_URL, the
  // e2e fixture server; never set in production): only its `/rss/…` paths are
  // trusted past the private-address block, redirects stay on them. The
  // public news.google.com never needs it.
  const googleNewsOverride = !trustedInstance && !connector.trusted && isTrustedGoogleNewsOverrideUrl(connector.url);
  const allowInternal = trustedInstance || connector.trusted || googleNewsOverride;
  // Trusted connector request: the internal allowance (and the secret) only
  // follow redirects to another allowed route on the same connector origin.
  const connectorOrigin = connector.trusted ? new URL(connector.url).origin : null;
  const policyGuard =
    connectorOrigin
      ? (next: string) => {
          if (new URL(next).origin !== connectorOrigin) return null;
          const hop = resolveConnectorRequestWith(secretRules, next);
          return hop.trusted ? hop.url : null;
        }
      : googleNewsOverride
        ? (next: string) => (isTrustedGoogleNewsOverrideUrl(next) ? next : null)
        : undefined;
  const onRedirect = feed.onRedirect;
  const redirectGuard = onRedirect
    ? (next: string) => (onRedirect(next) ? (policyGuard ? policyGuard(next) : next) : null)
    : policyGuard;

  if (http.CURLOPT_PROXY) {
    // The proxy host is a connection target of its own: apply the same SSRF rules as to the
    // feed URL, and fail the fetch (never fall back to a direct request) when it is unsafe.
    // Connector-host trust covers the feed URL only; it must not unlock an internal proxy.
    await assertSafeProxyUrl(String(http.CURLOPT_PROXY), { allowInternal: trustedInstance });
  }

  return fetchWithSsrfProtection(connector.url, init, {
    allowInternal,
    proxy: http.CURLOPT_PROXY ? String(http.CURLOPT_PROXY) : undefined,
    proxyAllowInternal: trustedInstance,
    insecureTls: feed.sslVerify === false && !connector.trusted,
    redirectGuard,
    includeErrorBody: feed.includeErrorBody,
    context: "Feed fetch",
    maxBytes,
    maxRedirects: follow ? maxRedirects : 0,
    timeoutMs,
  });
}

const NOT_MODIFIED_FEED: FetchedFeed = { articles: [], notModified: true };

function notModifiedResult(result: Extract<ConditionalFetchResult, { notModified: true }>): FetchedFeed {
  return { ...NOT_MODIFIED_FEED, etag: result.etag, lastModifiedHeader: result.lastModified };
}

async function fetchRssOrAtom(feed: FeedFetchConfig): Promise<FetchedFeed> {
  const result = await fetchText(feed, "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*");
  if (result.notModified) return notModifiedResult(result);

  const parsed = await parser.parseString(result.text);
  return {
    title: parsed.title,
    description: parsed.description,
    htmlUrl: parsed.link,
    etag: result.etag,
    lastModifiedHeader: result.lastModified,
    articles: parsed.items.map((item: any) => {
      // Any of these RSS/Atom fields can come back as an xml2js mixed-content
      // node (`{ _: text, $: attrs }`, null-prototype) rather than a plain
      // string whenever the source feed puts an attribute on that element —
      // routing them through `htmlText` avoids the "Cannot convert object to
      // primitive value" crash that raw coercion (String()/`+`/`new Date()`
      // on such a node) throws.
      const content = htmlText(item.content) || htmlText(item["content:encoded"]) || htmlText(item.summary) || htmlText(item.contentSnippet);
      const pubDate = htmlText(item.pubDate) || htmlText(item.isoDate);
      return {
        ...resolveItemTitle(htmlText(item.title), content, htmlText(item.summary), htmlText(item.contentSnippet)),
        link: htmlText(item.link),
        content,
        summary: htmlText(item.summary) || htmlText(item.contentSnippet) || null,
        author: htmlText(item.creator) || htmlText(item.author) || null,
        publishedAt: pubDate ? dateFrom(pubDate) : null,
        imageUrl: extractImageFromHtml(content) || item.enclosure?.url || item["media:content"]?.$?.url || null,
        externalId: htmlText(item.guid) || htmlText(item.id) || htmlText(item.link) || null,
        enclosures: item.enclosure?.url ? [{ href: item.enclosure.url, type: item.enclosure.type || "", ...(Number(item.enclosure.length) > 0 ? { length: Number(item.enclosure.length) } : {}) }] : [],
        ...mediaFromItem(item),
        categories: categoriesFrom(item.categories),
        sourceName: htmlText(item.ffSource) || null,
      };
    }),
  } satisfies FetchedFeed;
}

export async function fetchFeedArticles(feed: FeedFetchConfig): Promise<FetchedFeed> {
  const sourceType = normalizeSourceType(feed.sourceType);
  const scraperConfig = parseJsonObject<FeedExtractionConfig>(feed.scraperConfig);

  if (sourceType === "JSONFeed" || sourceType === "JSON+DotNotation") {
    const result = await fetchText(feed, "application/feed+json,application/json,*/*");
    if (result.notModified) return notModifiedResult(result);
    return {
      ...buildJsonArticles(JSON.parse(result.text), scraperConfig),
      etag: result.etag,
      lastModifiedHeader: result.lastModified,
    };
  }

  if (sourceType === "HTML+XPath") {
    const result = await fetchText(feed, "text/html,application/xhtml+xml,*/*");
    if (result.notModified) return notModifiedResult(result);
    return {
      ...buildXPathArticles(result.text, feed.url, scraperConfig, "text/html"),
      etag: result.etag,
      lastModifiedHeader: result.lastModified,
    };
  }

  if (sourceType === "XML+XPath") {
    const result = await fetchText(feed, "application/xml,text/xml,*/*");
    if (result.notModified) return notModifiedResult(result);
    return {
      ...buildXPathArticles(result.text, feed.url, scraperConfig, "text/xml"),
      etag: result.etag,
      lastModifiedHeader: result.lastModified,
    };
  }

  if (sourceType === "HTML+XPath+JSON+DotNotation") {
    const result = await fetchText(feed, "text/html,application/xhtml+xml,*/*");
    if (result.notModified) return notModifiedResult(result);
    const dom = new JSDOM(stripStyleBlocks(result.text), { url: feed.url, contentType: "text/html" });
    const xpath = new dom.window.XPathEvaluator();
    const jsonText = evaluateString(xpath, scraperConfig.xPathToJson, dom.window.document);
    return {
      ...buildJsonArticles(JSON.parse(jsonText), scraperConfig),
      etag: result.etag,
      lastModifiedHeader: result.lastModified,
    };
  }

  return fetchRssOrAtom(feed);
}
