// Page → feed candidate-suggestion engine (Phase 2 M3).
//
// Given a listing page (blog index, forum, search results), this proposes one
// or more XPath scraping configs that FeedFerret's existing HTML+XPath engine
// (`buildXPathArticles`) can turn into feed items — so a user doesn't have to
// hand-write XPath. Each candidate is validated by running its proposed config
// through the real engine and is only kept if that yields real, linked items.
//
// This is a heuristic first pass; M4's AI layer and later polish will harden
// selector quality on messy real-world pages. Pure/testable: `suggestFeed
// Candidates` takes HTML and does no network I/O.

import { JSDOM } from "jsdom";
import { buildXPathArticles, type FetchedFeedArticle } from "./feed-fetcher";
import { fetchTextWithSsrfProtection, isTrustedFeedFetchingAllowed } from "./ssrf";

export type SuggestedFieldConfig = {
  xPathItem: string;
  xPathItemTitle?: string;
  xPathItemUri?: string;
  xPathItemContent?: string;
  xPathItemTimestamp?: string;
  xPathItemThumbnail?: string;
};

export type FeedCandidate = {
  config: SuggestedFieldConfig;
  score: number;
  itemCount: number;
  sampleTitles: string[];
  previewArticles: FetchedFeedArticle[];
};

// A repeating item must appear at least this many times to be a candidate —
// fewer than this is more likely a one-off layout block than a feed list.
const MIN_REPEAT = 3;
const PREVIEW_CAP = 10;

// Below this score a "candidate" is almost always navigation/footer chrome
// or an unrelated repeating widget, not a real item list — most commonly
// because the page's actual content list is rendered client-side (JS-only)
// and never reached our static fetch, leaving only structural chrome for the
// heuristic to see. A legitimate blog/listing candidate scores comfortably
// above this even in the minimal case (3 short-titled, fully-linked items
// with no date/image/content bonuses scores ~46; a real 5-item blog post
// list with metadata scores ~88 — see tests). Confidently presenting a
// sub-threshold candidate as "found" is worse than the honest "nothing
// found" empty state, which points users at the manual/AI routes instead.
const MIN_CANDIDATE_SCORE = 20;

/** Wrap a literal in an XPath string, tolerating single quotes via concat(). */
function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  // Split on ' and rejoin with concat( ..., "'", ... )
  const parts = value.split("'").map((p) => `'${p}'`);
  return `concat(${parts.join(`, "'", `)})`;
}

/** XPath predicate that matches an element carrying `token` in its class list. */
function hasClassPredicate(token: string): string {
  return `contains(concat(' ', normalize-space(@class), ' '), ${xpathLiteral(` ${token} `)})`;
}

function classTokens(el: Element): string[] {
  return (el.getAttribute("class") || "")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Structural signature of a child element: tag + sorted class list. */
function signatureOf(el: Element): string {
  return `${el.tagName.toLowerCase()}#${classTokens(el).sort().join(".")}`;
}

type Group = {
  container: Element;
  itemTag: string;
  items: Element[];
};

/** Collect groups of >= MIN_REPEAT structurally-similar sibling elements. */
function collectGroups(document: Document): Group[] {
  const groups: Group[] = [];
  const containers = document.querySelectorAll("*");
  for (const container of Array.from(containers)) {
    const children = Array.from(container.children);
    if (children.length < MIN_REPEAT) continue;
    const bySig = new Map<string, Element[]>();
    for (const child of children) {
      const sig = signatureOf(child);
      const list = bySig.get(sig) ?? [];
      list.push(child);
      bySig.set(sig, list);
    }
    for (const items of bySig.values()) {
      if (items.length >= MIN_REPEAT) {
        groups.push({ container, itemTag: items[0].tagName.toLowerCase(), items });
      }
    }
  }
  return groups;
}

/** Tokens shared by every item, useful for a stable item selector. */
function sharedClassTokens(items: Element[]): string[] {
  if (items.length === 0) return [];
  let shared = new Set(classTokens(items[0]));
  for (const item of items.slice(1)) {
    const tokens = new Set(classTokens(item));
    shared = new Set([...shared].filter((t) => tokens.has(t)));
  }
  return [...shared];
}

function buildItemXPath(group: Group): string | null {
  const { container, itemTag, items } = group;
  const shared = sharedClassTokens(items).sort((a, b) => b.length - a.length);
  if (shared.length > 0) {
    return `//${itemTag}[${hasClassPredicate(shared[0])}]`;
  }
  const containerId = container.getAttribute("id");
  if (containerId) {
    return `//*[@id=${xpathLiteral(containerId)}]/${itemTag}`;
  }
  const containerClasses = classTokens(container).sort((a, b) => b.length - a.length);
  if (containerClasses.length > 0) {
    return `//*[${hasClassPredicate(containerClasses[0])}]/${itemTag}`;
  }
  const containerTag = container.tagName.toLowerCase();
  if (containerTag !== "body" && containerTag !== "html") {
    return `//${containerTag}/${itemTag}`;
  }
  return null;
}

/** True when any item contains a descendant matching `selector`. */
function anyItemHas(items: Element[], selector: string): number {
  let count = 0;
  for (const item of items) if (item.querySelector(selector)) count++;
  return count / items.length;
}

function firstHeadingTag(items: Element[]): string | null {
  for (const tag of ["h1", "h2", "h3", "h4"]) {
    if (anyItemHas(items, tag) >= 0.5) return tag;
  }
  return null;
}

function isInsideChrome(el: Element): boolean {
  let node: Element | null = el;
  while (node) {
    const tag = node.tagName.toLowerCase();
    if (tag === "nav" || tag === "header" || tag === "footer") return true;
    node = node.parentElement;
  }
  return false;
}

function buildFieldConfig(group: Group, xPathItem: string): SuggestedFieldConfig {
  const { items } = group;
  const config: SuggestedFieldConfig = { xPathItem };

  if (anyItemHas(items, "a[href]") > 0) config.xPathItemUri = ".//a/@href";

  const heading = firstHeadingTag(items);
  if (heading) config.xPathItemTitle = `.//${heading}`;
  else if (anyItemHas(items, "a") > 0) config.xPathItemTitle = ".//a";

  if (anyItemHas(items, "time[datetime]") >= 0.5) config.xPathItemTimestamp = ".//time/@datetime";
  else if (anyItemHas(items, "time") >= 0.5) config.xPathItemTimestamp = ".//time";

  if (anyItemHas(items, "img[src]") >= 0.5) config.xPathItemThumbnail = ".//img/@src";

  if (anyItemHas(items, "p") >= 0.5) config.xPathItemContent = ".//p";

  return config;
}

function averageTextLength(items: Element[]): number {
  if (items.length === 0) return 0;
  const total = items.reduce((sum, item) => sum + (item.textContent?.trim().length || 0), 0);
  return total / items.length;
}

/**
 * Proposes ranked scraping configs for the repeating items on a page. Returns
 * `[]` (never throws) when nothing qualifies.
 */
export function suggestFeedCandidates(rawHtml: string, url: string): FeedCandidate[] {
  const dom = new JSDOM(rawHtml, { url });
  const groups = collectGroups(dom.window.document);

  const candidates: FeedCandidate[] = [];
  const seenSelectors = new Set<string>();

  for (const group of groups) {
    const xPathItem = buildItemXPath(group);
    if (!xPathItem || seenSelectors.has(xPathItem)) continue;
    seenSelectors.add(xPathItem);

    const config = buildFieldConfig(group, xPathItem);

    // Validate through the REAL engine — a candidate only counts if the engine
    // parses it into linked items.
    let parsed;
    try {
      const xpath: Record<string, string> = {};
      for (const [key, value] of Object.entries(config)) {
        if (value) xpath[key] = value;
      }
      parsed = buildXPathArticles(rawHtml, url, { xpath }, "text/html");
    } catch {
      continue;
    }
    const articles = parsed.articles;
    if (articles.length < MIN_REPEAT) continue;
    const linked = articles.filter((a) => a.link && a.link.trim().length > 0);
    if (linked.length === 0) continue;

    const linkFraction = linked.length / articles.length;
    const realTitles = articles.map((a) => a.title).filter((t) => t && t !== "Untitled");
    const avgTitleLen = realTitles.length
      ? realTitles.reduce((s, t) => s + t.length, 0) / realTitles.length
      : 0;
    const avgTextLen = averageTextLength(group.items);

    let score = 0;
    score += Math.min(articles.length, 20) * 2; // repetition (damped)
    score += linkFraction * 20;
    score += Math.min(avgTitleLen, 40); // title quality
    if (config.xPathItemTimestamp) score += 10;
    if (config.xPathItemContent) score += 10;
    if (config.xPathItemThumbnail) score += 5;
    if (isInsideChrome(group.items[0])) score -= 40; // nav/header/footer
    if (avgTextLen < 20) score -= 30; // tiny items → likely a menu

    candidates.push({
      config,
      score,
      itemCount: articles.length,
      sampleTitles: realTitles.slice(0, 5),
      previewArticles: articles.slice(0, PREVIEW_CAP),
    });
  }

  return candidates
    .filter((c) => c.score >= MIN_CANDIDATE_SCORE)
    .sort((a, b) => b.score - a.score);
}

/** SSRF-safe wrapper: fetch the URL, then suggest candidates. Fetch errors propagate. */
export async function fetchAndSuggestFeedCandidates(url: string): Promise<FeedCandidate[]> {
  const html = await fetchTextWithSsrfProtection(
    url,
    {},
    {
      allowInternal: await isTrustedFeedFetchingAllowed(),
      context: "Page feed",
      impersonate: true,
      maxBytes: 2 * 1024 * 1024,
      maxRedirects: 5,
      timeoutMs: 12_000,
    },
  );
  return suggestFeedCandidates(html, url);
}
