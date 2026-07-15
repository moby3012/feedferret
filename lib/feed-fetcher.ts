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
import { fetchWithSsrfProtection, isTrustedFeedFetchingAllowed, type ConditionalFetchResult } from "./ssrf";
import { logger } from "./logger";

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
};

export type FetchedFeedArticle = {
  title: string;
  link: string;
  content: string;
  summary?: string | null;
  author?: string | null;
  publishedAt?: Date | null;
  imageUrl?: string | null;
  externalId?: string | null;
  categories?: string[];
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

const parser = new Parser();

function splitHeaderLines(value?: unknown) {
  if (typeof value !== "string") return [];
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function htmlText(value: unknown) {
  if (value === null || value === undefined) return "";
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
  const raw = String(value).trim();
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

function categoriesFrom(value: unknown) {
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
    articles: items.map((item) => ({
      title: firstString(dotGet(item, settings.jsonItemTitle || settings.itemTitle || "title")) || "Untitled",
      link: firstString(dotGet(item, settings.jsonItemUri || settings.itemUri || "url")) || firstString(dotGet(item, "external_url")),
      content: itemContent(dotGet(item, settings.jsonItemContent || settings.itemContent || "content_html")) || itemContent(dotGet(item, "content_text")),
      summary: firstString(dotGet(item, "summary")),
      author: firstString(dotGet(item, settings.jsonItemAuthor || settings.itemAuthor || "author.name")) || firstString(dotGet(item, "author")),
      publishedAt: dateFrom(dotGet(item, settings.jsonItemTimestamp || settings.itemTimestamp || "date_published"), settings.jsonItemTimeFormat || settings.itemTimeFormat),
      imageUrl: firstString(dotGet(item, settings.jsonItemThumbnail || settings.itemThumbnail || "image")) || firstString(dotGet(item, "banner_image")),
      externalId: firstString(dotGet(item, settings.jsonItemUid || settings.itemUid || "id")),
      categories: categoriesFrom(dotGet(item, settings.jsonItemCategories || settings.itemCategories || "tags")),
    })),
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

function buildXPathArticles(raw: string, feedUrl: string, config: FeedExtractionConfig, contentType: "text/html" | "text/xml"): FetchedFeed {
  const dom = new JSDOM(raw, { url: feedUrl, contentType });
  const document = dom.window.document;
  const xpath = new dom.window.XPathEvaluator();
  const settings = config.xpath ?? {};
  const itemExpression = settings.xPathItem || settings.item;
  if (!itemExpression) return { articles: [] };

  const result = xpath.evaluate(itemExpression, document, null, 7, null);
  const articles: FetchedFeedArticle[] = [];
  for (let i = 0; i < result.snapshotLength; i++) {
    const node = result.snapshotItem(i);
    if (!node) continue;
    const rawLink = evaluateString(xpath, settings.xPathItemUri || settings.itemUri, node);
    const link = rawLink ? new URL(rawLink, feedUrl).toString() : "";
    const rawImage = evaluateString(xpath, settings.xPathItemThumbnail || settings.itemThumbnail, node);
    articles.push({
      title: evaluateString(xpath, settings.xPathItemTitle || settings.itemTitle, node) || "Untitled",
      link,
      content: evaluateContent(xpath, settings.xPathItemContent || settings.itemContent, node),
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

function extractImageFromHtml(html: string) {
  const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return imgMatch ? imgMatch[1] : null;
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

async function fetchText(feed: FeedFetchConfig, accept: string): Promise<ConditionalFetchResult> {
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
  };

  if (http.CURLOPT_PROXY) {
    try {
      const { ProxyAgent } = await import("undici");
      (init as any).dispatcher = new ProxyAgent(String(http.CURLOPT_PROXY));
    } catch (error) {
      logger.warn("[feed-fetcher] proxy requested but undici ProxyAgent failed", error);
    }
  } else if (feed.sslVerify === false) {
    try {
      const { Agent } = await import("undici");
      (init as any).dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    } catch (error) {
      logger.warn("[feed-fetcher] sslVerify=false requested but undici Agent failed", error);
    }
  }

  return fetchWithSsrfProtection(feed.url, init, {
    allowInternal: await isTrustedFeedFetchingAllowed(),
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
      const content = item.content || item["content:encoded"] || item.summary || item.contentSnippet || "";
      return {
        title: item.title || "Untitled",
        link: item.link || "",
        content,
        summary: item.summary || item.contentSnippet || null,
        author: item.creator || item.author || null,
        publishedAt: item.pubDate ? new Date(item.pubDate) : item.isoDate ? new Date(item.isoDate) : null,
        imageUrl: extractImageFromHtml(content) || item.enclosure?.url || item["media:content"]?.$?.url || null,
        externalId: item.guid || item.id || item.link || null,
        categories: categoriesFrom(item.categories),
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
    const dom = new JSDOM(result.text, { url: feed.url, contentType: "text/html" });
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
