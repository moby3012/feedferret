import { JSDOM } from "jsdom";
import { fetchTextWithSsrfProtection } from "./ssrf";
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

export type DiscoveryResult = {
  /** "topic" = the input was a plain phrase and `feeds` are search-engine feeds to pick from. */
  mode: "url" | "topic" | "empty";
  feeds: DiscoveredFeed[];
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
const resolverFetchText = (url: string, init?: { headers?: Record<string, string> }) =>
  fetchTextWithSsrfProtection(
    url,
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; FeedFerret/1.0; +feed-discovery)",
        ...(init?.headers ?? {}),
      },
    },
    // YouTube channel/watch pages are ~1–3 MB of HTML.
    { maxBytes: 4 * 1024 * 1024, timeoutMs: 12_000 },
  );

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

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
async function resolveWithRadarRules(pageUrl: string): Promise<DiscoveredFeed[]> {
  try {
    const { radarRoutesFor, getRsshubConfig, buildRsshubRouteUrl, validateRsshubRoute } = await import("./rsshub");
    const matches = radarRoutesFor(pageUrl).slice(0, 4);
    if (!matches.length) return [];
    const config = await getRsshubConfig();
    if (!config) return [];
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000));
    const results = await Promise.all(
      matches.map(async (m): Promise<DiscoveredFeed | null> => {
        const validation = await Promise.race([validateRsshubRoute(config, m.route), timeout]);
        if (!validation || !validation.ok) return null;
        return {
          url: buildRsshubRouteUrl(config, m.route),
          title: `RSSHub · ${m.title}${validation.title ? ` (${validation.title})` : ""}`,
          type: "unknown",
          source: "radar",
          kind: "rsshub",
          platform: "rsshub",
          confidence: 0.7,
        };
      }),
    );
    return results.filter((f): f is DiscoveredFeed => f !== null);
  } catch {
    return [];
  }
}

/** Stage 2 — classic HTML discovery: `<link rel=alternate>`, feed-looking anchors, common feed paths. */
async function discoverFeedsInHtml(pageUrl: string): Promise<DiscoveredFeed[]> {
  let html = "";
  try {
    html = await fetchTextWithSsrfProtection(pageUrl, {}, {
      maxBytes: 512 * 1024,
      timeoutMs: 12_000,
    });
  } catch {
    // The page itself may be unreachable/blocked while /feed still works —
    // fall through to the common-path probes below.
  }

  const dom = new JSDOM(html);
  const { document } = dom.window;
  const discovered = new Map<string, DiscoveredFeed>();
  const base = new URL(pageUrl);
  const candidateLinks = new Map<string, { title: string; type: DiscoveredFeed["type"]; strong: boolean; commonPath: boolean }>();

  const addCandidate = (href: string | null, title: string | null, type: DiscoveredFeed["type"], strong = false, commonPath = false) => {
    if (!href) return;
    try {
      const feedUrl = new URL(href, base).toString();
      if (!strong && !looksLikeFeedUrl(feedUrl)) return;
      if (!candidateLinks.has(feedUrl)) {
        candidateLinks.set(feedUrl, { title: title || feedUrl, type, strong, commonPath });
      }
    } catch {
      // invalid URL
    }
  };

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
    addCandidate(commonPath, `${base.hostname} feed`, "unknown", true, true);
  }

  // Verify in small parallel batches (each probe can take up to the timeout);
  // advertised feeds come first in insertion order, so they win the 10 slots.
  const entries = [...candidateLinks.entries()];
  const BATCH = 5;
  for (let i = 0; i < entries.length && discovered.size < 10; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const verified = await Promise.all(batch.map(([url, c]) => verifyFeedCandidate(url, c.title, c.type)));
    verified.forEach((v, idx) => {
      if (!v || discovered.has(v.url)) return;
      discovered.set(v.url, { ...v, source: batch[idx][1].commonPath ? "common-path" : "html" });
    });
  }

  return [...discovered.values()].slice(0, 10);
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

  const html = native.feeds.length ? [] : await discoverFeedsInHtml(pageUrl).catch(() => []);
  const merged = new Map<string, DiscoveredFeed>();
  for (const f of [...native.feeds, ...html, ...radar]) if (!merged.has(f.url)) merged.set(f.url, f);
  return { mode: "url", feeds: [...merged.values()] };
}

/** Back-compat wrapper: feeds for a page URL (or any input `discoverFeeds` understands). */
export async function discoverFeedsAtUrl(pageUrl: string, options: DiscoverOptions = {}): Promise<DiscoveredFeed[]> {
  return (await discoverFeeds(pageUrl, options)).feeds;
}
