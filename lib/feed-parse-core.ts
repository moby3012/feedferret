// Pure feed-item parsing helpers shared by the fetcher (main thread) and the
// HTML worker pool: the XPath scraping engine ("Von Webseite" page feeds,
// HTML+XPath / XML+XPath sources) parses untrusted pages with jsdom, so
// production code reaches `buildXPathArticles` only through lib/html-worker
// (see lib/feed-fetcher.ts). No I/O, no DB.

import { JSDOM } from "jsdom";
import type { FeedExtractionConfig } from "./feed-extraction";
import { stripStyleBlocks } from "./html-utils";
import { resolveItemTitle } from "./title-synthesis";

import { categoriesFrom, dateFrom, type FetchedFeed, type FetchedFeedArticle } from "./feed-item-fields";

export type { FetchedFeed, FetchedFeedArticle } from "./feed-item-fields";

export function evaluateString(xpath: XPathEvaluator, expression: string | undefined, context: Node) {
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

/**
 * Evaluates one XPath string expression against an HTML page
 * (HTML+XPath+JSON+DotNotation sources keep their JSON inside the page).
 */
export function evaluateXPathStringInHtml(raw: string, url: string, expression: string | undefined): string {
  const dom = new JSDOM(stripStyleBlocks(raw), { url, contentType: "text/html" });
  try {
    return evaluateString(new dom.window.XPathEvaluator(), expression, dom.window.document);
  } finally {
    dom.window.close();
  }
}
