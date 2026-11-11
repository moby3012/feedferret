import { fetchTextWithSsrfProtection, fetchWithSsrfProtection, isTrustedFeedFetchingAllowed } from "./ssrf";
import { parseHttpLinkHeader } from "./http-link-header";
import { hintForFetchError } from "./fetch-error-hint";
import { buildTopicFeeds, matchSource, parseSourceInput, platformLabel, resolveSource, type ResolvedFeed } from "./smart-url-resolver";
import { detectSoftwareFeeds, matchPlatformAdapters, rsshubOnlyPlatform, scanForAdapters, type AdapterCandidate } from "./feed-adapters/engine";
import { HTML_SCAN_MAX_CHARS, scanHtml, type ScannedAnchor, type ScannedElement } from "./html-scan";
import type { AdapterFamily } from "./feed-adapters/registry";
import { cleanUrlInput, httpFallbackUrl, isConnectError, isTlsError, normalizeUrlInput, trimTrailing } from "./url-input";
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
  /**
   * The page itself refused us (401/402/403, bot wall) but other stages
   * (platform rules, curated routes, RSSHub, feed URLs probed directly) still
   * found feeds — the UI says so instead of failing.
   */
  pageBlocked?: true;
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

// Everything below runs on a fetched prefix (attacker-controlled bytes):
// linear scans only — literal anchors, indexOf, bounded or `[^<>]` classes —
// never `[^>]*` / `[\s\S]*?` over the whole prefix from every start position.

function decodeXmlText(raw: string): string {
  return raw
    .slice(0, 4000)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^<>]*>/g, "")
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

/** Text of the first `<tag …>…</tag>` element (single forward scan; null when it is not closed). */
function firstTagText(xml: string, tag: string): string | null {
  const open = new RegExp(`<${tag}(?=[\\s>/])`, "i").exec(xml);
  if (!open) return null;
  const gt = xml.indexOf(">", open.index + open[0].length);
  if (gt < 0 || xml[gt - 1] === "/") return null;
  const rest = xml.slice(gt + 1);
  const close = new RegExp(`</${tag}\\s{0,16}>`, "i").exec(rest);
  if (!close) return null;
  return decodeXmlText(rest.slice(0, close.index)) || null;
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
    const skip = /^(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s{0,64}>)/i.exec(s);
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
    if (entry) firstId = firstTagText(entry, "(?:\\w+:)?id") ?? /<(?:\w+:)?link\b[^<>]{0,1000}?\bhref="([^"<>]{1,2000})"/i.exec(entry)?.[1] ?? null;
  } else {
    // RSS 2.0 and RDF both carry a <channel>; a `<rss><items>…` look-alike
    // (seen on some APIs) is no feed our parser can read.
    if (!/<(?:\w+:)?channel[\s>]/i.test(s)) return null;
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
 * signal, counts the retry and every redirect hop, starts with the transport
 * that already worked for this host in this run, and blocks the host that
 * actually answered (final hop) on a rate-limit response.
 */
async function budgetedFetch<T>(
  budget: DiscoveryBudget,
  url: string,
  attempt: (impersonate: boolean, request: { signal: AbortSignal; timeoutMs: number; redirectGuard: (next: string) => string | null }) => Promise<T>,
  isEmpty?: (result: T) => boolean,
): Promise<T> {
  if (!budget.take(url)) throw new DiscoveryBudgetRefusal(url);
  let tracker = budget.track(url);
  return withTransportFallback(
    url,
    async (impersonate) => {
      tracker = budget.track(url);
      const result = await attempt(impersonate, { signal: budget.signal, timeoutMs: budget.requestTimeoutMs(), redirectGuard: tracker.redirectGuard });
      if (!isEmpty?.(result)) {
        budget.noteWorkingTransport(url, impersonate);
        budget.noteWorkingTransport(tracker.finalUrl(), impersonate);
      }
      return result;
    },
    {
      primaryImpersonate: budget.preferredImpersonate(url) ?? false,
      isEmpty,
      beforeRetry: () => budget.take(url),
      onFailure: (err) => budget.noteFailure(tracker.finalUrl(), err),
    },
  );
}

/**
 * Bytes read from a candidate whose address looks like a feed INDEX page
 * (`/rss`, `/feeds/`, `/rss.html`): enough to be a feed's prefix, or to
 * reach the list of feeds when it is an HTML page that links them.
 */
export const FEED_INDEX_BYTES = 256 * 1024;

/** `/rss`, `/feeds/`, `/rss.html`, `/newsfeeds`, … — a path that is either a feed or a page listing feeds. */
export function looksLikeFeedIndexPath(url: string): boolean {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return /^(?:rss|feeds?|atom|newsfeeds?|rss-?feeds?|syndication)(?:\.(?:html?|php|aspx?))?$/i.test(last);
  } catch {
    return false;
  }
}

/**
 * Fetch-verifies a candidate from its first FEED_SNIFF_BYTES (stream cut off
 * there) — the size of the whole feed never matters here; the full-size
 * limits apply when the feed is actually synced. `preferOwnTitle`: replace
 * the candidate's label (anchor text, "host feed") with the feed's own title.
 * `onIndexPage`: a feed-index-looking address that answered with HTML
 * instead of a feed hands its prefix over (the caller may follow it once).
 */
async function verifyFeedCandidate(
  budget: DiscoveryBudget,
  url: string,
  title: string,
  fallbackType: DiscoveredFeed["type"],
  preferOwnTitle = false,
  onIndexPage?: (html: string, url: string) => void,
): Promise<VerifiedCandidate | null> {
  try {
    const allowInternal = await isTrustedFeedFetchingAllowed();
    const indexLike = onIndexPage !== undefined && looksLikeFeedIndexPath(url);
    const text = await budgetedFetch(
      budget,
      url,
      (impersonate, req) =>
        fetchTextWithSsrfProtection(url, { signal: req.signal }, {
          maxBytes: indexLike ? FEED_INDEX_BYTES : FEED_SNIFF_BYTES,
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
    if (!sniff) {
      if (indexLike && /<html[\s>]|<!doctype html/i.test(text.slice(0, 4096))) onIndexPage(text, url);
      return null;
    }
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

/* -------------------------------------------------------------------------- */
/* Section affinity                                                            */
/* -------------------------------------------------------------------------- */

const GENERIC_SEGMENTS = new Set(["index", "home", "start", "startseite", "news", "nachrichten", "de", "en", "www"]);

/**
 * The meaningful path segments of the address the user typed — a section
 * page `/aktuell/politik/` → ["aktuell", "politik"] (lower-case, file
 * extensions, numeric ids and generic words dropped). Empty for a homepage.
 */
export function sectionSegments(url: URL): string[] {
  const out: string[] = [];
  for (const raw of url.pathname.split("/").slice(0, 8)) {
    let seg = raw.toLowerCase();
    try {
      seg = decodeURIComponent(seg);
    } catch {
      // keep raw
    }
    seg = seg.replace(/\.(?:html?|php|aspx?|jsp)$/, "");
    if (seg.length < 2 || seg.length > 60 || /^\d+$/.test(seg) || GENERIC_SEGMENTS.has(seg)) continue;
    out.push(seg);
  }
  return out;
}

function affinityTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

/**
 * 0–1: how much a feed belongs to the section the user typed — its address
 * or title contains the section's path segments (the last, most specific
 * segment counts double). A site-wide feed scores 0 (or partially for a
 * shared parent like `/aktuell/`); 0 when the input has no section.
 */
export function sectionAffinity(segments: string[], feedUrl: string, title = ""): number {
  if (!segments.length) return 0;
  let path = feedUrl;
  try {
    const u = new URL(feedUrl);
    path = `${u.hostname} ${u.pathname} ${u.search}`;
  } catch {
    // tokenise the raw string
  }
  const tokens = affinityTokens(`${path} ${title.slice(0, 300)}`);
  const pathSegs = new Set(path.toLowerCase().split(/[/?&=\s]+/).filter(Boolean));
  let total = 0;
  let hit = 0;
  segments.forEach((seg, i) => {
    const weight = i === segments.length - 1 ? 2 : 1;
    total += weight;
    const parts = seg.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (pathSegs.has(seg) || (parts.length > 0 && parts.every((p) => tokens.has(p)))) hit += weight;
  });
  return total ? hit / total : 0;
}

/**
 * Section-relative variants of the usual feed paths for a section page
 * (`/inland` → `/inland/feed`, `/inland/rss`, `/rss/inland`, `/feed/inland`).
 * Only for shallow section-like paths (not a deep, dated or slugged article address).
 */
export function sectionFeedPaths(url: URL): string[] {
  const segs = url.pathname.split("/").filter(Boolean);
  if (!segs.length || segs.length > 3) return [];
  const last = segs[segs.length - 1];
  if (/\.[a-z0-9]{1,5}$/i.test(last)) return [];
  // Date/ID segments or a long slug: an article, not a section.
  if (segs.some((seg) => /^\d+$/.test(seg)) || last.split("-").length >= 4) return [];
  if (looksLikeFeedIndexPath(url.toString())) return [];
  const section = `/${segs.join("/")}`;
  return [`${section}/feed`, `${section}/rss`, `/rss${section}`, `/feed${section}`];
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

/** Bytes a resolver lookup reads at most (prefix; never fails on a larger page). */
export const RESOLVER_PAGE_BYTES = 4 * 1024 * 1024;

/** SSRF-protected, budgeted text fetch handed to the pure resolver for its one-step lookups. */
const resolverFetchText = (budget: DiscoveryBudget) => async (url: string, init?: { headers?: Record<string, string> }) => {
  if (!budget.take(url)) throw new DiscoveryBudgetRefusal(url);
  const tracker = budget.track(url);
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
      // YouTube channel/watch pages are ~1–3 MB of HTML; a larger page is
      // read as a bounded prefix (the channel meta sits in the first MiBs)
      // instead of failing the lookup on its size.
      {
        maxBytes: RESOLVER_PAGE_BYTES,
        readPrefix: true,
        timeoutMs: budget.requestTimeoutMs(),
        redirectGuard: tracker.redirectGuard,
        allowInternal: await isTrustedFeedFetchingAllowed(),
      },
    );
  } catch (err) {
    budget.noteFailure(tracker.finalUrl(), err);
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
        // Each validation is one request against the RSSHub instance; its
        // redirect hops count too and the run's deadline aborts it.
        if (!budget.take(buildRsshubPublicRouteUrl(config, m.route))) return null;
        const validation = await Promise.race([
          validateRsshubRoute(config, m.route, { signal: budget.signal, onRedirect: (next) => budget.take(next) }),
          timeout,
        ]);
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
  return scanHtml(headHtml).links.some(
    (l) =>
      l.attrs.href !== undefined &&
      relTokens(l.attrs.rel).includes("alternate") &&
      /^application\/(?:rss\+xml|atom\+xml|feed\+json)\b/i.test((l.attrs.type || "").trim()),
  );
}

function relTokens(rel: string | undefined): string[] {
  return (rel ?? "").toLowerCase().split(/[\t\n\f\r ]/).filter(Boolean);
}

type CandidateOrigin = "self" | "link" | "header" | "software" | "anchor" | "common" | "index";
type Candidate = {
  title: string;
  type: DiscoveredFeed["type"];
  score: number;
  origin: CandidateOrigin;
  /** Software adapter that proposes (or recognises) this URL. */
  adapter?: Pick<AdapterCandidate, "adapterId" | "kind" | "via">;
  /** Common path built from the section the user typed (`/inland/feed`, `/rss/inland`). */
  section?: boolean;
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
export function scoreFeedAnchor(a: ScannedAnchor, absoluteUrl: string): number {
  let score = 30;
  // `text` already includes inline SVG <title> text (it is element text).
  const label = [a.text, a.title, a.ariaLabel, a.className, ...a.imgAlts].join(" ");
  if (FEED_WORDS.test(label)) score += 25;
  if (a.inChrome) score += 10;
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
function anchorSaysFeed(a: ScannedAnchor): boolean {
  const label = [a.text, a.title, a.ariaLabel, ...a.imgAlts].join(" ");
  return /\b(?:rss|atom)\b|\b(?:web|news)?feed\b/i.test(label) && !/^mailto:|^javascript:/i.test(a.href);
}

/** URL identity for de-duplication: `/feed` and `/feed/`, case of the host, fragments. */
function feedUrlKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    const path = u.pathname.length > 1 ? trimTrailing(u.pathname, "/") : u.pathname;
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return url;
  }
}

/** Candidate addresses longer than this (from the page or built by adapters) are dropped. */
export const MAX_CANDIDATE_URL_LENGTH = 2048;

type HtmlDiscovery = {
  feeds: DiscoveredFeed[];
  hint?: DiscoveryHint;
  pageUrl: string;
  /** At least one feed belongs to the section the user typed (see sectionAffinity). */
  sectionHit?: boolean;
};

/** Max. `<link>` tags recovered from the part of a page beyond the scanner's cap. */
const LATE_LINK_TAGS = 200;

/**
 * `<link>` elements past HTML_SCAN_MAX_CHARS (huge inline-script heads push a
 * page's `<link rel=alternate>` beyond the scanner's cap): one forward
 * indexOf pass collects at most LATE_LINK_TAGS bounded `<link …>` tags, which
 * are then parsed by the same linear scanner.
 */
export function lateLinkElements(html: string): ScannedElement[] {
  if (html.length <= HTML_SCAN_MAX_CHARS) return [];
  const lower = html.toLowerCase();
  const tags: string[] = [];
  let pos = HTML_SCAN_MAX_CHARS;
  while (tags.length < LATE_LINK_TAGS) {
    const at = lower.indexOf("<link", pos);
    if (at < 0) break;
    const end = lower.indexOf(">", at);
    if (end < 0) break;
    if (end - at <= 4000) tags.push(html.slice(at, end + 1));
    pos = end + 1;
  }
  return tags.length ? scanHtml(tags.join("\n")).links : [];
}

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
  const inputUrl = new URL(pageUrl);
  const segments = sectionSegments(inputUrl);
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
    section = false,
  ) => {
    // Page-supplied: an absurdly long address is never a feed we want to probe.
    if (!href || href.length > MAX_CANDIDATE_URL_LENGTH) return;
    try {
      const feedUrl = new URL(href, resolveAgainst).toString();
      if (feedUrl.length > MAX_CANDIDATE_URL_LENGTH) return;
      if (!/^https?:$/.test(new URL(feedUrl).protocol)) return;
      // An anchor counts when its URL looks like a feed, or when the element
      // itself says so (RSS icon `alt`, `title`, `aria-label`) at any path.
      const strong = origin !== "anchor" || labelSaysFeed;
      if (!strong && !looksLikeFeedUrl(feedUrl)) return;
      const existing = candidateLinks.get(feedUrl);
      if (!existing) {
        candidateLinks.set(feedUrl, { title: title || feedUrl, type, origin, score, adapter, ...(section ? { section } : {}) });
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

  // Linear streaming scan (lib/html-scan.ts) instead of a DOM: the page is
  // attacker-controlled, and JSDOM's synchronous tree build is unbounded in
  // time and recursion depth on hostile markup.
  const page = scanForAdapters(html);
  const baseHref = page.baseHref;
  if (baseHref) {
    try {
      base = new URL(baseHref, base);
    } catch {
      // invalid <base href>: keep the response URL
    }
  }

  for (const el of [...page.links, ...lateLinkElements(html)]) {
    if (!relTokens(el.attrs.rel).includes("alternate")) continue;
    const type = (el.attrs.type || "").toLowerCase().trim();
    const isFeedMime = type.length > 0 && FEED_MIME_TYPES.some((t) => type.startsWith(t) || t.startsWith(type.split("+")[0]));
    const href = el.attrs.href || "";
    if (!isFeedMime && !looksLikeFeedUrl(href)) continue;
    const title = el.attrs.title ?? null;
    const comments = COMMENT_WORDS.test(href) || COMMENT_WORDS.test(title ?? "");
    addCandidate(href, title, classifyFeedType(type), "link", (isFeedMime ? 100 : 70) - (comments ? 25 : 0));
  }

  for (const a of page.anchors) {
    const href = a.href;
    if (!href) continue;
    let absolute: string;
    try {
      absolute = new URL(href, base).toString();
    } catch {
      continue;
    }
    const text = a.text || a.title || a.ariaLabel;
    addCandidate(href, text, "unknown", "anchor", scoreFeedAnchor(a, absolute), base, anchorSaysFeed(a));
  }

  // Forum / blog software recognised on the page (generator meta, markup
  // fingerprints, headers) → its native endpoints (lib/feed-adapters).
  if (html) {
    for (const c of detectSoftwareFeeds({ scan: page, headers: pageHeaders, url: responseUrl })) {
      addCandidate(c.url, c.title, "unknown", "software", c.scope === "route" ? 92 : 85, responseUrl, false, c);
    }
  }

  // Section page (`/inland`, `/aktuell/politik/`): the section-relative
  // variants of the usual paths first, then the site-wide ones.
  for (const sectionPath of sectionFeedPaths(inputUrl)) {
    addCandidate(sectionPath, `${responseUrl.hostname} feed`, "unknown", "common", 20, responseUrl, false, undefined, true);
  }
  for (const commonPath of COMMON_FEED_PATHS) {
    // Root-relative on purpose ("/?feed=rss2" must stay at the site root).
    addCandidate(commonPath, `${responseUrl.hostname} feed`, "unknown", "common", 15, responseUrl);
  }

  // A feed-index-looking candidate (`/rss`, `/feeds/`) that answered with an
  // HTML page listing feeds: kept (the first one only) and followed once below.
  let indexPage: { html: string; url: string } | null = null;
  const onIndexPage = (text: string, url: string) => {
    indexPage ??= { html: text, url };
  };
  // A comment feed never gets the section bonus: on an article address its
  // own comments feed would otherwise outrank the site's feed.
  const affinityOf = (url: string, title: string) => (COMMENT_WORDS.test(url) || COMMENT_WORDS.test(title) ? 0 : sectionAffinity(segments, url, title));
  const hasSectionHit = () => [...discovered.values()].some((f) => affinityOf(f.url, f.title) > 0);

  // Verify in small parallel batches (each probe can take up to the timeout),
  // best-scored first so they win the 10 slots. Bounded fan-out: at most 25
  // advertised/anchor candidates, then the common paths — which are skipped
  // entirely once the page's own advertisement verified (no blind guessing
  // when the site told us where its feed is), except the section-relative
  // ones when the input is a section page and nothing section-specific
  // verified yet. A blocked page (401/403/bot wall) gets one batch of blind
  // probes at most: the same host usually refuses those too.
  const byScore = [...candidateLinks.entries()].sort((a, b) => b[1].score - a[1].score);
  const advertised = byScore.filter(([, c]) => c.origin !== "common").slice(0, 25);
  const common = byScore.filter(([, c]) => c.origin === "common");
  const BATCH = 5;
  const runBatches = async (entries: Array<[string, Candidate]>) => {
    for (let i = 0; i < entries.length && discovered.size < 10 && !budget.stopReason; i += BATCH) {
      const batch = entries.slice(i, i + BATCH);
      const verified = await Promise.all(
        batch.map(([url, c]) =>
          verifyFeedCandidate(
            budget,
            url,
            c.title,
            c.type,
            c.origin === "anchor" || c.origin === "common" || c.origin === "software" || c.origin === "index",
            c.origin === "anchor" || c.origin === "common" ? onIndexPage : undefined,
          )),
      );
      verified.forEach((v, idx) => {
        if (v) accept(v, batch[idx][1]);
      });
    }
  };
  await runBatches(advertised);
  const hasAdvertised = [...discovered.values()].some((f) => f.score >= 70);
  if (!hasAdvertised) await runBatches(hint === "blocked" ? common.slice(0, BATCH) : common);
  else if (segments.length && !hasSectionHit()) await runBatches(common.filter(([, c]) => c.section));

  // Follow ONE feed index page one level: its listed feeds (page `<link>`s
  // and feed-looking anchors), best section match first — when nothing was
  // found yet, or the input is a section and only site-wide feeds verified.
  const followIndex = indexPage as { html: string; url: string } | null;
  if (followIndex && !budget.stopReason && (discovered.size === 0 || (segments.length > 0 && !hasSectionHit()))) {
    const indexBase = new URL(followIndex.url);
    const listed = scanHtml(followIndex.html);
    const entries: Array<[string, Candidate]> = [];
    const seen = new Set<string>();
    const consider = (href: string | undefined, label: string, score: number) => {
      if (!href || href.length > MAX_CANDIDATE_URL_LENGTH) return;
      let abs: string;
      try {
        abs = new URL(href, indexBase).toString();
      } catch {
        return;
      }
      if (!/^https?:/i.test(abs) || abs.length > MAX_CANDIDATE_URL_LENGTH || seen.has(abs) || candidateLinks.has(abs)) return;
      seen.add(abs);
      entries.push([abs, { title: label || abs, type: "unknown", origin: "index", score: score + 40 * affinityOf(abs, label) }]);
    };
    for (const l of listed.links) {
      if (relTokens(l.attrs.rel).includes("alternate") && /^application\/(?:rss\+xml|atom\+xml|feed\+json)\b/i.test((l.attrs.type || "").trim())) {
        consider(l.attrs.href, l.attrs.title ?? "", 60);
      }
    }
    for (const a of listed.anchors) {
      if (!a.href || !(looksLikeFeedUrl(a.href) || anchorSaysFeed(a))) continue;
      consider(a.href, a.text || a.title || a.ariaLabel, 50);
    }
    entries.sort((a, b) => b[1].score - a[1].score);
    await runBatches(entries.slice(0, BATCH + 1));
  }

  // Final order: stage score, plus how well the feed matches the section the
  // user typed — a section page ranks its own feed above the site-wide one.
  const ranked = [...discovered.values()].map((f) => ({ f, rank: f.score + 40 * affinityOf(f.url, f.title) }));
  const feeds = ranked
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 10)
    .map(({ f: { score: _score, ...feed } }) => feed);
  return { feeds, hint, pageUrl: responseUrl.toString(), sectionHit: segments.length > 0 && feeds.some((f) => affinityOf(f.url, f.title) > 0) };
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
 *     anchors, then common feed paths (section-relative ones first for a
 *     section page; a feed INDEX page found there is followed one level) —
 *     every candidate (c) prefix-verified and ranked by section affinity;
 *     the page fetch falls back to the other HTTP transport when refused
 *     → curated publisher routes only as a fallback (page found nothing,
 *     a section page found only site-wide feeds, or only blind
 *     common-path guesses; also when the page itself is blocked) → (d)
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
  // Must a platform rule answer before the page is read (one-step lookups,
  // resolver feeds, registry platform adapters)? Otherwise the page fetch
  // starts right away, in parallel with the resolver, RSSHub radar and the
  // curated routes — no avoidable sequential round trip.
  const sync = matchSource(cleaned);
  const platformFirst = sync.lookups.length > 0 || sync.feeds.some((f) => !f.curated) || matchPlatformAdapters(url).length > 0;
  const noNative = { matched: false, feeds: [] as DiscoveredFeed[], curated: [] as ResolvedFeed[] };
  const nativeP = resolveWithPlatformRules(cleaned, budget).catch(() => noNative);
  const radarP = resolveWithRadarRules(pageUrl, budget);
  // Curated publisher routes are verified up front (one request each, so a
  // blocked page's blind probes cannot starve them of budget) but OFFERED
  // only as a fallback below.
  const curatedRoutes = sync.feeds.filter((f) => f.curated);
  const curatedP = curatedRoutes.length ? verifyCurated(curatedRoutes, budget).catch(() => [] as DiscoveredFeed[]) : Promise.resolve([] as DiscoveredFeed[]);
  const readPage = () => discoverFeedsInHtml(pageUrl, budget, { httpFallback }).catch((): HtmlDiscovery | { feeds: DiscoveredFeed[] } => ({ feeds: [] }));

  let native: Awaited<typeof nativeP>;
  let html: Partial<HtmlDiscovery> & { feeds: DiscoveredFeed[] };
  if (platformFirst) {
    native = await nativeP;
    html = native.feeds.length ? { feeds: [] } : await readPage();
  } else {
    [native, html] = await Promise.all([nativeP, readPage()]);
  }
  const [radar, curatedVerified] = await Promise.all([radarP, curatedP]);

  // Curated routes are the fallback: offered when the page found nothing,
  // when a SECTION page only yielded site-wide feeds (the curated route is
  // the section's own feed → ranked first), or when the only page hits are
  // blind common-path guesses (curated ranked after them).
  const sectionInput = sectionSegments(url).length > 0;
  let curatedFirst: DiscoveredFeed[] = [];
  let curatedLast: DiscoveredFeed[] = [];
  if (!native.feeds.length && curatedVerified.length) {
    if (!html.feeds.length) curatedLast = curatedVerified;
    else if (sectionInput && !html.sectionHit) curatedFirst = curatedVerified;
    else if (html.feeds.every((f) => f.source === "common-path")) curatedLast = curatedVerified;
  }

  const merged = new Map<string, DiscoveredFeed>();
  for (const f of [...native.feeds, ...curatedFirst, ...html.feeds, ...curatedLast, ...radar.feeds]) if (!merged.has(f.url)) merged.set(f.url, f);

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
    ...(merged.size > 0 && html.hint === "blocked" ? { pageBlocked: true as const } : {}),
  };
}

/** Back-compat wrapper: feeds for a page URL (or any input `discoverFeeds` understands). */
export async function discoverFeedsAtUrl(pageUrl: string, options: DiscoverOptions = {}): Promise<DiscoveredFeed[]> {
  return (await discoverFeeds(pageUrl, options)).feeds;
}
