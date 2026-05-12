import { JSDOM } from "jsdom";
import { fetchTextWithSsrfProtection } from "./ssrf";

export type DiscoveredFeed = {
  url: string;
  title: string;
  type: "rss" | "atom" | "unknown";
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

async function verifyFeedCandidate(url: string, title: string, fallbackType: DiscoveredFeed["type"]) {
  try {
    const text = await fetchTextWithSsrfProtection(url, {}, {
      maxBytes: 512 * 1024,
      timeoutMs: 12_000,
    });
    const lower = text.trim().slice(0, 1000).toLowerCase();
    if (!looksLikeFeedContent(text, "")) return null;
    const type: DiscoveredFeed["type"] = lower.includes("<feed") ? "atom" : lower.includes("<rss") || lower.includes("<rdf:rdf") ? "rss" : fallbackType;
    return { url, title, type };
  } catch {
    return null;
  }
}

export async function discoverFeedsAtUrl(pageUrl: string): Promise<DiscoveredFeed[]> {
  let html: string;
  try {
    html = await fetchTextWithSsrfProtection(pageUrl, {}, {
      maxBytes: 512 * 1024,
      timeoutMs: 12_000,
    });
  } catch {
    return [];
  }

  const dom = new JSDOM(html);
  const { document } = dom.window;
  const discovered = new Map<string, DiscoveredFeed>();
  const base = new URL(pageUrl);
  const candidateLinks = new Map<string, { title: string; type: DiscoveredFeed["type"]; strong: boolean }>();

  const addCandidate = (href: string | null, title: string | null, type: DiscoveredFeed["type"], strong = false) => {
    if (!href) return;
    try {
      const feedUrl = new URL(href, base).toString();
      if (!strong && !looksLikeFeedUrl(feedUrl)) return;
      if (!candidateLinks.has(feedUrl)) {
        candidateLinks.set(feedUrl, { title: title || feedUrl, type, strong });
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

  for (const commonPath of ["/feed", "/feed/", "/rss", "/rss.xml", "/atom.xml", "/feed.xml", "/api/feeds/posts"]) {
    addCandidate(commonPath, `${base.hostname} feed`, "unknown");
  }

  for (const [url, candidate] of candidateLinks) {
    const verified = await verifyFeedCandidate(url, candidate.title, candidate.type);
    if (verified && !discovered.has(url)) discovered.set(url, verified);
    if (discovered.size >= 10) break;
  }

  return [...discovered.values()].slice(0, 10);
}
