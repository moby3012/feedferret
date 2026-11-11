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
import { buildXPathArticlesFromDocument, type FetchedFeedArticle } from "./feed-fetcher";
import {
  assessPreviewQuality,
  classifyItem,
  isPlaceholderTitle,
  normalizeTitle,
  type ItemIssue,
  type PreviewNote,
  type PreviewQuality,
  type PreviewRejectReason,
  type PreviewReviewReason,
} from "./page-feed-quality";
import { fetchTextWithSsrfProtection, isTrustedFeedFetchingAllowed } from "./ssrf";
import { stripStyleBlocks } from "./html-utils";
import { renderViaSidecar } from "./render-sidecar";

export type SuggestedFieldConfig = {
  xPathItem: string;
  xPathItemTitle?: string;
  xPathItemUri?: string;
  xPathItemContent?: string;
  xPathItemTimestamp?: string;
  xPathItemThumbnail?: string;
};

export type CandidateQuality = {
  /** "ok" = plausible entry list; "review" = offered, but the UI must ask the user to check. */
  verdict: "ok" | "review";
  reasons: PreviewReviewReason[];
  /** Informational (e.g. "missingDates"): shown in the preview, never a review label. */
  notes: PreviewNote[];
  /** Distinct items that look like real entries (≥ 3 by construction). */
  plausibleItems: number;
};

export type FeedCandidate = {
  config: SuggestedFieldConfig;
  score: number;
  itemCount: number;
  sampleTitles: string[];
  previewArticles: FetchedFeedArticle[];
  /** Per preview item: why it looks like a non-entry (null = plausible), aligned with previewArticles. */
  previewIssues: Array<ItemIssue | null>;
  quality: CandidateQuality;
};

export type SuggestionResult = {
  candidates: FeedCandidate[];
  /** Structurally valid candidates dropped by the preview quality gate. */
  rejected: { count: number; reasons: Partial<Record<PreviewRejectReason, number>> };
};

// A repeating item must appear at least this many times to be a candidate —
// fewer than this is more likely a one-off layout block than a feed list.
const MIN_REPEAT = 3;
const PREVIEW_CAP = 10;
// Work bounds for pathological pages (hundreds of repeating blocks): only the
// largest groups are validated, within a wall-clock budget.
const MAX_GROUPS = 40;
const SUGGEST_TIME_BUDGET_MS = 1_500;

/** Largest repeating groups first, one per derived item selector, capped. */
function limitGroups(groups: Group[]): Group[] {
  const seen = new Set<string>();
  const out: Group[] = [];
  for (const group of [...groups].sort((a, b) => b.items.length - a.items.length)) {
    const xPathItem = buildItemXPath(group);
    if (!xPathItem || seen.has(xPathItem)) continue;
    seen.add(xPathItem);
    out.push(group);
    if (out.length >= MAX_GROUPS) break;
  }
  return out;
}

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

// Title field options, in preference order: [CSS probe, XPath used by the engine].
const TITLE_OPTIONS: Array<[string, string]> = [
  ["h1", ".//h1"],
  ["h2", ".//h2"],
  ["h3", ".//h3"],
  ["h4", ".//h4"],
  ["h5", ".//h5"],
  ["h6", ".//h6"],
  ['[class*="title"]', ".//*[contains(@class, 'title')]"],
  ['[class*="headline"]', ".//*[contains(@class, 'headline')]"],
  // Mixed heading levels across cards (a lead story in <h2>, the rest in <h3>):
  // the first heading of any level, so no card is dropped as "untitled".
  ["h1, h2, h3, h4, h5, h6", ".//*[self::h1 or self::h2 or self::h3 or self::h4 or self::h5 or self::h6]"],
  ["a", ".//a"],
];

/**
 * Pick the title field that yields the most distinct, non-placeholder titles
 * (ties keep the earlier, more semantic option). Lever's job board has only an
 * "Apply" link before the `<h5>` vacancy name; a first-heading rule limited to
 * h1–h4 fell back to that link and titled every vacancy "Apply".
 */
function pickTitleXPath(items: Element[]): { css: string; xpath: string } | null {
  let best: { css: string; xpath: string; distinct: number } | null = null;
  for (const [css, xpath] of TITLE_OPTIONS) {
    let present = 0;
    const distinct = new Set<string>();
    for (const item of items) {
      const el = item.querySelector(css);
      if (!el) continue;
      present++;
      const text = el.textContent?.trim() ?? "";
      if (!isPlaceholderTitle(text)) distinct.add(normalizeTitle(text));
    }
    if (present / items.length < 0.5 && css !== "a") continue;
    if (present === 0) continue;
    if (!best || distinct.size > best.distinct) best = { css, xpath, distinct: distinct.size };
  }
  return best ? { css: best.css, xpath: best.xpath } : null;
}

/**
 * Pick the link that belongs to the title: the title element itself, an
 * anchor inside it, or an anchor wrapping it. A card's FIRST link is often a
 * section kicker ("/sections/economy" on NPR) or an "Apply" button, not the
 * entry. Falls back to the first link in the item.
 */
function pickLinkXPath(items: Element[], title: { css: string; xpath: string } | null): string | null {
  if (anyItemHas(items, "a[href]") === 0) return null;
  if (title && title.css !== "a") {
    let own = 0;
    let inner = 0;
    let wrapping = 0;
    for (const item of items) {
      const el = item.querySelector(title.css);
      if (!el) continue;
      if (el.matches("a[href]")) own++;
      else if (el.querySelector("a[href]")) inner++;
      else {
        const anchor = el.closest("a[href]");
        if (anchor && item.contains(anchor)) wrapping++;
      }
    }
    const half = items.length / 2;
    if (own >= half) return `${title.xpath}/@href`;
    if (inner >= half) return `${title.xpath}//a/@href`;
    if (wrapping >= half) return `.//a[${title.xpath}]/@href`;
  }
  return ".//a/@href";
}

const CHROME_TAGS = new Set(["nav", "header", "footer"]);
const CHROME_TOKEN = /^(nav|navi|navigation|navbar|menu|menus|megamenu|submenu|flyout|footer|breadcrumb|breadcrumbs|sitemap|social|share|sharing|toolbar|skiplinks|skip)$/i;
const CHROME_ROLES = new Set(["navigation", "menu", "menubar", "contentinfo", "banner"]);

/**
 * Item sits in site chrome: a nav/header/footer element, an ARIA navigation
 * landmark, or a container whose class/id names a menu/footer/social block
 * (`bpa-footer-social-media-item`). Stops at <main>/<article> and never reads
 * <body>/<html> classes, which often carry layout flags like "has-navbar".
 */
function isInsideChrome(el: Element): boolean {
  let node: Element | null = el;
  while (node) {
    const tag = node.tagName.toLowerCase();
    if (tag === "main" || (tag === "article" && node !== el) || tag === "body" || tag === "html") return false;
    if (CHROME_TAGS.has(tag)) return true;
    const role = node.getAttribute("role");
    if (role && CHROME_ROLES.has(role.toLowerCase())) return true;
    const tokens = `${node.getAttribute("class") ?? ""} ${node.getAttribute("id") ?? ""}`.split(/[\s_-]+/);
    if (tokens.some((t) => CHROME_TOKEN.test(t))) return true;
    node = node.parentElement;
  }
  return false;
}

/** Average number of distinct link targets per item: a container of many entries, not an entry. */
function averageDistinctLinks(items: Element[]): number {
  if (items.length === 0) return 0;
  let total = 0;
  for (const item of items) {
    total += new Set(Array.from(item.querySelectorAll("a[href]")).map((a) => a.getAttribute("href"))).size;
  }
  return total / items.length;
}

function buildFieldConfig(group: Group, xPathItem: string): SuggestedFieldConfig {
  const { items } = group;
  const config: SuggestedFieldConfig = { xPathItem };

  const title = pickTitleXPath(items);
  if (title) config.xPathItemTitle = title.xpath;

  const link = pickLinkXPath(items, title);
  if (link) config.xPathItemUri = link;

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

function runConfig(
  document: Document,
  xpath: XPathEvaluator,
  url: string,
  config: SuggestedFieldConfig,
  itemNodes?: Node[],
): FetchedFeedArticle[] | null {
  const settings: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value) settings[key] = value;
  }
  try {
    return buildXPathArticlesFromDocument(document, xpath, url, { xpath: settings }, itemNodes).articles;
  } catch {
    return null;
  }
}

/**
 * Narrow the item selector when a MINORITY of items is unusable in a way the
 * selector itself can exclude: cards without a link, image-only twin cards without a title (Spiegel,
 * NPR, Le Monde) and ad-click teasers (heise's DoubleClick card). The repaired
 * config is what gets saved, so the feed itself is cleaner — not just the
 * preview. Returns null when no repair applies or it would drop below 3 items.
 */
function repairConfig(
  document: Document,
  xpath: XPathEvaluator,
  url: string,
  config: SuggestedFieldConfig,
  articles: FetchedFeedArticle[],
): { config: SuggestedFieldConfig; articles: FetchedFeedArticle[]; nodes: Node[] } | null {
  const predicates: string[] = [];
  const untitled = articles.filter((a) => a.titleSynthetic || !a.title || a.title === "Untitled").length;
  if (config.xPathItemTitle && untitled > 0 && untitled < articles.length) {
    predicates.push(`[normalize-space(${config.xPathItemTitle})]`);
  }
  // Cards without a link would become link-less feed items.
  const unlinked = articles.filter((a) => !a.link || !a.link.trim()).length;
  if (config.xPathItemUri && unlinked > 0 && unlinked < articles.length) {
    predicates.push(`[${config.xPathItemUri}]`);
  }
  if (config.xPathItemUri) {
    const page = new URL(url);
    const adHosts = new Set<string>();
    for (const a of articles) {
      if (a.link && classifyItem(a, page) === "ad") {
        try {
          adHosts.add(new URL(a.link).hostname.toLowerCase());
        } catch {
          /* unparsable links are not ad-filterable */
        }
      }
    }
    if (adHosts.size > 0 && adHosts.size <= 5) {
      const conditions = [...adHosts].map((host) => `contains(${config.xPathItemUri}, ${xpathLiteral(host)})`);
      predicates.push(`[not(${conditions.join(" or ")})]`);
    }
  }
  if (predicates.length === 0) return null;
  const repaired = { ...config, xPathItem: `(${config.xPathItem})${predicates.join("")}` };
  const nodes: Node[] = [];
  const repairedArticles = runConfig(document, xpath, url, repaired, nodes);
  if (!repairedArticles || repairedArticles.length < MIN_REPEAT) return null;
  return { config: repaired, articles: repairedArticles, nodes };
}

/**
 * Proposes ranked scraping configs for the repeating items on a page, each
 * passed through the preview quality gate (lib/page-feed-quality.ts): obvious
 * navigation/login/map/ad/placeholder lists are rejected, borderline ones are
 * returned with review reasons. Never throws.
 */
export function suggestFeedCandidatesDetailed(rawHtml: string, url: string): SuggestionResult {
  const rejected: SuggestionResult["rejected"] = { count: 0, reasons: {} };
  let dom: JSDOM;
  try {
    dom = new JSDOM(stripStyleBlocks(rawHtml), { url });
  } catch {
    return { candidates: [], rejected };
  }
  try {
    const document = dom.window.document;
    const xpath = new dom.window.XPathEvaluator();
    const groups = limitGroups(collectGroups(document));
    const deadline = Date.now() + SUGGEST_TIME_BUDGET_MS;

    const scored: Array<{ group: Group; candidate: FeedCandidate; nodes: Element[] }> = [];
    const seenSelectors = new Set<string>();

    for (const group of groups) {
      // Bounded work on huge pages: stop validating more groups once the
      // budget is spent (groups are ordered largest first).
      if (Date.now() > deadline) break;
      const xPathItem = buildItemXPath(group);
      if (!xPathItem || seenSelectors.has(xPathItem)) continue;
      seenSelectors.add(xPathItem);

      let config = buildFieldConfig(group, xPathItem);

      // Validate through the REAL engine — a candidate only counts if the
      // engine parses it into linked items.
      let nodes: Node[] = [];
      let articles = runConfig(document, xpath, url, config, nodes);
      if (!articles || articles.length < MIN_REPEAT) continue;
      if (!articles.some((a) => a.link && a.link.trim().length > 0)) continue;

      const repaired = repairConfig(document, xpath, url, config, articles);
      if (repaired) ({ config, articles, nodes } = repaired);

      const linked = articles.filter((a) => a.link && a.link.trim().length > 0);
      const linkFraction = linked.length / articles.length;
      // Synthesized (content-derived) titles say nothing about title quality.
      const realTitles = articles.filter((a) => !a.titleSynthetic).map((a) => a.title).filter((t) => t && t !== "Untitled");
      const avgTitleLen = realTitles.length
        ? realTitles.reduce((s, t) => s + t.length, 0) / realTitles.length
        : 0;
      const avgTextLen = averageTextLength(group.items);
      const insideChrome = isInsideChrome(group.items[0]);

      let score = 0;
      score += Math.min(articles.length, 20) * 2; // repetition (damped)
      score += linkFraction * 20;
      score += Math.min(avgTitleLen, 40); // title quality
      if (config.xPathItemTimestamp) score += 10;
      if (config.xPathItemContent) score += 10;
      if (config.xPathItemThumbnail) score += 5;
      if (insideChrome) score -= 40; // nav/header/footer/menu
      // Tiny items lean towards a menu; the preview gate makes the real call
      // (short titles like "Go" or "新闻" are legitimate entries).
      if (avgTextLen < 20) score -= 15;
      if (averageDistinctLinks(group.items) > 4) score -= 25; // a block of many entries, not one entry
      // The gate runs first so its verdict (not only the structural score)
      // decides: short titles/teasers are not by themselves a menu signal.
      const quality: PreviewQuality = assessPreviewQuality(articles, { pageUrl: url, insideChrome });
      if (quality.verdict === "reject") {
        rejected.count++;
        if (quality.rejectReason) rejected.reasons[quality.rejectReason] = (rejected.reasons[quality.rejectReason] ?? 0) + 1;
        continue;
      }
      if (score + quality.scoreAdjustment < MIN_CANDIDATE_SCORE) continue;

      scored.push({ group, nodes: nodes.filter((n): n is Element => n.nodeType === 1), candidate: {
        config,
        score: score + quality.scoreAdjustment,
        itemCount: articles.length,
        sampleTitles: realTitles.slice(0, 5),
        previewArticles: articles.slice(0, PREVIEW_CAP),
        previewIssues: quality.itemIssues.slice(0, PREVIEW_CAP),
        quality: { verdict: quality.verdict, reasons: quality.reasons, notes: quality.notes, plausibleItems: quality.plausibleItems },
      } });
    }

    // A candidate whose items each wrap several items of another candidate is
    // a grouping block (Lever's per-team "postings-group"), and the engine
    // would only take the FIRST entry of each group. Prefer the inner list.
    // Compares the nodes the saved selectors match page-wide (captured from
    // the engine run, not just the sibling group the selector came from).
    // At most MAX_GROUPS candidates, so the pairwise check stays bounded.
    for (const outer of scored) {
      const outerNodes = outer.nodes;
      for (const inner of scored) {
        const innerNodes = inner.nodes;
        if (inner === outer || outerNodes.length === 0 || innerNodes.length < outerNodes.length * 1.5) continue;
        const contained = innerNodes.filter((el) => outerNodes.some((o) => o !== el && o.contains(el))).length;
        if (contained >= innerNodes.length * 0.8) {
          outer.candidate.score -= 40;
          break;
        }
      }
    }

    const candidates = scored.map((s) => s.candidate).sort((a, b) => b.score - a.score);
    return { candidates, rejected };
  } catch {
    return { candidates: [], rejected };
  } finally {
    dom.window.close();
  }
}

/** Ranked candidates that passed the preview quality gate (see `suggestFeedCandidatesDetailed`). */
export function suggestFeedCandidates(rawHtml: string, url: string): FeedCandidate[] {
  return suggestFeedCandidatesDetailed(rawHtml, url).candidates;
}

/** SSRF-safe wrapper: fetch the URL, then suggest candidates. Fetch errors propagate. */
export async function fetchAndSuggestFeedCandidates(url: string): Promise<FeedCandidate[]> {
  return (await fetchAndSuggestFeedCandidatesDetailed(url)).candidates;
}

/** Like `fetchAndSuggestFeedCandidates`, plus how many candidates the quality gate dropped. */
export async function fetchAndSuggestFeedCandidatesDetailed(url: string): Promise<SuggestionResult> {
  let directError: unknown = null;
  const rejected: SuggestionResult["rejected"] = { count: 0, reasons: {} };
  const mergeRejected = (other: SuggestionResult["rejected"]) => {
    rejected.count += other.count;
    for (const [reason, n] of Object.entries(other.reasons) as Array<[PreviewRejectReason, number]>) {
      rejected.reasons[reason] = (rejected.reasons[reason] ?? 0) + n;
    }
  };
  try {
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
    const result = suggestFeedCandidatesDetailed(html, url);
    if (result.candidates.length > 0) return result;
    mergeRejected(result.rejected);
  } catch (error) {
    directError = error; // hard block — the sidecar may still succeed.
  }

  // Fallback for genuinely client-only listing pages (the item list is rendered
  // in the browser and never reaches our static fetch): if an admin configured
  // a browser-render sidecar (M7-T2), render the page there and re-run the
  // heuristic on the rendered DOM.
  const rendered = await renderViaSidecar(url, { context: "Page feed" });
  if (rendered) {
    const result = suggestFeedCandidatesDetailed(rendered, url);
    if (result.candidates.length > 0) return result;
    mergeRejected(result.rejected);
  }

  if (directError) throw directError;
  return { candidates: [], rejected };
}
