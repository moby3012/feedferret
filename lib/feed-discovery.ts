import { JSDOM } from "jsdom";
import { fetchTextWithSsrfProtection, fetchWithSsrfProtection, isTrustedFeedFetchingAllowed } from "./ssrf";
import { parseHttpLinkHeader } from "./http-link-header";
import { hintForFetchError } from "./fetch-error-hint";
import { buildTopicFeeds, parseSourceInput, resolveSource, type ResolvedFeed } from "./smart-url-resolver";

export type DiscoveredFeed = {
  url: string;
  title: string;
  type: "rss" | "atom" | "json" | "unknown";
  /** Which stage produced it. Absent on legacy callers' data. */
  source?: "resolver" | "topic" | "radar" | "html" | "common-path";
  /** Resolver/topic/radar candidates only: variant of the feed (releases, commits, hot, …). */
  kind?: string;
  /** Platform / engine slug ("youtube", "github", "google-news", "rsshub", …). */
  platform?: string;
  /** 0–1 — how sure the stage is that this is what the user meant. */
  confidence?: number;
};

export type DiscoveryHint = "needs-rsshub" | "rate-limited" | "blocked";

export type DiscoveryResult = {
  /** "topic" = the input was a plain phrase and `feeds` are search-engine feeds to pick from. */
  mode: "url" | "topic" | "empty";
  feeds: DiscoveredFeed[];
  hint?: DiscoveryHint;
};

export type DiscoverOptions = {
  /** UI locale ("de", "en-GB") — localizes Google News topic feeds. */
  locale?: string | null;
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
  return /(?:rss|atom|feed|feeds|xml|\.rss)(?:[/?#.]|$)/i.test(url);
}

function looksLikeFeedContent(text: string, contentType: string) {
  const trimmed = text.trim().slice(0, 2000).toLowerCase();
  return (
    FEED_MIME_TYPES.some((type) => contentType.includes(type)) ||
    trimmed.startsWith("<rss") ||
    trimmed.includes("<rss ") ||
    trimmed.startsWith("<feed") ||
    trimmed.includes("<feed ") ||
    trimmed.includes("<rdf:rdf") ||
    trimmed.includes('"version":"https://jsonfeed.org/') ||
    trimmed.includes('"version": "https://jsonfeed.org/')
  );
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

async function verifyFeedCandidate(url: string, title: string, fallbackType: DiscoveredFeed["type"]) {
  try {
    const text = await fetchTextWithSsrfProtection(url, {}, {
      maxBytes: 512 * 1024,
      timeoutMs: 12_000,
      allowInternal: await isTrustedFeedFetchingAllowed(),
    });
    const lower = text.trim().slice(0, 1000).toLowerCase();
    if (!looksLikeFeedContent(text, "")) return null;
    const type: DiscoveredFeed["type"] = lower.includes("<feed")
      ? "atom"
      : lower.includes("<rss") || lower.includes("<rdf:rdf")
        ? "rss"
        : lower.includes("jsonfeed.org")
          ? "json"
          : fallbackType;
    return { url, title, type };
  } catch {
    return null;
  }
}

function toDiscovered(f: ResolvedFeed, source: "resolver" | "topic"): DiscoveredFeed {
  return {
    url: f.url,
    title: f.title,
    type: f.format ?? "unknown",
    source,
    kind: f.kind,
    platform: f.platform,
    confidence: f.confidence,
  };
}

/** SSRF-protected text fetch handed to the pure resolver for its one-step lookups. */
const resolverFetchText = async (url: string, init?: { headers?: Record<string, string> }) =>
  fetchTextWithSsrfProtection(
    url,
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; FeedFerret/1.0; +feed-discovery)",
        ...(init?.headers ?? {}),
      },
    },
    // YouTube channel/watch pages are ~1–3 MB of HTML.
    { maxBytes: 4 * 1024 * 1024, timeoutMs: 12_000, allowInternal: await isTrustedFeedFetchingAllowed() },
  );

/**
 * Stage 1 — deterministic platform resolution (YouTube, Reddit, GitHub, …).
 * Candidates flagged `verify` are plausible guesses (e.g. any `/@user` on an
 * unknown host might be Mastodon) and are fetch-checked before being offered.
 */
async function resolveWithPlatformRules(input: string): Promise<{ matched: boolean; feeds: DiscoveredFeed[] }> {
  const { matched, feeds } = await resolveSource(input, { fetchText: resolverFetchText });
  if (!feeds.length) return { matched, feeds: [] };
  const checked = await Promise.all(
    feeds.map(async (f) => {
      if (!f.verify) return toDiscovered(f, "resolver");
      const ok = await verifyFeedCandidate(f.url, f.title, f.format ?? "unknown");
      return ok ? { ...toDiscovered(f, "resolver"), type: ok.type } : null;
    }),
  );
  return { matched, feeds: checked.filter((f): f is DiscoveredFeed => f !== null) };
}

/**
 * Stage 3 — bundled RSSHub Radar rules → routes on the configured RSSHub
 * instance, each validated before it is offered. Empty (and free) when no
 * instance is configured or no rule matches.
 */
async function resolveWithRadarRules(pageUrl: string): Promise<{ feeds: DiscoveredFeed[]; needsRsshub?: boolean }> {
  try {
    const { radarRoutesFor, getRsshubConfig, buildRsshubPublicRouteUrl, validateRsshubRoute } = await import("./rsshub");
    const matches = radarRoutesFor(pageUrl).slice(0, 4);
    if (!matches.length) return { feeds: [] };
    const config = await getRsshubConfig();
    if (!config) return { feeds: [], needsRsshub: true };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 15_000); });
    const results = await Promise.all(
      matches.map(async (m): Promise<DiscoveredFeed | null> => {
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

/** Early-stop predicate for the page prefix read: the head already advertises a feed. */
function headAdvertisesFeed(headHtml: string): boolean {
  return /<link\b[^>]*\brel\s*=\s*["']?[^"'>]*\balternate\b[^>]*>/i.test(headHtml)
    && /(application\/(rss|atom)\+xml|application\/feed\+json)/i.test(headHtml);
}

/** Stage 2 — classic HTML discovery: `<link rel=alternate>`, feed-looking anchors, common feed paths. */
async function discoverFeedsInHtml(pageUrl: string): Promise<{ feeds: DiscoveredFeed[]; hint?: DiscoveryHint }> {
  let html = "";
  let hint: DiscoveryHint | undefined;
  const allowInternal = await isTrustedFeedFetchingAllowed();
  // Relative references resolve against the FINAL URL after redirects (and
  // a document `<base href>`), not the URL the user typed.
  let base = new URL(pageUrl);
  let responseUrl = base;
  const candidateLinks = new Map<string, { title: string; type: DiscoveredFeed["type"]; strong: boolean; commonPath: boolean }>();

  const addCandidate = (href: string | null, title: string | null, type: DiscoveredFeed["type"], strong = false, commonPath = false, resolveAgainst: URL = base) => {
    if (!href) return;
    try {
      const feedUrl = new URL(href, resolveAgainst).toString();
      if (!/^https?:$/.test(new URL(feedUrl).protocol)) return;
      if (!strong && !looksLikeFeedUrl(feedUrl)) return;
      if (!candidateLinks.has(feedUrl)) {
        candidateLinks.set(feedUrl, { title: title || feedUrl, type, strong, commonPath });
      }
    } catch {
      // invalid URL
    }
  };

  try {
    const result = await fetchWithSsrfProtection(pageUrl, {}, {
      maxBytes: 1024 * 1024,
      timeoutMs: 12_000,
      // Large pages: read a bounded prefix (never fail on size). Stop at the
      // end of <head> only when it already advertises a feed; otherwise keep
      // reading so feed anchors in the body are still found.
      untilHead: headAdvertisesFeed,
      allowInternal,
    });
    if (result.url) base = responseUrl = new URL(result.url);
    if (!result.notModified) {
      html = result.text;
      for (const entry of parseHttpLinkHeader(result.headers?.get("link") ?? null)) {
        const type = linkHeaderFeedType(entry);
        if (type) addCandidate(entry.url, entry.title || null, type, true);
      }
    }
  } catch (err) {
    hint = hintForFetchError(err);
  }

  const dom = new JSDOM(html);
  const { document } = dom.window;
  const discovered = new Map<string, DiscoveredFeed>();
  const baseHref = document.querySelector("base[href]")?.getAttribute("href");
  if (baseHref) {
    try {
      base = new URL(baseHref, base);
    } catch {
      // invalid <base href>: keep the response URL
    }
  }

  const linkEls = document.querySelectorAll('link[rel~="alternate"]');
  for (const el of linkEls) {
    const type = (el.getAttribute("type") || "").toLowerCase().trim();
    const isFeedMime = type.length > 0 && FEED_MIME_TYPES.some((t) => type.startsWith(t) || t.startsWith(type.split("+")[0]));
    if (!isFeedMime && !looksLikeFeedUrl(el.getAttribute("href") || "")) {
      continue;
    }
    addCandidate(el.getAttribute("href"), el.getAttribute("title"), classifyFeedType(type), isFeedMime);
  }

  document.querySelectorAll("a[href], link[href]").forEach((el) => {
    addCandidate(el.getAttribute("href"), el.textContent?.trim() || el.getAttribute("title"), "unknown");
  });

  for (const commonPath of COMMON_FEED_PATHS) {
    // Root-relative on purpose ("/?feed=rss2" must stay at the site root).
    addCandidate(commonPath, `${responseUrl.hostname} feed`, "unknown", true, true, responseUrl);
  }

  // Verify in small parallel batches (each probe can take up to the timeout);
  // advertised feeds come first in insertion order, so they win the 10 slots.
  // Bounded fan-out: at most 25 advertised/anchor candidates, and the common
  // paths always keep their slots (a page full of feed-looking anchors must not
  // turn one request into hundreds of probes).
  const all = [...candidateLinks.entries()];
  const entries = [...all.filter(([, c]) => !c.commonPath).slice(0, 25), ...all.filter(([, c]) => c.commonPath)];
  const BATCH = 5;
  for (let i = 0; i < entries.length && discovered.size < 10; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const verified = await Promise.all(batch.map(([url, c]) => verifyFeedCandidate(url, c.title, c.type)));
    verified.forEach((v, idx) => {
      if (!v || discovered.has(v.url)) return;
      discovered.set(v.url, { ...v, source: batch[idx][1].commonPath ? "common-path" : "html" });
    });
  }

  return { feeds: [...discovered.values()].slice(0, 10), hint };
}

/**
 * Turns whatever the user pasted into feed candidates, cheapest and most
 * deterministic stage first:
 *   - plain phrase → search-engine topic feeds (Google News locale-aware, Bing
 *     News, hnrss, arXiv) for the user to pick from;
 *   - URL/handle → platform rules (no scraping, no AI) → HTML discovery +
 *     common feed paths (when no platform rule produced anything) → bundled
 *     RSSHub Radar rules on the configured RSSHub instance (if any).
 * Never throws.
 */
export async function discoverFeeds(input: string, options: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const parsed = parseSourceInput(input);
  if (parsed.type === "empty") return { mode: "empty", feeds: [] };
  if (parsed.type === "topic") {
    return { mode: "topic", feeds: buildTopicFeeds(parsed.query, { locale: options.locale }).map((f) => toDiscovered(f, "topic")) };
  }

  const pageUrl = parsed.url.toString();
  const [native, radar] = await Promise.all([
    resolveWithPlatformRules(input).catch(() => ({ matched: false, feeds: [] as DiscoveredFeed[] })),
    resolveWithRadarRules(pageUrl),
  ]);

  const html = native.feeds.length ? { feeds: [] } : await discoverFeedsInHtml(pageUrl).catch(() => ({ feeds: [] }));
  const merged = new Map<string, DiscoveredFeed>();
  for (const f of [...native.feeds, ...html.feeds, ...radar.feeds]) if (!merged.has(f.url)) merged.set(f.url, f);

  let hint: DiscoveryHint | undefined;
  if (merged.size === 0) {
    if (radar.needsRsshub) {
      hint = "needs-rsshub";
    } else if (html.hint) {
      hint = html.hint;
    }
  }

  return { mode: "url", feeds: [...merged.values()], hint };
}

/** Back-compat wrapper: feeds for a page URL (or any input `discoverFeeds` understands). */
export async function discoverFeedsAtUrl(pageUrl: string, options: DiscoverOptions = {}): Promise<DiscoveredFeed[]> {
  return (await discoverFeeds(pageUrl, options)).feeds;
}
