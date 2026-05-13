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

export type StarterPackValidation = {
  packs: StarterPack[];
  errors: string[];
  warnings: string[];
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

function normalizeUrl(value: unknown, field: string, errors: string[], required = false) {
  const raw = String(value || "").trim();
  if (!raw) {
    if (required) errors.push(`${field} is required`);
    return "";
  }
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) {
      errors.push(`${field} must use http or https`);
      return "";
    }
    return url.toString();
  } catch {
    errors.push(`${field} must be a valid URL`);
    return "";
  }
}

function slugify(value: string, fallback: string) {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function normalizePath(value: unknown) {
  const path = String(value || "").trim();
  if (!path) return undefined;
  return /^[a-zA-Z0-9._-]+\.opml$/.test(path) ? path : undefined;
}

export function normalizeStarterPacksInput(input: unknown): StarterPackValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!Array.isArray(input)) {
    return { packs: DEFAULT_STARTER_PACKS, errors: ["Starter packs must be a list"], warnings };
  }

  const usedPackIds = new Set<string>();
  const packs = input.map((rawPack: any, index) => {
    const packName = String(rawPack?.name || "").trim();
    if (!packName) errors.push(`Pack ${index + 1}: name is required`);

    let id = slugify(String(rawPack?.id || packName), `pack-${index + 1}`);
    const baseId = id;
    let suffix = 2;
    while (usedPackIds.has(id)) id = `${baseId}-${suffix++}`;
    if (id !== String(rawPack?.id || "").trim()) {
      warnings.push(`Pack "${packName || index + 1}" received a unique id: ${id}`);
    }
    usedPackIds.add(id);

    const feedUrls = new Set<string>();
    const feeds = Array.isArray(rawPack?.feeds)
      ? rawPack.feeds.flatMap((rawFeed: any, feedIndex: number) => {
          const feedErrors: string[] = [];
          const xmlUrl = normalizeUrl(
            rawFeed?.xmlUrl,
            `Pack "${packName || id}" feed ${feedIndex + 1} RSS/Atom URL`,
            feedErrors,
            true,
          );
          const htmlUrl = normalizeUrl(
            rawFeed?.htmlUrl,
            `Pack "${packName || id}" feed ${feedIndex + 1} website URL`,
            feedErrors,
            false,
          );
          if (feedErrors.length > 0) {
            errors.push(...feedErrors);
            return [];
          }
          const dedupeKey = xmlUrl.toLowerCase();
          if (feedUrls.has(dedupeKey)) {
            warnings.push(`Pack "${packName || id}": duplicate feed skipped (${xmlUrl})`);
            return [];
          }
          feedUrls.add(dedupeKey);
          return [{
            title: String(rawFeed?.title || rawFeed?.text || xmlUrl).trim(),
            xmlUrl,
            htmlUrl,
            category: String(rawFeed?.category || "").trim(),
          }];
        })
      : [];

    const path = normalizePath(rawPack?.path);
    const enabled = rawPack?.enabled !== false;
    if (enabled && feeds.length === 0 && !path) {
      errors.push(`Pack "${packName || id}" is enabled but has no feeds`);
    }

    return {
      id,
      name: packName || "Untitled pack",
      description: typeof rawPack?.description === "string" ? rawPack.description.trim() : "",
      enabled,
      path,
      feeds,
    };
  });

  return { packs, errors, warnings };
}

export function starterPackToOpml(pack: StarterPack) {
  const feedsByCategory = new Map<string, StarterPackFeed[]>();
  const rootFeeds: StarterPackFeed[] = [];
  for (const feed of pack.feeds) {
    const category = feed.category?.trim();
    if (!category) {
      rootFeeds.push(feed);
      continue;
    }
    if (!feedsByCategory.has(category)) feedsByCategory.set(category, []);
    feedsByCategory.get(category)!.push(feed);
  }

  const feedOutline = (feed: StarterPackFeed, indent: string) => {
    const category = feed.category ? ` category="${escapeXml(feed.category)}"` : "";
    const htmlUrl = feed.htmlUrl ? ` htmlUrl="${escapeXml(feed.htmlUrl)}"` : "";
    return `${indent}<outline type="rss" text="${escapeXml(feed.title || feed.xmlUrl)}" xmlUrl="${escapeXml(feed.xmlUrl)}"${htmlUrl}${category}/>`;
  };

  const outlines = [
    ...rootFeeds.map((feed) => feedOutline(feed, "    ")),
    ...Array.from(feedsByCategory.entries()).map(([category, feeds]) => `    <outline text="${escapeXml(category)}">
${feeds.map((feed) => feedOutline(feed, "      ")).join("\n")}
    </outline>`),
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${escapeXml(pack.name)}</title>
  </head>
  <body>
${outlines.join("\n")}
  </body>
</opml>`;
}

export function parseStarterPacksJson(value?: string | null): StarterPack[] {
  if (!value) return DEFAULT_STARTER_PACKS;
  try {
    const parsed = JSON.parse(value);
    const result = normalizeStarterPacksInput(parsed);
    return result.errors.length > 0 ? DEFAULT_STARTER_PACKS : result.packs;
  } catch {
    return DEFAULT_STARTER_PACKS;
  }
}

export function stringifyStarterPacks(packs: StarterPack[]) {
  return JSON.stringify(normalizeStarterPacksInput(packs).packs, null, 2);
}
