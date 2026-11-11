// Smart source → feed resolver.

import { resolvePublisherFeeds } from "./publisher-feeds";

/** decodeURIComponent that never throws (malformed `%` sequences stay as-is). */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

//
// Turns "whatever the user pasted" (a platform URL, an @handle, `r/rust`, a
// plain topic phrase) into concrete feed candidates deterministically — before
// any HTML scraping, RSSHub round-trip, or AI call. Everything here is
// table-driven and pure (no module-level I/O): `matchSource` is synchronous,
// and the few platforms that need one lookup (a YouTube @handle → channel id,
// an Apple Podcasts id → feedUrl) go through an *injected* `fetchText`, so
// callers route that through the SSRF-protected helpers and unit tests mock it.
//
// Only stable, documented (or long-standing and live-verified) URL patterns
// are used. Notably NOT used:
//   - YouTube `UULF…` ("no Shorts / Lives") playlist feeds: undocumented by
//     YouTube, community-reported only, and `playlist_id=` feeds returned 404
//     when probed on 2026-11-10 (a wider YouTube feed outage has been reported
//     since Dec 2025). Omitted until YouTube documents it.
//   - YouTube `?user=` legacy feeds (404 on probe) — resolved via the channel
//     page instead.

export type FeedKind =
  | "videos"
  | "playlist"
  | "posts"
  | "hot"
  | "new"
  | "top"
  | "comments"
  | "search"
  | "releases"
  | "commits"
  | "tags"
  | "activity"
  | "tag"
  | "stories"
  | "podcast"
  | "news"
  | "diary"
  | "topic"
  | "latest"
  | "category"
  | "thread"
  | "downloads"
  | "announcements";

export type ResolvedFeed = {
  url: string;
  title: string;
  kind: FeedKind;
  /** Stable slug of the platform / engine ("youtube", "reddit", "google-news", …). */
  platform: string;
  /** 0–1. Deterministic exact-id patterns ≈ 0.95; guesses / variants lower. */
  confidence: number;
  format?: "rss" | "atom" | "json";
  /** Candidate is a plausible guess — callers should fetch-verify it before showing it. */
  verify?: boolean;
  /**
   * Per-site curated data (publisher table), not a URL-scheme rule. Discovery
   * uses it only as a fallback when the page's own feeds can't be found.
   */
  curated?: boolean;
};

export type Lookup =
  | { type: "youtube-page"; url: string; fallbackTitle: string }
  | { type: "itunes"; id: string; country: string | null };

export type SourceMatch = { feeds: ResolvedFeed[]; lookups: Lookup[]; matched: boolean };

export type ParsedInput =
  | { type: "url"; url: URL }
  | { type: "topic"; query: string }
  | { type: "empty" };

export type ResolverDeps = {
  fetchText: (url: string, init?: { headers?: Record<string, string> }) => Promise<string>;
};

const PLATFORM_LABEL: Record<string, string> = {
  youtube: "YouTube",
  reddit: "Reddit",
  mastodon: "Mastodon",
  bluesky: "Bluesky",
  github: "GitHub",
  gitlab: "GitLab",
  arxiv: "arXiv",
  substack: "Substack",
  medium: "Medium",
  hackernews: "Hacker News",
  lobsters: "Lobsters",
  "apple-podcasts": "Apple Podcasts",
  steam: "Steam",
  letterboxd: "Letterboxd",
  "google-news": "Google News",
  "bing-news": "Bing News",
  tagesschau: "Tagesschau",
  heise: "Heise",
  spiegel: "Spiegel",
  bbc: "BBC News",
  npr: "NPR",
  nytimes: "The New York Times",
  zeit: "ZEIT ONLINE",
  sueddeutsche: "Süddeutsche Zeitung",
  faz: "FAZ",
  golem: "Golem.de",
  t3n: "t3n",
  netzpolitik: "netzpolitik.org",
  derstandard: "Der Standard",
};

export function platformLabel(platform: string): string {
  return PLATFORM_LABEL[platform] ?? platform;
}

function feed(
  platform: string,
  kind: FeedKind,
  url: string,
  subject: string,
  confidence: number,
  extra: Partial<ResolvedFeed> = {},
): ResolvedFeed {
  return { url, title: `${platformLabel(platform)} · ${subject}`, kind, platform, confidence, ...extra };
}

const enc = encodeURIComponent;

/* -------------------------------------------------------------------------- */
/* Input parsing                                                               */
/* -------------------------------------------------------------------------- */

const FEDI_HANDLE = /^@?([A-Za-z0-9_.-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$/;
const REDDIT_SHORT = /^\/?([ru])\/([A-Za-z0-9_+-]{2,50})\/?$/;
const BSKY_HANDLE = /^@?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.bsky\.social)$/i;
const YT_HANDLE = /^@([A-Za-z0-9_.-]{3,30})$/;
const FILE_LIKE_TLDS = new Set(["js", "ts", "jsx", "tsx", "py", "rs", "md", "rb", "sh", "json", "yml", "yaml", "css", "html", "txt", "php", "java", "cpp", "swift"]);
const BARE_HOST_PATH = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#]\S*)?$/i;

/**
 * Classifies free-form input: a URL (explicit, scheme-less, or a handle that
 * maps to one) or a topic phrase. Never throws.
 */
export function parseSourceInput(raw: string): ParsedInput {
  const input = (raw ?? "").trim();
  if (!input) return { type: "empty" };

  const tryUrl = (value: string): ParsedInput | null => {
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") return { type: "url", url };
    } catch {
      /* fall through */
    }
    return null;
  };

  const stripped = input.replace(/^feed:(?=https?:)/i, "").replace(/^feed:\/\//i, "https://");
  if (/^https?:\/\//i.test(stripped)) {
    const parsed = tryUrl(stripped);
    return parsed ?? { type: "topic", query: input };
  }

  const reddit = REDDIT_SHORT.exec(input);
  if (reddit) {
    return tryUrl(`https://www.reddit.com/${reddit[1] === "u" ? "user" : "r"}/${reddit[2]}`) ?? { type: "empty" };
  }

  const fedi = FEDI_HANDLE.exec(input);
  if (fedi) return tryUrl(`https://${fedi[2].toLowerCase()}/@${fedi[1]}`) ?? { type: "empty" };

  const bsky = BSKY_HANDLE.exec(input);
  if (bsky) return tryUrl(`https://bsky.app/profile/${bsky[1].toLowerCase()}`) ?? { type: "empty" };

  const yt = YT_HANDLE.exec(input);
  if (yt) return tryUrl(`https://www.youtube.com/@${yt[1]}`) ?? { type: "empty" };

  if (!/\s/.test(input) && BARE_HOST_PATH.test(input)) {
    // "next.js" / "main.py" are topics, not hosts.
    const hasPath = /[/?#]/.test(input);
    const tld = input.split(/[/?#:]/)[0].split(".").pop() ?? "";
    if (hasPath || !FILE_LIKE_TLDS.has(tld.toLowerCase())) {
      const parsed = tryUrl(`https://${input}`);
      if (parsed) return parsed;
    }
  }

  return { type: "topic", query: input.replace(/\s+/g, " ").slice(0, 200) };
}

/* -------------------------------------------------------------------------- */
/* Platform tables                                                             */
/* -------------------------------------------------------------------------- */

type RouteCtx = { url: URL; host: string; path: string; m: RegExpExecArray };
type Built = { feeds?: ResolvedFeed[]; lookup?: Lookup };
type Route = { path: RegExp; build: (c: RouteCtx) => Built | null };
type PlatformResolver = {
  id: string;
  matchHost: (host: string) => boolean;
  routes: Route[];
};

const hostIs = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
const hostIn = (...domains: string[]) => (host: string) => domains.some((d) => hostIs(host, d));
const normalizeHost = (h: string) => h.toLowerCase().replace(/^www\./, "");

const YT_CHANNEL_ID = "UC[\\w-]{22}";
const YT_PLAYLIST_OK = /^(?:PL|UU|OL|FL)[\w-]{10,}$/;

function youtubeVideoLookup(id: string): Built {
  return {
    lookup: {
      type: "youtube-page",
      url: `https://www.youtube.com/watch?v=${enc(id)}`,
      fallbackTitle: "channel of this video",
    },
  };
}

function youtubeChannelFeeds(channelId: string, subject: string, confidence = 0.95): ResolvedFeed[] {
  return [
    feed("youtube", "videos", `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, subject, confidence, {
      format: "atom",
    }),
  ];
}

const YOUTUBE: PlatformResolver = {
  id: "youtube",
  matchHost: hostIn("youtube.com", "youtu.be", "youtube-nocookie.com"),
  routes: [
    // youtu.be/<id> short links
    {
      path: /^\/([\w-]{11})$/,
      build: (c) => (c.host === "youtu.be" ? youtubeVideoLookup(c.m[1]) : null),
    },
    {
      path: new RegExp(`^/channel/(${YT_CHANNEL_ID})(?:/.*)?$`),
      build: (c) => ({ feeds: youtubeChannelFeeds(c.m[1], c.m[1]) }),
    },
    {
      // Handles: 3–30 chars today, but legacy 1–2 char handles (`@EA`) and
      // percent-encoded non-ASCII handles exist too.
      path: /^\/@((?:[\w.-]|%[0-9A-Fa-f]{2}){1,100})(?:\/.*)?$/,
      build: (c) => ({
        lookup: { type: "youtube-page", url: `https://www.youtube.com/@${c.m[1]}`, fallbackTitle: `@${safeDecode(c.m[1])}` },
      }),
    },
    {
      path: /^\/(?:c|user)\/([\w.%-]{1,100})(?:\/.*)?$/,
      build: (c) => ({
        lookup: {
          type: "youtube-page",
          url: `https://www.youtube.com/${c.path.startsWith("/c/") ? "c" : "user"}/${c.m[1]}`,
          fallbackTitle: safeDecode(c.m[1]),
        },
      }),
    },
    {
      path: /^\/playlist\/?$/,
      build: (c) => {
        const list = c.url.searchParams.get("list") ?? "";
        if (!YT_PLAYLIST_OK.test(list)) return null;
        return {
          feeds: [
            feed("youtube", "playlist", `https://www.youtube.com/feeds/videos.xml?playlist_id=${enc(list)}`, list, 0.9, {
              format: "atom",
            }),
          ],
        };
      },
    },
    {
      path: /^\/watch\/?$/,
      build: (c) => {
        const v = c.url.searchParams.get("v") ?? "";
        if (!/^[\w-]{11}$/.test(v)) return null;
        const built = youtubeVideoLookup(v);
        const list = c.url.searchParams.get("list") ?? "";
        if (YT_PLAYLIST_OK.test(list)) {
          built.feeds = [
            feed("youtube", "playlist", `https://www.youtube.com/feeds/videos.xml?playlist_id=${enc(list)}`, list, 0.7, {
              format: "atom",
            }),
          ];
        }
        return built;
      },
    },
    {
      path: /^\/(?:shorts|live|embed)\/([\w-]{11})\/?$/,
      build: (c) => youtubeVideoLookup(c.m[1]),
    },
  ],
};

const REDDIT_SORT = new Set(["hot", "new", "top", "rising", "controversial"]);

const REDDIT: PlatformResolver = {
  id: "reddit",
  matchHost: hostIn("reddit.com"),
  routes: [
    {
      // /search?q=…  — site-wide search
      path: /^\/search\/?$/,
      build: (c) => {
        const q = c.url.searchParams.get("q")?.trim();
        if (!q) return null;
        return {
          feeds: [feed("reddit", "search", `https://www.reddit.com/search.rss?q=${enc(q)}&sort=new`, `“${q}”`, 0.9, { format: "atom" })],
        };
      },
    },
    {
      // /r/<sub>/search?q=…
      path: /^\/r\/([\w+-]{2,100})\/search\/?$/,
      build: (c) => {
        const q = c.url.searchParams.get("q")?.trim();
        if (!q) return null;
        return {
          feeds: [
            feed(
              "reddit",
              "search",
              `https://www.reddit.com/r/${c.m[1]}/search.rss?q=${enc(q)}&restrict_sr=on&sort=new`,
              `r/${c.m[1]}: “${q}”`,
              0.9,
              { format: "atom" },
            ),
          ],
        };
      },
    },
    {
      // /r/<sub>/comments/<id>/…  — comment thread + the subreddit
      path: /^\/r\/([\w+-]{2,100})\/comments\/([a-z0-9]{5,10})(?:\/.*)?$/i,
      build: (c) => ({
        feeds: [
          feed("reddit", "comments", `https://www.reddit.com/r/${c.m[1]}/comments/${c.m[2]}/.rss`, `thread in r/${c.m[1]}`, 0.9, {
            format: "atom",
          }),
          feed("reddit", "hot", `https://www.reddit.com/r/${c.m[1]}/.rss`, `r/${c.m[1]}`, 0.8, { format: "atom" }),
        ],
      }),
    },
    {
      // /r/<sub>[/<sort>]  — multi-subreddits use `a+b`
      path: /^\/r\/([\w+-]{2,100})(?:\/([a-z]+))?\/?$/i,
      build: (c) => {
        const sub = c.m[1];
        const sort = (c.m[2] ?? "").toLowerCase();
        if (sort && !REDDIT_SORT.has(sort)) return null;
        return {
          feeds: [
            feed("reddit", "hot", `https://www.reddit.com/r/${sub}/.rss`, `r/${sub}`, 0.95, { format: "atom" }),
            feed("reddit", "new", `https://www.reddit.com/r/${sub}/new/.rss`, `r/${sub}`, 0.85, { format: "atom" }),
            feed("reddit", "top", `https://www.reddit.com/r/${sub}/top/.rss?t=week`, `r/${sub} (week)`, 0.8, { format: "atom" }),
          ],
        };
      },
    },
    {
      // /user/<name>/m/<multi>  (multireddit)
      path: /^\/(?:user|u)\/([\w-]{3,20})\/m\/([\w-]{1,50})\/?$/,
      build: (c) => ({
        feeds: [
          feed("reddit", "posts", `https://www.reddit.com/user/${c.m[1]}/m/${c.m[2]}/.rss`, `multireddit ${c.m[2]} by u/${c.m[1]}`, 0.9, {
            format: "atom",
          }),
        ],
      }),
    },
    {
      // /user/<name>[/…]
      path: /^\/(?:user|u)\/([\w-]{3,20})(?:\/.*)?$/,
      build: (c) => ({
        feeds: [
          feed("reddit", "posts", `https://www.reddit.com/user/${c.m[1]}/.rss`, `u/${c.m[1]}`, 0.95, { format: "atom" }),
          feed("reddit", "posts", `https://www.reddit.com/user/${c.m[1]}/submitted/.rss`, `u/${c.m[1]} (posts only)`, 0.8, {
            format: "atom",
          }),
        ],
      }),
    },
  ],
};

// Hosts that expose `/@user` but are NOT Mastodon-compatible — never guess a
// fediverse feed for them.
const NON_FEDIVERSE = [
  "youtube.com", "medium.com", "tiktok.com", "substack.com", "threads.net", "threads.com", "instagram.com",
  "twitter.com", "x.com", "github.com", "gitlab.com", "reddit.com", "bsky.app", "letterboxd.com",
  "pinterest.com", "facebook.com", "tumblr.com", "soundcloud.com", "twitch.tv", "apple.com", "google.com",
];

const MASTODON: PlatformResolver = {
  id: "mastodon",
  matchHost: (host) => !NON_FEDIVERSE.some((d) => hostIs(host, d)),
  routes: [
    {
      // /@user (local) or /@user@other.host (remote profile seen from this server → ask the home server)
      path: /^\/@([\w.-]{1,60})(?:@([A-Za-z0-9.-]+\.[A-Za-z]{2,}))?(?:\/\d+)?\/?$/,
      build: (c) => {
        const home = (c.m[2] ?? c.url.host).toLowerCase();
        return {
          feeds: [
            feed("mastodon", "posts", `https://${home}/@${c.m[1]}.rss`, `@${c.m[1]}@${home}`, 0.6, { format: "rss", verify: true }),
          ],
        };
      },
    },
    {
      path: /^\/tags\/([^/\s]{1,100})\/?$/,
      build: (c) => ({
        feeds: [
          feed("mastodon", "tag", `https://${c.url.host}/tags/${c.m[1]}.rss`, `#${safeDecode(c.m[1])}`, 0.6, {
            format: "rss",
            verify: true,
          }),
        ],
      }),
    },
  ],
};

const BLUESKY: PlatformResolver = {
  id: "bluesky",
  matchHost: hostIn("bsky.app"),
  routes: [
    {
      path: /^\/profile\/([^/\s]{1,253})(?:\/post\/[\w]+)?\/?$/,
      build: (c) => ({
        feeds: [feed("bluesky", "posts", `https://bsky.app/profile/${c.m[1]}/rss`, `@${safeDecode(c.m[1])}`, 0.95, { format: "rss" })],
      }),
    },
  ],
};

const GITHUB_RESERVED = new Set([
  "about", "account", "apps", "collections", "contact", "customer-stories", "enterprise", "events", "explore",
  "features", "issues", "login", "logout", "marketplace", "new", "notifications", "orgs", "organizations",
  "pricing", "pulls", "search", "security", "sessions", "settings", "signup", "sponsors", "topics", "trending",
  "users", "codespaces", "copilot", "discussions", "gist", "readme", "resources", "solutions", "team", "premium-support",
]);

function githubRepoFeeds(base: string, owner: string, repo: string, branch: string | null): ResolvedFeed[] {
  const slug = `${owner}/${repo}`;
  const commitsUrl = branch ? `${base}/${owner}/${repo}/commits/${enc(branch)}.atom` : `${base}/${owner}/${repo}/commits.atom`;
  return [
    feed("github", "releases", `${base}/${owner}/${repo}/releases.atom`, slug, 0.95, { format: "atom" }),
    feed("github", "commits", commitsUrl, branch ? `${slug} (${branch})` : slug, 0.85, { format: "atom" }),
    feed("github", "tags", `${base}/${owner}/${repo}/tags.atom`, slug, 0.75, { format: "atom" }),
  ];
}

const GITHUB: PlatformResolver = {
  id: "github",
  matchHost: hostIn("github.com"),
  routes: [
    {
      path: /^\/([\w.-]{1,100})\/([\w.-]{1,100})(?:\/(.*))?$/,
      build: (c) => {
        const owner = c.m[1];
        if (GITHUB_RESERVED.has(owner.toLowerCase())) return null;
        const repo = c.m[2].replace(/\.git$/i, "");
        const rest = (c.m[3] ?? "").split("/").filter(Boolean);
        const branch = (rest[0] === "tree" || rest[0] === "commits") && rest.length === 2 ? rest[1].replace(/\.atom$/, "") : null;
        return { feeds: githubRepoFeeds("https://github.com", owner, repo, branch) };
      },
    },
    {
      path: /^\/([\w-]{1,39})\/?$/,
      build: (c) => {
        if (GITHUB_RESERVED.has(c.m[1].toLowerCase())) return null;
        return {
          feeds: [feed("github", "activity", `https://github.com/${c.m[1]}.atom`, `${c.m[1]} (public activity)`, 0.8, { format: "atom" })],
        };
      },
    },
  ],
};

const GITLAB_RESERVED = new Set([
  "explore", "users", "groups", "dashboard", "help", "admin", "api", "projects", "snippets", "search", "-", "oauth",
  "profile", "public", "uploads", "assets", "import", "jwt", "sitemap",
]);

const GITLAB: PlatformResolver = {
  id: "gitlab",
  matchHost: (host) => host === "gitlab.com" || host.startsWith("gitlab."),
  routes: [
    {
      path: /^\/(.+)$/,
      build: (c) => {
        const [before, after] = c.path.slice(1).split(/\/-(?:\/|$)/, 2);
        const projectSegs = before.split("/").filter(Boolean);
        if (!projectSegs.length || GITLAB_RESERVED.has(projectSegs[0].toLowerCase())) return null;
        const origin = `https://${c.url.host}`;
        if (projectSegs.length === 1 && after === undefined) {
          // A bare user (or top-level group) page.
          return { feeds: [feed("gitlab", "activity", `${origin}/${projectSegs[0]}.atom`, projectSegs[0], 0.6, { format: "atom", verify: true })] };
        }
        if (projectSegs.length < 2) return null;
        const project = projectSegs.join("/").replace(/\.git$/i, "");
        const restSegs = (after ?? "").split("/").filter(Boolean);
        const branch = (restSegs[0] === "tree" || restSegs[0] === "commits") && restSegs.length === 2 ? restSegs[1] : "HEAD";
        return {
          feeds: [
            feed("gitlab", "tags", `${origin}/${project}/-/tags?format=atom`, project, 0.9, { format: "atom" }),
            feed("gitlab", "commits", `${origin}/${project}/-/commits/${enc(branch)}?format=atom`, branch === "HEAD" ? project : `${project} (${branch})`, 0.85, {
              format: "atom",
            }),
            feed("gitlab", "activity", `${origin}/${project}.atom`, `${project} (activity)`, 0.7, { format: "atom" }),
          ],
        };
      },
    },
  ],
};

const ARXIV_CAT = "[A-Za-z][A-Za-z-]*(?:\\.[A-Za-z-]+)?";

const ARXIV: PlatformResolver = {
  id: "arxiv",
  matchHost: hostIn("arxiv.org"),
  routes: [
    {
      path: new RegExp(`^/list/(${ARXIV_CAT})(?:/.*)?$`),
      build: (c) => ({
        feeds: [
          feed("arxiv", "new", `https://rss.arxiv.org/rss/${c.m[1]}`, c.m[1], 0.95, { format: "rss" }),
          feed("arxiv", "new", `https://rss.arxiv.org/atom/${c.m[1]}`, `${c.m[1]} (Atom)`, 0.8, { format: "atom" }),
        ],
      }),
    },
    {
      path: /^\/search\/?$/,
      build: (c) => {
        const q = c.url.searchParams.get("query")?.trim();
        if (!q) return null;
        return { feeds: [arxivQueryFeed(q, 0.9)] };
      },
    },
  ],
};

function arxivQueryFeed(query: string, confidence: number): ResolvedFeed {
  const tokens = query.match(/"[^"]+"|\S+/g) ?? [query];
  const search = tokens.map((t) => `all:${enc(t)}`).join("+AND+");
  return feed(
    "arxiv",
    "search",
    `https://export.arxiv.org/api/query?search_query=${search}&sortBy=submittedDate&sortOrder=descending&max_results=50`,
    `“${query}”`,
    confidence,
    { format: "atom" },
  );
}

const SUBSTACK_SKIP = new Set(["www", "open", "api", "support", "on", "reader", "substackcdn", "cdn"]);

const SUBSTACK: PlatformResolver = {
  id: "substack",
  matchHost: hostIn("substack.com"),
  routes: [
    {
      path: /^\/pub\/([a-z0-9-]+)(?:\/.*)?$/i,
      build: (c) =>
        c.host === "open.substack.com"
          ? { feeds: [feed("substack", "posts", `https://${c.m[1].toLowerCase()}.substack.com/feed`, c.m[1], 0.95, { format: "rss" })] }
          : null,
    },
    {
      path: /^(?:\/.*)?$/,
      build: (c) => {
        const sub = c.host.replace(/\.substack\.com$/, "");
        if (c.host === sub || sub.includes(".") || SUBSTACK_SKIP.has(sub)) return null;
        return { feeds: [feed("substack", "posts", `https://${sub}.substack.com/feed`, sub, 0.95, { format: "rss" })] };
      },
    },
  ],
};

const MEDIUM_RESERVED = new Set([
  "m", "me", "tag", "topics", "search", "plans", "about", "jobs", "policy", "creators", "membership", "new-story",
  "p", "feed", "partner-program", "business", "tag", "browse", "help", "_", "notifications", "lists", "library",
]);

const MEDIUM: PlatformResolver = {
  id: "medium",
  matchHost: hostIn("medium.com"),
  routes: [
    {
      path: /^\/tag\/([\w-]{1,100})(?:\/.*)?$/,
      build: (c) =>
        c.host === "medium.com" ? { feeds: [feed("medium", "tag", `https://medium.com/feed/tag/${c.m[1]}`, `#${c.m[1]}`, 0.95, { format: "rss" })] } : null,
    },
    {
      path: /^\/(@[\w.-]{1,100})(?:\/.*)?$/,
      build: (c) =>
        c.host === "medium.com" ? { feeds: [feed("medium", "posts", `https://medium.com/feed/${c.m[1]}`, c.m[1], 0.95, { format: "rss" })] } : null,
    },
    {
      // https://medium.com/<publication>[/…]
      path: /^\/([\w-]{1,100})(?:\/.*)?$/,
      build: (c) => {
        if (c.host === "medium.com") {
          if (MEDIUM_RESERVED.has(c.m[1].toLowerCase())) return null;
          return { feeds: [feed("medium", "posts", `https://medium.com/feed/${c.m[1]}`, c.m[1], 0.85, { format: "rss" })] };
        }
        // https://<user-or-publication>.medium.com/…
        const sub = c.host.replace(/\.medium\.com$/, "");
        if (sub === c.host || sub.includes(".") || sub === "cdn-images-1") return null;
        return { feeds: [feed("medium", "posts", `https://${c.host}/feed`, sub, 0.9, { format: "rss" })] };
      },
    },
    {
      path: /^\/?$/,
      build: (c) => {
        const sub = c.host.replace(/\.medium\.com$/, "");
        if (c.host === "medium.com" || sub.includes(".")) return null;
        return { feeds: [feed("medium", "posts", `https://${c.host}/feed`, sub, 0.9, { format: "rss" })] };
      },
    },
  ],
};

const HACKERNEWS: PlatformResolver = {
  id: "hackernews",
  matchHost: hostIn("news.ycombinator.com"),
  routes: [
    {
      path: /^\/(?:news)?\/?$/,
      build: () => ({
        feeds: [
          feed("hackernews", "stories", "https://hnrss.org/frontpage", "front page", 0.95, { format: "rss" }),
          feed("hackernews", "top", "https://hnrss.org/frontpage?points=100", "front page (100+ points)", 0.8, { format: "rss" }),
          feed("hackernews", "top", "https://hnrss.org/best", "best", 0.7, { format: "rss" }),
        ],
      }),
    },
    {
      path: /^\/(newest|ask|show|jobs|best)\/?$/,
      build: (c) => {
        const map: Record<string, string> = { newest: "newest", ask: "ask", show: "show", jobs: "jobs", best: "best" };
        const label = c.m[1] === "newest" ? "newest" : c.m[1] === "jobs" ? "jobs" : c.m[1] === "best" ? "best" : c.m[1] === "ask" ? "Ask HN" : "Show HN";
        const feeds = [feed("hackernews", "stories", `https://hnrss.org/${map[c.m[1]]}`, label, 0.95, { format: "rss" })];
        if (c.m[1] === "newest") {
          feeds.push(feed("hackernews", "top", "https://hnrss.org/newest?points=100", "newest (100+ points)", 0.8, { format: "rss" }));
        }
        return { feeds };
      },
    },
    {
      path: /^\/(?:user|submitted)\/?$/,
      build: (c) => {
        const id = c.url.searchParams.get("id");
        if (!id || !/^[\w-]{2,15}$/.test(id)) return null;
        return {
          feeds: [
            feed("hackernews", "posts", `https://hnrss.org/submitted?id=${id}`, `submissions by ${id}`, 0.9, { format: "rss" }),
            feed("hackernews", "comments", `https://hnrss.org/threads?id=${id}`, `threads of ${id}`, 0.7, { format: "rss" }),
          ],
        };
      },
    },
    {
      path: /^\/item\/?$/,
      build: (c) => {
        const id = c.url.searchParams.get("id");
        if (!id || !/^\d{1,10}$/.test(id)) return null;
        return { feeds: [feed("hackernews", "comments", `https://hnrss.org/item?id=${id}`, `comments on #${id}`, 0.9, { format: "rss" })] };
      },
    },
    {
      path: /^\/from\/?$/,
      build: (c) => {
        const site = c.url.searchParams.get("site");
        if (!site || !/^[a-z0-9.-]+$/i.test(site)) return null;
        return { feeds: [feed("hackernews", "stories", `https://hnrss.org/newest?link=${enc(site)}`, `stories from ${site}`, 0.85, { format: "rss" })] };
      },
    },
  ],
};

const LOBSTERS: PlatformResolver = {
  id: "lobsters",
  matchHost: hostIn("lobste.rs"),
  routes: [
    {
      path: /^\/(?:hottest)?\/?$/,
      build: () => ({
        feeds: [
          feed("lobsters", "stories", "https://lobste.rs/rss", "hottest", 0.95, { format: "rss" }),
          feed("lobsters", "new", "https://lobste.rs/newest.rss", "newest", 0.85, { format: "rss" }),
        ],
      }),
    },
    {
      path: /^\/newest\/?$/,
      build: () => ({ feeds: [feed("lobsters", "new", "https://lobste.rs/newest.rss", "newest", 0.95, { format: "rss" })] }),
    },
    {
      path: /^\/comments\/?$/,
      build: () => ({ feeds: [feed("lobsters", "comments", "https://lobste.rs/comments.rss", "comments", 0.95, { format: "rss" })] }),
    },
    {
      path: /^\/t\/([\w+.-]{1,100})\/?$/,
      build: (c) => ({ feeds: [feed("lobsters", "tag", `https://lobste.rs/t/${c.m[1]}.rss`, `#${c.m[1]}`, 0.95, { format: "rss" })] }),
    },
    {
      path: /^\/~([\w-]{1,50})(?:\/.*)?$/,
      build: (c) => ({ feeds: [feed("lobsters", "stories", `https://lobste.rs/~${c.m[1]}/stories.rss`, `~${c.m[1]}`, 0.9, { format: "rss" })] }),
    },
  ],
};

const APPLE_PODCASTS: PlatformResolver = {
  id: "apple-podcasts",
  matchHost: hostIn("podcasts.apple.com", "itunes.apple.com"),
  routes: [
    {
      path: /^\/(?:([a-z]{2})\/)?podcast\/(?:[^/]+\/)?id(\d{4,12})\/?$/i,
      build: (c) => ({ lookup: { type: "itunes", id: c.m[2], country: c.m[1] ? c.m[1].toLowerCase() : null } }),
    },
  ],
};

const STEAM: PlatformResolver = {
  id: "steam",
  matchHost: hostIn("store.steampowered.com", "steamcommunity.com"),
  routes: [
    {
      path: /^\/(?:news\/)?app\/(\d{1,9})(?:\/.*)?$/,
      build: (c) => ({
        feeds: [feed("steam", "news", `https://store.steampowered.com/feeds/news/app/${c.m[1]}/`, `app ${c.m[1]}`, 0.95, { format: "rss" })],
      }),
    },
  ],
};

const LETTERBOXD_RESERVED = new Set([
  "film", "films", "lists", "members", "journal", "reviews", "news", "pro", "settings", "about", "search", "sign-in",
  "create-account", "activity", "apps", "api", "contact", "podcast", "podcasts", "tag", "festivals", "stats", "welcome",
]);

const LETTERBOXD: PlatformResolver = {
  id: "letterboxd",
  matchHost: hostIn("letterboxd.com"),
  routes: [
    {
      path: /^\/([\w-]{2,40})(?:\/.*)?$/,
      build: (c) => {
        if (LETTERBOXD_RESERVED.has(c.m[1].toLowerCase())) return null;
        return {
          feeds: [feed("letterboxd", "diary", `https://letterboxd.com/${c.m[1]}/rss/`, `${c.m[1]} (diary & reviews)`, 0.95, { format: "rss" })],
        };
      },
    },
  ],
};

// Order matters only for hosts claimed by more than one table; the fediverse
// guess is last because it matches any host that isn't a known non-fediverse one.
const RESOLVERS: PlatformResolver[] = [
  YOUTUBE, REDDIT, BLUESKY, GITHUB, GITLAB, ARXIV, SUBSTACK, MEDIUM, HACKERNEWS, LOBSTERS, APPLE_PODCASTS, STEAM,
  LETTERBOXD, MASTODON,
];

/**
 * Pure, synchronous rule matching for a URL. Returns the direct feed
 * candidates plus any one-step lookups the caller still has to run.
 */
export function matchUrl(url: URL): SourceMatch {
  const pubFeeds = resolvePublisherFeeds(url);
  if (pubFeeds.length) {
    return { feeds: pubFeeds, lookups: [], matched: true };
  }

  const host = url.hostname.toLowerCase();
  const normalized = host.replace(/^(www|m|old|new|np|mobile)\./, "");
  const path = url.pathname.replace(/\/{2,}/g, "/");
  const feeds: ResolvedFeed[] = [];
  const lookups: Lookup[] = [];
  let matched = false;

  for (const resolver of RESOLVERS) {
    if (!resolver.matchHost(normalized)) continue;
    for (const route of resolver.routes) {
      const m = route.path.exec(path);
      if (!m) continue;
      const built = route.build({ url, host: normalized, path, m });
      if (!built) continue;
      matched = true;
      if (built.feeds) feeds.push(...built.feeds);
      if (built.lookup) lookups.push(built.lookup);
      break; // first matching route per platform
    }
    if (matched) break; // first matching platform wins
  }

  return { feeds: dedupe(feeds), lookups, matched };
}

/** `matchUrl` over raw input (URL, scheme-less URL, or handle). Topic phrases never match. */
export function matchSource(raw: string): SourceMatch {
  const parsed = parseSourceInput(raw);
  if (parsed.type !== "url") return { feeds: [], lookups: [], matched: false };
  return matchUrl(parsed.url);
}

function dedupe(feeds: ResolvedFeed[]): ResolvedFeed[] {
  const seen = new Set<string>();
  const out: ResolvedFeed[] = [];
  for (const f of feeds) {
    if (seen.has(f.url)) continue;
    seen.add(f.url);
    out.push(f);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* One-step lookups                                                            */
/* -------------------------------------------------------------------------- */

const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();

/** Extracts a YouTube channel id (and a display name) from a channel or watch page. */
export function parseYoutubePage(html: string): { channelId: string; title: string | null } | null {
  const idRe = new RegExp(YT_CHANNEL_ID);
  let channelId: string | null = null;

  // `[^<>]` stops at the next tag start, so a page of unterminated `<meta `
  // stays linear (an unbounded `[^>]*` here was quadratic on 1–4 MB pages).
  const tags = html.match(/<(?:link|meta)\b[^<>]{0,4000}>/gi) ?? [];
  for (const tag of tags) {
    if (/itemprop=["'](?:channelId|identifier)["']/i.test(tag)) {
      const c = /content=["'](UC[\w-]{22})["']/i.exec(tag);
      if (c) {
        channelId = c[1];
        break;
      }
    }
  }
  if (!channelId) {
    for (const tag of tags) {
      if (!/^<link\b/i.test(tag)) continue;
      const rss = /feeds\/videos\.xml\?channel_id=(UC[\w-]{22})/i.exec(tag);
      if (rss) {
        channelId = rss[1];
        break;
      }
      if (/rel=["']canonical["']/i.test(tag)) {
        const canon = /youtube\.com\/channel\/(UC[\w-]{22})/i.exec(tag);
        if (canon) {
          channelId = canon[1];
          break;
        }
      }
    }
  }
  if (!channelId) {
    // og:url / twitter:url carry the canonical /channel/UC… address too.
    for (const tag of tags) {
      if (!/^<meta\b/i.test(tag) || !/(?:property|name)=["'](?:og:url|twitter:url)["']/i.test(tag)) continue;
      const og = /youtube\.com\/channel\/(UC[\w-]{22})/i.exec(tag);
      if (og) {
        channelId = og[1];
        break;
      }
    }
  }
  if (!channelId) {
    const json = /"(?:externalId|channelId)"\s{0,8}:\s{0,8}"(UC[\w-]{22})"/.exec(html);
    if (json) channelId = json[1];
  }
  if (!channelId || !idRe.test(channelId)) return null;

  const contentOf = (tag: string) => /content=["']([^"']{1,200})["']/i.exec(tag)?.[1] ?? null;
  const author = tags.find((t) => /^<link\b/i.test(t) && /itemprop=["']name["']/i.test(t));
  const og = tags.find((t) => /^<meta\b/i.test(t) && /property=["']og:title["']/i.test(t));
  const rawTitle = (author && contentOf(author)) ?? (og && contentOf(og)) ?? null;
  return { channelId, title: rawTitle ? decodeEntities(rawTitle) : null };
}

async function runLookup(lookup: Lookup, deps: ResolverDeps): Promise<ResolvedFeed[]> {
  if (lookup.type === "youtube-page") {
    // `SOCS=CAI` is the consent-accepted cookie; without it EU requests are
    // redirected to consent.youtube.com, which has no channel markup.
    const html = await deps.fetchText(lookup.url, {
      headers: { "Accept-Language": "en-US,en;q=0.9", Cookie: "SOCS=CAI" },
    });
    const page = parseYoutubePage(html);
    if (!page) return [];
    return youtubeChannelFeeds(page.channelId, page.title ?? lookup.fallbackTitle, 0.9);
  }

  if (lookup.type === "itunes") {
    const params = new URLSearchParams({ id: lookup.id, entity: "podcast" });
    if (lookup.country) params.set("country", lookup.country);
    const body = await deps.fetchText(`https://itunes.apple.com/lookup?${params}`);
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      return [];
    }
    const results = (data as { results?: unknown })?.results;
    if (!Array.isArray(results)) return [];
    const hit = results.find((r) => r && typeof (r as { feedUrl?: unknown }).feedUrl === "string") as
      | { feedUrl: string; collectionName?: string; trackName?: string }
      | undefined;
    if (!hit || !/^https?:\/\//i.test(hit.feedUrl)) return [];
    return [feed("apple-podcasts", "podcast", hit.feedUrl, hit.collectionName ?? hit.trackName ?? `id${lookup.id}`, 0.95, { format: "rss" })];
  }

  return [];
}

/**
 * Full deterministic resolution: rule match + one-step lookups. Lookup
 * failures are swallowed (the caller falls through to scraping); never throws.
 */
export async function resolveSource(raw: string, deps: ResolverDeps): Promise<{ matched: boolean; feeds: ResolvedFeed[] }> {
  const match = matchSource(raw);
  if (!match.matched) return { matched: false, feeds: [] };
  const looked = await Promise.all(match.lookups.map((l) => runLookup(l, deps).catch(() => [] as ResolvedFeed[])));
  return { matched: true, feeds: dedupe([...looked.flat(), ...match.feeds]) };
}

/* -------------------------------------------------------------------------- */
/* Topic → feed                                                                */
/* -------------------------------------------------------------------------- */

const DEFAULT_REGION: Record<string, string> = {
  en: "US", de: "DE", fr: "FR", es: "ES", it: "IT", nl: "NL", pt: "BR", pl: "PL", sv: "SE", ja: "JP", tr: "TR",
};

/** Maps a UI locale ("de", "en-GB", "pt_BR") onto Google News' hl/gl/ceid triple. */
export function googleNewsLocale(locale?: string | null): { hl: string; gl: string; ceid: string } {
  const [langRaw, regionRaw] = (locale ?? "en").replace("_", "-").split("-");
  const lang = /^[a-z]{2,3}$/i.test(langRaw ?? "") ? langRaw.toLowerCase() : "en";
  const region = /^[a-z]{2}$/i.test(regionRaw ?? "") ? regionRaw.toUpperCase() : DEFAULT_REGION[lang] ?? "US";
  return { hl: lang === "en" ? `en-${region}` : lang, gl: region, ceid: `${region}:${lang}` };
}

/**
 * Search-engine style feeds for a plain topic phrase. The user picks one, so
 * every engine is offered (none verified: they are live search endpoints).
 */
export function buildTopicFeeds(query: string, opts: { locale?: string | null } = {}): ResolvedFeed[] {
  const q = query.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!q) return [];
  const { hl, gl, ceid } = googleNewsLocale(opts.locale);
  const label = `“${q}”`;
  return [
    feed("google-news", "topic", `https://news.google.com/rss/search?q=${enc(q)}&hl=${hl}&gl=${gl}&ceid=${enc(ceid)}`, label, 0.9, { format: "rss" }),
    feed("bing-news", "topic", `https://www.bing.com/news/search?q=${enc(q)}&format=rss`, label, 0.8, { format: "rss" }),
    feed("hackernews", "search", `https://hnrss.org/newest?q=${enc(q)}`, label, 0.7, { format: "rss" }),
    arxivQueryFeed(q, 0.6),
  ];
}
