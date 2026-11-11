import { JSDOM } from "jsdom";
import { fetchTextWithSsrfProtection, fetchWithSsrfProtection, isTrustedFeedFetchingAllowed } from "./ssrf";
import { parseHttpLinkHeader } from "./http-link-header";
import { hintForFetchError } from "./fetch-error-hint";
import { buildTopicFeeds, parseSourceInput, platformLabel, resolveSource, type ResolvedFeed } from "./smart-url-resolver";
import { detectSoftwareFeeds, matchPlatformAdapters, rsshubOnlyPlatform, type AdapterCandidate } from "./feed-adapters/engine";
import type { AdapterFamily } from "./feed-adapters/registry";
import { cleanUrlInput, httpFallbackUrl, isConnectError, isTlsError, normalizeUrlInput } from "./url-input";
import { withTransportFallback } from "./transport-fallback";
import { DiscoveryBudget, DiscoveryBudgetRefusal, type DiscoveryStopReason } from "./discovery-budget";

export type DiscoveredFeed = {
  url: string;
  title: string;
  type: "rss" | "atom" | "json" | "unknown";
  /** Which stage produced it. Absent on legacy callers' data. */
  source?: "resolver" | "topic" | "radar" | "html" | "software" | "common-path" | "curated";
  /** Resolver/topic/radar candidates only: variant of the feed (releases, commits, hot, …). */
  kind?: string;
  /** Platform / engine slug ("youtube", "github", "google-news", "rsshub", …). */
  platform?: string;
  /** 0–1 — how sure the stage is that this is what the user meant. */
  confidence?: number;
  /**
   * The adapter that produced it, for the UI ("Reddit-Feed", "Discourse-Forum",
   * "über RSSHub"). Absent for plain page discovery.
   */
  via?: FeedVia;
};

export type FeedVia = { family: AdapterFamily | "rsshub"; name: string };

export type DiscoveryHint = "needs-rsshub" | "rate-limited" | "blocked" | "tls-error";

export type DiscoveryResult = {
  /** "topic" = the input was a plain phrase and `feeds` are search-engine feeds to pick from. */
  mode: "url" | "topic" | "empty";
  feeds: DiscoveredFeed[];
  hint?: DiscoveryHint;
  /** With `needs-rsshub`: the platform that has no native feed ("X/Twitter"). */
  hintPlatform?: string;
  /** URL mode: the page address actually read (after redirects / http fallback). */
  pageUrl?: string;
  /** Set when the run hit its deadline or request budget: `feeds` may be incomplete. */
  partial?: DiscoveryStopReason;
};

export type DiscoverOptions = {
  /** UI locale ("de", "en-GB") — localizes Google News topic feeds. */
  locale?: string | null;
  /** Overrides the run's deadline / request budget (tests, batch tools). */
  limits?: { deadlineMs: number; maxRequests: number };
};

export type StarterPack = {
  id: string;
  name: string;
  description: string;
  path: string;
  feedCount: number;
};

export const STARTER_PACKS: StarterPack[] = [
  {
    id: "tech",
    name: "Technology",
    description: "Hacker News, Ars Technica, The Verge, Wired, TechCrunch",
    path: "tech.opml",
    feedCount: 5,
  },
  {
    id: "science",
    name: "Science",
    description: "NASA, Quanta Magazine, Scientific American, New Scientist",
    path: "science.opml",
    feedCount: 4,
  },
  {
    id: "news",
    name: "World News",
    description: "BBC, Reuters, NPR, The Guardian",
    path: "news.opml",
    feedCount: 4,
  },
  {
    id: "dev",
    name: "Developer News",
    description: "CSS-Tricks, Smashing Magazine, The Changelog, Dev.to",
    path: "dev.opml",
    feedCount: 4,
  },
  {
    id: "design",
    name: "Design & UX",
    description: "A List Apart, UX Collective, Nielsen Norman Group",
    path: "design.opml",
    feedCount: 3,
  },
];

const FEED_MIME_TYPES = [
  "application/rss+xml",
  "application/atom+xml",
  "application/feed+json",
  "application/json",
  "text/xml",
  "application/xml",
];

function classifyFeedType(mimeType: string): DiscoveredFeed["type"] {
  const m = mimeType.toLowerCase();
  if (m.includes("atom")) return "atom";
  if (m.includes("rss") || m.includes("xml")) return "rss";
  return "unknown";
}

function looksLikeFeedUrl(url: string) {
  if (/\.(?:css|js|mjs|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|pdf|zip)(?:[?#]|$)/i.test(url)) return false;
  return /(?:rss|atom|feed|feeds|xml|\.rss)(?:[/?#.]|$)/i.test(url);
}

/** Bytes read to verify a candidate: enough for the root element + channel title + first item. */
export const FEED_SNIFF_BYTES = 64 * 1024;

export type FeedSniff = {
  type: Exclude<DiscoveredFeed["type"], "unknown">;
  /** The feed's own title (channel/feed title), when present in the prefix. */
  title: string | null;
  /** Content identity (type + title + first item id) for de-duplicating aliases. */
  signature: string | null;
};

function decodeXmlText(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function firstTagText(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  if (!m) return null;
  return decodeXmlText(m[1]) || null;
}

/** The block of the first `<name …>…</name>` element (or the rest of the prefix if it is cut off). */
function firstBlock(xml: string, name: string): string | null {
  const open = new RegExp(`<${name}[\\s>]`, "i").exec(xml);
  if (!open) return null;
  const rest = xml.slice(open.index);
  const close = rest.search(new RegExp(`</${name}>`, "i"));
  return close >= 0 ? rest.slice(0, close) : rest;
}

/**
 * Classifies the first bytes of a response as RSS / Atom / RDF / JSON Feed by
 * its ROOT element (after the XML declaration, processing instructions such
 * as an XSL stylesheet, comments and a doctype) — an HTML page that merely
 * mentions `<rss` is not a feed. Works on a truncated prefix, so a 5 MB feed
 * costs one 64 KiB read. Returns null when it is not a feed.
 */
export function sniffFeedPrefix(text: string): FeedSniff | null {
  let s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (;;) {
    s = s.replace(/^\s+/, "");
    const skip = /^(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>)/i.exec(s);
    if (!skip) break;
    s = s.slice(skip[0].length);
  }

  if (s.startsWith("{")) {
    const head = s.slice(0, 4096);
    if (!/"version"\s*:\s*"https?:\/\/jsonfeed\.org\/version\//i.test(head) && !/"version"\s*:\s*"https?:\/\/jsonfeed\.org\/version\//i.test(s)) return null;
    const titleMatch = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(s.slice(0, s.search(/"items"\s*:/) >= 0 ? s.search(/"items"\s*:/) : s.length));
    let title: string | null = null;
    if (titleMatch) {
      try {
        title = (JSON.parse(`"${titleMatch[1]}"`) as string).trim().slice(0, 200) || null;
      } catch {
        title = null;
      }
    }
    const itemsAt = s.search(/"items"\s*:/);
    const firstId = itemsAt >= 0 ? /"(?:id|url)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(s.slice(itemsAt))?.[1] ?? null : null;
    return { type: "json", title, signature: firstId ? `json|${title ?? ""}|${firstId}` : null };
  }

  const root = /^<([A-Za-z][\w:.-]*)/.exec(s)?.[1].toLowerCase();
  if (!root) return null;
  const local = root.includes(":") ? root.slice(root.indexOf(":") + 1) : root;
  let type: FeedSniff["type"];
  if (local === "rss" || local === "rdf") type = "rss";
  else if (local === "feed") type = "atom";
  else return null;

  let title: string | null;
  let firstId: string | null = null;
  if (type === "atom") {
    const entryAt = s.search(/<(?:\w+:)?entry[\s>]/i);
    title = firstTagText(entryAt >= 0 ? s.slice(0, entryAt) : s, "(?:\\w+:)?title");
    const entry = firstBlock(s, "(?:\\w+:)?entry");
    if (entry) firstId = firstTagText(entry, "(?:\\w+:)?id") ?? /<(?:\w+:)?link[^>]*href="([^"]+)"/i.exec(entry)?.[1] ?? null;
  } else {
    const channel = firstBlock(s, "(?:\\w+:)?channel") ?? s;
    const itemAt = channel.search(/<(?:\w+:)?item[\s>]/i);
    title = firstTagText(itemAt >= 0 ? channel.slice(0, itemAt) : channel, "(?:\\w+:)?title");
    const item = firstBlock(s, "(?:\\w+:)?item");
    if (item) firstId = firstTagText(item, "guid") ?? firstTagText(item, "link") ?? firstTagText(item, "title");
  }
  return { type, title, signature: firstId ? `${type}|${title ?? ""}|${firstId}` : null };
}

/** Well-known feed locations probed on every site that doesn't advertise one. */
export const COMMON_FEED_PATHS = [
  "/feed",
  "/feed/",
  "/rss",
  "/rss/", // Ghost
  "/rss.xml",
  "/atom.xml",
  "/feed.xml",
  "/index.xml", // Hugo / Zola
  "/feed.json", // JSON Feed
  "/?feed=rss2", // WordPress without pretty permalinks
  "/api/feeds/posts",
];

type VerifiedCandidate = { url: string; title: string; type: DiscoveredFeed["type"]; signature: string | null };

/**
 * One budgeted request with the transport fallback: claims a request slot
 * (refused → DiscoveryBudgetRefusal, nothing is sent), shares the run's abort
 * signal, counts the retry and every redirect hop, and blocks the host on a
 * rate-limit response.
 */
async function budgetedFetch<T>(
  budget: DiscoveryBudget,
  url: string,
  attempt: (impersonate: boolean, request: { signal: AbortSignal; timeoutMs: number; redirectGuard: (next: string) => string | null }) => Promise<T>,
  isEmpty?: (result: T) => boolean,
): Promise<T> {
  if (!budget.take(url)) throw new DiscoveryBudgetRefusal(url);
  return withTransportFallback(
    url,
    (impersonate) => attempt(impersonate, { signal: budget.signal, timeoutMs: budget.requestTimeoutMs(), redirectGuard: budget.redirectGuard }),
    { isEmpty, beforeRetry: () => budget.take(url), onFailure: (err) => budget.noteFailure(url, err) },
  );
}

/**
 * Fetch-verifies a candidate from its first FEED_SNIFF_BYTES (stream cut off
 * there) — the size of the whole feed never matters here; the full-size
 * limits apply when the feed is actually synced. `preferOwnTitle`: replace
 * the candidate's label (anchor text, "host feed") with the feed's own title.
 */
async function verifyFeedCandidate(
  budget: DiscoveryBudget,
  url: string,
  title: string,
  fallbackType: DiscoveredFeed["type"],
  preferOwnTitle = false,
): Promise<VerifiedCandidate | null> {
  try {
    const allowInternal = await isTrustedFeedFetchingAllowed();
    const text = await budgetedFetch(
      budget,
      url,
      (impersonate, req) =>
        fetchTextWithSsrfProtection(url, { signal: req.signal }, {
          maxBytes: FEED_SNIFF_BYTES,
          readPrefix: true,
          timeoutMs: req.timeoutMs,
          redirectGuard: req.redirectGuard,
          allowInternal,
          impersonate,
        }),
      // An empty 200 (bot wall) is a refusal too → other transport.
      (t) => !t.trim(),
    );
    const sniff = sniffFeedPrefix(text);
    if (!sniff) return null;
    const ownTitle = sniff.title;
    return {
      url,
      title: (preferOwnTitle || !title || title === url) && ownTitle ? ownTitle : title || ownTitle || url,
      type: sniff.type ?? fallbackType,
      signature: sniff.signature,
    };
  } catch {
    return null;
  }
}

function toDiscovered(f: ResolvedFeed, source: "resolver" | "topic" | "curated"): DiscoveredFeed {
  return {
    url: f.url,
    title: f.title,
    type: f.format ?? "unknown",
    source,
    kind: f.kind,
    platform: f.platform,
    confidence: f.confidence,
    ...(source === "resolver" ? { via: { family: "platform" as const, name: platformLabel(f.platform) } } : {}),
  };
}

/** Registry platform candidates are guesses until the endpoint answers with a feed. */
async function verifyPlatformAdapterCandidates(budget: DiscoveryBudget, candidates: AdapterCandidate[]): Promise<DiscoveredFeed[]> {
  const checked = await Promise.all(
    candidates.map(async (c, i): Promise<DiscoveredFeed | null> => {
      const ok = await verifyFeedCandidate(budget, c.url, c.title, "unknown", true);
      if (!ok) return null;
      return {
        url: c.url,
        title: ok.title,
        type: ok.type,
        source: "resolver",
        kind: c.kind,
        platform: c.adapterId,
        confidence: c.scope === "route" ? 0.9 - i * 0.01 : 0.8 - i * 0.01,
        via: c.via,
      };
    }),
  );
  return checked.filter((f): f is DiscoveredFeed => f !== null);
}

/** SSRF-protected, budgeted text fetch handed to the pure resolver for its one-step lookups. */
const resolverFetchText = (budget: DiscoveryBudget) => async (url: string, init?: { headers?: Record<string, string> }) => {
  if (!budget.take(url)) throw new DiscoveryBudgetRefusal(url);
  try {
    return await fetchTextWithSsrfProtection(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; FeedFerret/1.0; +feed-discovery)",
          ...(init?.headers ?? {}),
        },
        signal: budget.signal,
      },
      // YouTube channel/watch pages are ~1–3 MB of HTML.
      {
        maxBytes: 4 * 1024 * 1024,
        timeoutMs: budget.requestTimeoutMs(),
        redirectGuard: budget.redirectGuard,
        allowInternal: await isTrustedFeedFetchingAllowed(),
      },
    );
  } catch (err) {
    budget.noteFailure(url, err);
    throw err;
  }
};

/**
 * Stage 1 — deterministic platform resolution (YouTube, Reddit, GitHub, …).
 * Candidates flagged `verify` are plausible guesses (e.g. any `/@user` on an
 * unknown host might be Mastodon) and are fetch-checked before being offered.
 * Curated publisher-table hits come back separately: they are only a fallback.
 */
async function resolveWithPlatformRules(
  input: string,
  budget: DiscoveryBudget,
): Promise<{ matched: boolean; feeds: DiscoveredFeed[]; curated: ResolvedFeed[] }> {
  const { matched, feeds } = await resolveSource(input, { fetchText: resolverFetchText(budget) });
  if (!feeds.length) {
    // Registry platform adapters (lib/feed-adapters/registry.ts): URL pattern → native endpoints, verified.
    const parsed = parseSourceInput(input);
    const candidates = parsed.type === "url" ? matchPlatformAdapters(parsed.url) : [];
    if (!candidates.length) return { matched, feeds: [], curated: [] };
    return { matched: true, feeds: await verifyPlatformAdapterCandidates(budget, candidates), curated: [] };
  }
  const curated = feeds.filter((f) => f.curated);
  const checked = await Promise.all(
    feeds.filter((f) => !f.curated).map(async (f) => {
      if (!f.verify) return toDiscovered(f, "resolver");
      const ok = await verifyFeedCandidate(budget, f.url, f.title, f.format ?? "unknown");
      return ok ? { ...toDiscovered(f, "resolver"), type: ok.type } : null;
    }),
  );
  return { matched, feeds: checked.filter((f): f is DiscoveredFeed => f !== null), curated };
}

/** Curated publisher routes, verified — only consulted when the page itself yields no feed. */
async function verifyCurated(curated: ResolvedFeed[], budget: DiscoveryBudget): Promise<DiscoveredFeed[]> {
  const checked = await Promise.all(
    curated.map(async (f) => {
      const ok = await verifyFeedCandidate(budget, f.url, f.title, f.format ?? "unknown");
      return ok ? { ...toDiscovered(f, "curated"), type: ok.type } : null;
    }),
  );
  return checked.filter((f): f is DiscoveredFeed => f !== null);
}

/**
 * Stage 3 — bundled RSSHub Radar rules → routes on the configured RSSHub
 * instance, each validated before it is offered. Empty (and free) when no
 * instance is configured or no rule matches.
 */
async function resolveWithRadarRules(pageUrl: string, budget: DiscoveryBudget): Promise<{ feeds: DiscoveredFeed[]; needsRsshub?: boolean }> {
  try {
    const { radarRoutesFor, getRsshubConfig, buildRsshubPublicRouteUrl, validateRsshubRoute } = await import("./rsshub");
    const matches = radarRoutesFor(pageUrl).slice(0, 4);
    if (!matches.length) return { feeds: [] };
    const config = await getRsshubConfig();
    if (!config) return { feeds: [], needsRsshub: true };
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Never past the run's deadline (the validation request has its own timeout).
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), Math.min(15_000, budget.remainingMs())); });
    const results = await Promise.all(
      matches.map(async (m): Promise<DiscoveredFeed | null> => {
        // Each validation is one request against the RSSHub instance.
        if (!budget.take(buildRsshubPublicRouteUrl(config, m.route))) return null;
        const validation = await Promise.race([validateRsshubRoute(config, m.route), timeout]);
        if (!validation || !validation.ok) return null;
        return {
          // Never the keyed URL: discovery results reach any session user and
          // read-scope API/MCP tokens. The key is added when the feed is created.
          url: buildRsshubPublicRouteUrl(config, m.route),
          title: `RSSHub · ${m.title}${validation.title ? ` (${validation.title})` : ""}`,
          type: "unknown",
          source: "radar",
          kind: "rsshub",
          platform: "rsshub",
          confidence: 0.7,
          via: { family: "rsshub", name: "RSSHub" },
        };
      }),
    ).finally(() => clearTimeout(timer));
    return { feeds: results.filter((f): f is DiscoveredFeed => f !== null) };
  } catch {
    return { feeds: [] };
  }
}

const LINK_HEADER_FEED_TYPES: Record<string, DiscoveredFeed["type"]> = {
  "application/rss+xml": "rss",
  "application/atom+xml": "atom",
  "application/feed+json": "unknown",
};

/**
 * Feed type of an HTTP `Link` header entry, or null when it is not a feed:
 * exact `alternate` relation token AND a feed media type. `application/json`
 * only counts with a JSON Feed hint (`feed` in the path or title). No URL-only
 * fallback — a Link header without a feed type is not a feed advertisement.
 */
export function linkHeaderFeedType(entry: { url: string; rels: string[]; type?: string; title?: string }): DiscoveredFeed["type"] | null {
  if (!entry.rels.includes("alternate") || !entry.type) return null;
  if (entry.type in LINK_HEADER_FEED_TYPES) return LINK_HEADER_FEED_TYPES[entry.type];
  if (entry.type === "application/json") {
    let path = entry.url;
    try {
      path = new URL(entry.url, "http://x.invalid").pathname;
    } catch {
      // keep raw
    }
    if (/feed/i.test(path) || /\bfeed\b/i.test(entry.title ?? "")) return "unknown";
  }
  return null;
}

/**
 * Early-stop predicate for the page prefix read: the head already advertises
 * a feed via a real `<link rel=alternate>` element. Parsed with the HTML
 * parser (not a regex), so feed-like markup inside `<script>`/`<style>`/
 * comments never counts — a false positive here would truncate discovery
 * before the real `<link>`.
 */
export function headAdvertisesFeed(headHtml: string): boolean {
  const { document } = new JSDOM(headHtml).window;
  return [...document.querySelectorAll('link[rel~="alternate" i][href]')].some((el) =>
    /^application\/(?:rss\+xml|atom\+xml|feed\+json)\b/i.test((el.getAttribute("type") || "").trim()));
}

type CandidateOrigin = "self" | "link" | "header" | "software" | "anchor" | "common";
type Candidate = {
  title: string;
  type: DiscoveredFeed["type"];
  score: number;
  origin: CandidateOrigin;
  /** Software adapter that proposes (or recognises) this URL. */
  adapter?: Pick<AdapterCandidate, "adapterId" | "kind" | "via">;
};

const FEED_WORDS = /\b(?:rss|atom|feeds?|newsfeed|web ?feed|abonnieren|subscribe|syndication)\b/i;
const COMMENT_WORDS = /comment|kommentar/i;

/**
 * Generic score of an `<a>` that points at a feed-looking URL — no host
 * lists: how strongly the element itself says "feed" (text, title,
 * aria-label, class, icon alt), whether it sits in site chrome (header /
 * footer / nav / aside, where sites put their RSS icon), and how canonical
 * the URL looks (a plain `/feed.xml` beats `/feed.xml?filter=…` and comment
 * feeds).
 */
export function scoreFeedAnchor(el: Element, absoluteUrl: string): number {
  let score = 30;
  const label = [
    el.textContent ?? "",
    el.getAttribute("title") ?? "",
    el.getAttribute("aria-label") ?? "",
    el.getAttribute("class") ?? "",
    ...[...el.querySelectorAll("img[alt], svg title")].map((n) => n.getAttribute("alt") ?? n.textContent ?? ""),
  ].join(" ");
  if (FEED_WORDS.test(label)) score += 25;
  if (el.closest("header, footer, nav, aside, [role=contentinfo], [role=banner]")) score += 10;
  try {
    const u = new URL(absoluteUrl);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    if (/^(?:feed|rss|atom|index\.xml|feed\.json)$|\.(?:xml|rss|atom|rdf)$/i.test(last)) score += 10;
    if (u.search) score -= 15;
    if (COMMENT_WORDS.test(u.pathname) || COMMENT_WORDS.test(label)) score -= 25;
  } catch {
    // scored as-is
  }
  return score;
}

/** The element itself names a feed format (not just "subscribe", which is usually a newsletter). */
function anchorSaysFeed(el: Element): boolean {
  const label = [
    el.textContent ?? "",
    el.getAttribute("title") ?? "",
    el.getAttribute("aria-label") ?? "",
    ...[...el.querySelectorAll("img[alt]")].map((n) => n.getAttribute("alt") ?? ""),
  ].join(" ");
  return /\b(?:rss|atom)\b|\b(?:web|news)?feed\b/i.test(label) && !/^mailto:|^javascript:/i.test(el.getAttribute("href") ?? "");
}

/** URL identity for de-duplication: `/feed` and `/feed/`, case of the host, fragments. */
function feedUrlKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return url;
  }
}

type HtmlDiscovery = { feeds: DiscoveredFeed[]; hint?: DiscoveryHint; pageUrl: string };

/**
 * Stage 2 — classic HTML discovery: the page itself (when it already is a
 * feed), HTTP `Link` header, `<link rel=alternate>`, feed-looking `<a>`
 * anchors anywhere in the page (scored), then common feed paths — verified
 * by a prefix sniff, ranked by score, de-duplicated by URL and content.
 */
async function discoverFeedsInHtml(pageUrl: string, budget: DiscoveryBudget, opts: { httpFallback?: boolean } = {}): Promise<HtmlDiscovery> {
  let html = "";
  let hint: DiscoveryHint | undefined;
  const allowInternal = await isTrustedFeedFetchingAllowed();
  // Relative references resolve against the FINAL URL after redirects (and
  // a document `<base href>`), not the URL the user typed.
  let base = new URL(pageUrl);
  let responseUrl = base;
  const candidateLinks = new Map<string, Candidate>();

  const addCandidate = (
    href: string | null,
    title: string | null,
    type: DiscoveredFeed["type"],
    origin: CandidateOrigin,
    score: number,
    resolveAgainst: URL = base,
    labelSaysFeed = false,
    adapter?: Candidate["adapter"],
  ) => {
    if (!href) return;
    try {
      const feedUrl = new URL(href, resolveAgainst).toString();
      if (!/^https?:$/.test(new URL(feedUrl).protocol)) return;
      // An anchor counts when its URL looks like a feed, or when the element
      // itself says so (RSS icon `alt`, `title`, `aria-label`) at any path.
      const strong = origin !== "anchor" || labelSaysFeed;
      if (!strong && !looksLikeFeedUrl(feedUrl)) return;
      const existing = candidateLinks.get(feedUrl);
      if (!existing) {
        candidateLinks.set(feedUrl, { title: title || feedUrl, type, origin, score, adapter });
      } else {
        // Same URL from two stages: the better score wins, the adapter label sticks.
        candidateLinks.set(feedUrl, {
          ...existing,
          score: Math.max(score, existing.score),
          adapter: existing.adapter ?? adapter,
        });
      }
    } catch {
      // invalid URL
    }
  };

  // Refused (401/402/403) or empty with the plain client → once more with the
  // browser-fingerprint client (lib/transport-fallback.ts); a 429 blocks the
  // host instead. Budgeted like every discovery request.
  const fetchPage = (url: string) =>
    budgetedFetch(
      budget,
      url,
      (impersonate, req) =>
        fetchWithSsrfProtection(url, { signal: req.signal }, {
          maxBytes: 1024 * 1024,
          timeoutMs: req.timeoutMs,
          redirectGuard: req.redirectGuard,
          // Large pages: read a bounded prefix (never fail on size). Stop at the
          // end of <head> only when it already advertises a feed; otherwise keep
          // reading so feed anchors in the body are still found.
          untilHead: headAdvertisesFeed,
          allowInternal,
          impersonate,
        }),
      (r) => !r.notModified && !r.text.trim(),
    );

  let selfSniff: FeedSniff | null = null;
  let pageHeaders: Headers | null = null;
  try {
    let result;
    try {
      result = await fetchPage(pageUrl);
    } catch (err) {
      // The user typed no scheme and https could not even connect: the one
      // retry over plain http (never after an HTTP status or SSRF refusal).
      const fallback = opts.httpFallback && isConnectError(err) ? httpFallbackUrl(pageUrl) : null;
      if (!fallback) throw err;
      result = await fetchPage(fallback);
      base = responseUrl = new URL(fallback);
    }
    if (result.url) base = responseUrl = new URL(result.url);
    if (!result.notModified) {
      html = result.text;
      pageHeaders = result.headers ?? null;
      selfSniff = sniffFeedPrefix(html);
      for (const entry of parseHttpLinkHeader(result.headers?.get("link") ?? null)) {
        const type = linkHeaderFeedType(entry);
        if (type) addCandidate(entry.url, entry.title || null, type, "header", 95);
      }
    }
  } catch (err) {
    hint = isTlsError(err)
      ? "tls-error"
      : err instanceof DiscoveryBudgetRefusal && budget.isHostBlocked(pageUrl)
        ? "rate-limited"
        : hintForFetchError(err);
  }

  const discovered = new Map<string, DiscoveredFeed & { score: number }>();
  const seenKeys = new Set<string>();
  const seenSignatures = new Set<string>();
  const accept = (v: VerifiedCandidate, c: Candidate) => {
    const key = feedUrlKey(v.url);
    if (seenKeys.has(key) || (v.signature && seenSignatures.has(v.signature))) return;
    seenKeys.add(key);
    if (v.signature) seenSignatures.add(v.signature);
    discovered.set(v.url, {
      url: v.url,
      title: v.title,
      type: v.type,
      source: c.origin === "common" ? "common-path" : c.origin === "software" ? "software" : "html",
      ...(c.adapter ? { kind: c.adapter.kind, platform: c.adapter.adapterId, via: c.adapter.via } : {}),
      score: c.score,
    });
  };

  // The address already is a feed (pasted feed URL in a "web page" flow).
  if (selfSniff) {
    accept(
      { url: responseUrl.toString(), title: selfSniff.title ?? responseUrl.toString(), type: selfSniff.type, signature: selfSniff.signature },
      { title: "", type: selfSniff.type, origin: "self", score: 110 },
    );
    html = "";
  }

  const dom = new JSDOM(html);
  const { document } = dom.window;
  const baseHref = document.querySelector("base[href]")?.getAttribute("href");
  if (baseHref) {
    try {
      base = new URL(baseHref, base);
    } catch {
      // invalid <base href>: keep the response URL
    }
  }

  for (const el of document.querySelectorAll('link[rel~="alternate"]')) {
    const type = (el.getAttribute("type") || "").toLowerCase().trim();
    const isFeedMime = type.length > 0 && FEED_MIME_TYPES.some((t) => type.startsWith(t) || t.startsWith(type.split("+")[0]));
    const href = el.getAttribute("href") || "";
    if (!isFeedMime && !looksLikeFeedUrl(href)) continue;
    const title = el.getAttribute("title");
    const comments = COMMENT_WORDS.test(href) || COMMENT_WORDS.test(title ?? "");
    addCandidate(href, title, classifyFeedType(type), "link", (isFeedMime ? 100 : 70) - (comments ? 25 : 0));
  }

  for (const el of document.querySelectorAll("a[href]")) {
    const href = el.getAttribute("href");
    if (!href) continue;
    let absolute: string;
    try {
      absolute = new URL(href, base).toString();
    } catch {
      continue;
    }
    const text = el.textContent?.replace(/\s+/g, " ").trim() || el.getAttribute("title") || el.getAttribute("aria-label");
    addCandidate(href, text, "unknown", "anchor", scoreFeedAnchor(el, absolute), base, anchorSaysFeed(el));
  }

  // Forum / blog software recognised on the page (generator meta, markup
  // fingerprints, headers) → its native endpoints (lib/feed-adapters).
  if (html) {
    for (const c of detectSoftwareFeeds({ html, headers: pageHeaders, url: responseUrl })) {
      addCandidate(c.url, c.title, "unknown", "software", c.scope === "route" ? 92 : 85, responseUrl, false, c);
    }
  }

  for (const commonPath of COMMON_FEED_PATHS) {
    // Root-relative on purpose ("/?feed=rss2" must stay at the site root).
    addCandidate(commonPath, `${responseUrl.hostname} feed`, "unknown", "common", 15, responseUrl);
  }

  // Verify in small parallel batches (each probe can take up to the timeout),
  // best-scored first so they win the 10 slots. Bounded fan-out: at most 25
  // advertised/anchor candidates, then the common paths — which are skipped
  // entirely once the page's own advertisement verified (no blind guessing
  // when the site told us where its feed is).
  const byScore = [...candidateLinks.entries()].sort((a, b) => b[1].score - a[1].score);
  const advertised = byScore.filter(([, c]) => c.origin !== "common").slice(0, 25);
  const common = byScore.filter(([, c]) => c.origin === "common");
  const BATCH = 5;
  const runBatches = async (entries: Array<[string, Candidate]>) => {
    for (let i = 0; i < entries.length && discovered.size < 10 && !budget.stopReason; i += BATCH) {
      const batch = entries.slice(i, i + BATCH);
      const verified = await Promise.all(
        batch.map(([url, c]) =>
          verifyFeedCandidate(budget, url, c.title, c.type, c.origin === "anchor" || c.origin === "common" || c.origin === "software")),
      );
      verified.forEach((v, idx) => {
        if (v) accept(v, batch[idx][1]);
      });
    }
  };
  await runBatches(advertised);
  const hasAdvertised = [...discovered.values()].some((f) => f.score >= 70);
  if (!hasAdvertised) await runBatches(common);

  const feeds = [...discovered.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(({ score: _score, ...feed }) => feed);
  return { feeds, hint, pageUrl: responseUrl.toString() };
}

/**
 * Turns whatever the user pasted into feed candidates, cheapest and most
 * deterministic stage first:
 *   - plain phrase → search-engine topic feeds (Google News locale-aware, Bing
 *     News, hnrss, arXiv) for the user to pick from;
 *   - URL/handle → (a) platform rules: URL-scheme converters in
 *     smart-url-resolver.ts plus the PLATFORM_ADAPTERS registry (verified)
 *     → otherwise the page itself: (b) software adapters recognised on it
 *     (Discourse, phpBB, XenForo, WordPress, …), its advertised feeds and
 *     anchors, then common feed paths — every candidate (c) prefix-verified;
 *     the page fetch falls back to the other HTTP transport when refused
 *     → curated publisher routes only when the page yielded nothing → (d)
 *     bundled RSSHub Radar rules on the configured RSSHub instance (if any;
 *     else the `needs-rsshub` hint names the platform).
 *   See lib/feed-adapters/registry.ts for the adapter list.
 * Never throws.
 */
export async function discoverFeeds(input: string, options: DiscoverOptions = {}): Promise<DiscoveryResult> {
  // Pasted junk around an address (`<https://…>`, "example.com/feed.") is
  // cleaned first; phrases stay phrases.
  const cleaned = cleanUrlInput(input);
  const parsed = parseSourceInput(cleaned);
  if (parsed.type === "empty") return { mode: "empty", feeds: [] };
  if (parsed.type === "topic") {
    return { mode: "topic", feeds: buildTopicFeeds(parsed.query, { locale: options.locale }).map((f) => toDiscovered(f, "topic")) };
  }

  const pageUrl = parsed.url.toString();
  const normalized = normalizeUrlInput(cleaned);
  const httpFallback = normalized.ok && normalized.schemeAssumed;
  // One deadline + request budget for every stage below (lib/discovery-budget.ts).
  const budget = new DiscoveryBudget(options.limits);
  try {
    return await discoverUrl(cleaned, parsed.url, pageUrl, httpFallback, budget);
  } finally {
    budget.dispose();
  }
}

async function discoverUrl(cleaned: string, url: URL, pageUrl: string, httpFallback: boolean, budget: DiscoveryBudget): Promise<DiscoveryResult> {
  const [native, radar] = await Promise.all([
    resolveWithPlatformRules(cleaned, budget).catch(() => ({ matched: false, feeds: [] as DiscoveredFeed[], curated: [] as ResolvedFeed[] })),
    resolveWithRadarRules(pageUrl, budget),
  ]);

  const html: Partial<HtmlDiscovery> & { feeds: DiscoveredFeed[] } = native.feeds.length
    ? { feeds: [] }
    : await discoverFeedsInHtml(pageUrl, budget, { httpFallback }).catch(() => ({ feeds: [] }));
  const curated = !native.feeds.length && !html.feeds.length && native.curated.length ? await verifyCurated(native.curated, budget) : [];
  const merged = new Map<string, DiscoveredFeed>();
  for (const f of [...native.feeds, ...html.feeds, ...curated, ...radar.feeds]) if (!merged.has(f.url)) merged.set(f.url, f);

  let hint: DiscoveryHint | undefined;
  let hintPlatform: string | undefined;
  if (merged.size === 0) {
    if (radar.needsRsshub) {
      hint = "needs-rsshub";
      hintPlatform = rsshubOnlyPlatform(url) ?? undefined;
    } else if (html.hint) {
      hint = html.hint;
    }
  }

  return {
    mode: "url",
    feeds: [...merged.values()],
    hint,
    ...(hintPlatform ? { hintPlatform } : {}),
    pageUrl: html.pageUrl ?? pageUrl,
    // Deadline / request budget hit: whatever verified so far, plus the reason.
    ...(budget.stopReason ? { partial: budget.stopReason } : {}),
  };
}

/** Back-compat wrapper: feeds for a page URL (or any input `discoverFeeds` understands). */
export async function discoverFeedsAtUrl(pageUrl: string, options: DiscoverOptions = {}): Promise<DiscoveredFeed[]> {
  return (await discoverFeeds(pageUrl, options)).feeds;
}
