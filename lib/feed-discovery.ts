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
  "text/xml",
  "application/xml",
];

function classifyFeedType(mimeType: string): DiscoveredFeed["type"] {
  const m = mimeType.toLowerCase();
  if (m.includes("atom")) return "atom";
  if (m.includes("rss") || m.includes("xml")) return "rss";
  return "unknown";
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

  const linkEls = document.querySelectorAll('link[rel~="alternate"]');
  for (const el of linkEls) {
    const type = (el.getAttribute("type") || "").toLowerCase().trim();
    if (!FEED_MIME_TYPES.some((t) => type.startsWith(t) || t.startsWith(type.split("+")[0]))) {
      continue;
    }
    const href = el.getAttribute("href");
    if (!href) continue;
    try {
      const feedUrl = new URL(href, base).toString();
      if (!discovered.has(feedUrl)) {
        discovered.set(feedUrl, {
          url: feedUrl,
          title: el.getAttribute("title") || feedUrl,
          type: classifyFeedType(type),
        });
      }
    } catch {
      // invalid URL
    }
  }

  return [...discovered.values()].slice(0, 10);
}
