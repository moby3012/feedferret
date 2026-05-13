export type StarterPackFeed = {
  title: string;
  xmlUrl: string;
  htmlUrl?: string;
  category?: string;
};

export type StarterPack = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  path?: string;
  feeds: StarterPackFeed[];
};

export const DEFAULT_STARTER_PACKS: StarterPack[] = [
  { id: "tech", name: "Technology", path: "tech.opml", enabled: true, feeds: [] },
  { id: "science", name: "Science", path: "science.opml", enabled: true, feeds: [] },
  { id: "news", name: "World News", path: "news.opml", enabled: true, feeds: [] },
  { id: "dev", name: "Developer News", path: "dev.opml", enabled: true, feeds: [] },
  { id: "design", name: "Design & UX", path: "design.opml", enabled: true, feeds: [] },
];

function escapeXml(value: string) {
  return value.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case "\"": return "&quot;";
      case "'": return "&apos;";
      default: return c;
    }
  });
}

export function starterPackToOpml(pack: StarterPack) {
  const outlines = pack.feeds.map((feed) => {
    const category = feed.category ? ` category="${escapeXml(feed.category)}"` : "";
    const htmlUrl = feed.htmlUrl ? ` htmlUrl="${escapeXml(feed.htmlUrl)}"` : "";
    return `      <outline type="rss" text="${escapeXml(feed.title || feed.xmlUrl)}" xmlUrl="${escapeXml(feed.xmlUrl)}"${htmlUrl}${category}/>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${escapeXml(pack.name)}</title>
  </head>
  <body>
    <outline text="${escapeXml(pack.name)}">
${outlines.join("\n")}
    </outline>
  </body>
</opml>`;
}

export function parseStarterPacksJson(value?: string | null): StarterPack[] {
  if (!value) return DEFAULT_STARTER_PACKS;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return DEFAULT_STARTER_PACKS;
    return parsed.map((pack: any, index: number) => ({
      id: String(pack.id || `pack-${index + 1}`),
      name: String(pack.name || "Untitled pack"),
      description: typeof pack.description === "string" ? pack.description : "",
      enabled: pack.enabled !== false,
      path: typeof pack.path === "string" ? pack.path : undefined,
      feeds: Array.isArray(pack.feeds)
        ? pack.feeds
            .map((feed: any) => ({
              title: String(feed.title || feed.xmlUrl || "Untitled feed"),
              xmlUrl: String(feed.xmlUrl || ""),
              htmlUrl: typeof feed.htmlUrl === "string" ? feed.htmlUrl : "",
              category: typeof feed.category === "string" ? feed.category : "",
            }))
            .filter((feed: StarterPackFeed) => feed.xmlUrl)
        : [],
    }));
  } catch {
    return DEFAULT_STARTER_PACKS;
  }
}

export function stringifyStarterPacks(packs: StarterPack[]) {
  return JSON.stringify(packs, null, 2);
}
