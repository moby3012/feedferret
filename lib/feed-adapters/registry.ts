// Platform & software feed adapters — the declarative registry.
//
// Owner principle: NO per-site hacks. Every entry here describes a PLATFORM
// (one service with its own URL scheme, e.g. ModDB/IndieDB, Steam community)
// or a piece of SOFTWARE that thousands of independent sites run (Discourse,
// phpBB, WordPress, …). An entry maps "what the URL / page looks like" onto
// the feed endpoints that platform or software publishes natively.
//
// Resolution order in discovery (lib/feed-discovery.ts):
//   a) URL-pattern platform rules — lib/smart-url-resolver.ts (YouTube, Reddit,
//      GitHub, GitLab, Steam store, Mastodon, Bluesky, Substack, Medium, …; the
//      ones that need a one-step lookup) + PLATFORM_ADAPTERS below
//   b) software detection on the fetched page (generator meta, HTML
//      fingerprints, response headers) → SOFTWARE_ADAPTERS below
//   c) every candidate from (a: PLATFORM_ADAPTERS) and (b) is fetch-verified
//      with the 64 KiB prefix sniff before it is offered — a wrong guess costs
//      one bounded request and is never shown
//   d) RSSHub radar routes (lib/rsshub-radar-rules.ts) for platforms without a
//      native feed, only when an RSSHub instance is configured; otherwise the
//      UI says "Braucht RSSHub" (RSSHUB_ONLY_PLATFORMS names the platform)
//   e) otherwise the page's own feeds / common paths, then page-feed scraping
//      or changedetection (separate flows)
//
// Template syntax (feed `url`):
//   {origin}   page origin, e.g. https://forum.example.org
//   {base}     origin + the software's install path (no trailing slash),
//              e.g. https://example.org/community  (see `base` below)
//   {domain}   the page host without a leading "www." (platform adapters)
//   {$1}…{$9}  capture groups of the matching route pattern
//   {?name}    value of query parameter `name`; the template is skipped when
//              the parameter is missing or not a plain token
//
// Route patterns run against the path RELATIVE to the install base (always
// starting with "/"), first match wins; `site` feeds are offered in addition.
// Each entry has fixture tests in tests/lib/feed-adapters.test.ts (a guard
// test fails when an entry has none).

// API-backed synthetic sources are registered in api-source-url.ts; their
// providers return FetchedFeed through api-platform-source.ts (no RSS probe).
export { API_PLATFORM_SOURCES } from "./api-source-url";

import type { FeedKind } from "../smart-url-resolver";

export type AdapterFamily = "platform" | "forum" | "blog" | "wiki";

export type FeedTemplate = {
  url: string;
  kind: FeedKind;
  /** Short subject for the candidate title ("latest topics", "category"). */
  label: string;
};

export type AdapterRoute = { pattern: RegExp; feeds: FeedTemplate[] };

export type PlatformAdapter = {
  id: string;
  /** Display name, shown as "<name>-Feed" in the UI. */
  name: string;
  family: AdapterFamily;
  /** Registrable domains (subdomains included, leading "www." ignored). */
  hosts: string[];
  routes: AdapterRoute[];
};

export type SoftwareAdapter = {
  id: string;
  name: string;
  family: AdapterFamily;
  /**
   * Any one signal identifies the software. Signals are evaluated on the
   * PARSED page (lib/feed-adapters/engine.ts) — never regexes over raw HTML,
   * which an attacker-controlled page could turn into catastrophic
   * backtracking.
   */
  detect: {
    /** Tested against each `<meta name="generator">` content (capped at 200 chars). */
    generator?: RegExp;
    /** CSS selectors; any match identifies the software. */
    selectors?: string[];
    /** Plain substrings of inline `<script>` text (first 64 KiB of all inline scripts). */
    scriptIncludes?: string[];
    /** Response headers (lower-case name → value pattern; header value capped at 200 chars). */
    headers?: Record<string, RegExp>;
  };
  /** Install path of the software on its host (forums often live in /forum/). */
  base?: {
    /** Element attributes holding the install root (absolute URL or path); `stripSuffix` is cut off the path. */
    attrs?: Array<{ selector: string; attr: string; stripSuffix?: string }>;
    /**
     * Inline-script patterns (capture group 1 = install root, JSON `\/` escapes
     * allowed). Must start with a literal and use bounded quantifiers only —
     * the guard test in tests/lib/feed-adapters.test.ts enforces linear time.
     */
    script?: RegExp[];
    /** Path segments the software's own routes start with; everything before the first one is the base. */
    before?: string[];
    /** Neither signal matched: "dir" = the page's directory (forums), default = site root. */
    fallback?: "dir";
  };
  routes: AdapterRoute[];
  /** Site-wide feeds, offered after the route-specific ones. */
  site: FeedTemplate[];
};

/* -------------------------------------------------------------------------- */
/* (a) URL-pattern platform adapters (complementing smart-url-resolver.ts)     */
/* -------------------------------------------------------------------------- */

export const PLATFORM_ADAPTERS: PlatformAdapter[] = [
  {
    // ModDB and IndieDB run the same engine; the main sites answer bots with
    // 403, the separate rss.<domain> host serves the feeds.
    id: "dbolical",
    name: "ModDB/IndieDB",
    family: "platform",
    hosts: ["moddb.com", "indiedb.com"],
    routes: [
      {
        pattern: /^\/(games|mods|engines|groups|company|members)\/([\w-]+)\/downloads(?:\/.*)?$/,
        feeds: [
          { url: "https://rss.{domain}/{$1}/{$2}/downloads/feed/rss.xml", kind: "downloads", label: "downloads" },
          { url: "https://rss.{domain}/{$1}/{$2}/articles/feed/rss.xml", kind: "news", label: "news" },
        ],
      },
      {
        pattern: /^\/(games|mods|engines|groups|company|members)\/([\w-]+)(?:\/.*)?$/,
        feeds: [
          { url: "https://rss.{domain}/{$1}/{$2}/articles/feed/rss.xml", kind: "news", label: "news" },
          { url: "https://rss.{domain}/{$1}/{$2}/downloads/feed/rss.xml", kind: "downloads", label: "downloads" },
        ],
      },
      {
        pattern: /^\/(?:news|articles|features)?\/?$/,
        feeds: [{ url: "https://rss.{domain}/news/feed/rss.xml", kind: "news", label: "news" }],
      },
      {
        pattern: /^\/downloads\/?$/,
        feeds: [{ url: "https://rss.{domain}/downloads/feed/rss.xml", kind: "downloads", label: "downloads" }],
      },
    ],
  },
  {
    // Per-game "new / updated mods" feeds. The whole site (feeds included) is
    // often behind a bot wall; the verify step then drops them silently.
    id: "nexusmods",
    name: "Nexus Mods",
    family: "platform",
    hosts: ["nexusmods.com"],
    routes: [
      {
        // First segment is a game domain name, except the site's own sections.
        pattern:
          /^\/(?:games\/)?(?!(?:users|games|about|news|mods|login|logout|register|search|premium|account|settings|support|help|contact|privacy|terms|rss|api|images|content|collections|media|members|messages|notifications|newsletter|careers|authors|discord|wiki|forums|docs)(?:\/|$))([\w-]+)(?:\/.*)?$/,
        feeds: [
          { url: "https://www.nexusmods.com/{$1}/rss/newtoday/", kind: "new", label: "new mods" },
          { url: "https://www.nexusmods.com/{$1}/rss/updatedtoday/", kind: "releases", label: "updated mods" },
        ],
      },
    ],
  },
  {
    // Community side of Steam (the store / app hub routes live in
    // smart-url-resolver.ts): groups and per-game announcement hubs.
    id: "steam-community",
    name: "Steam",
    family: "platform",
    hosts: ["steamcommunity.com"],
    routes: [
      {
        pattern: /^\/groups\/([\w.-]+)(?:\/.*)?$/,
        feeds: [{ url: "https://steamcommunity.com/groups/{$1}/rss/", kind: "announcements", label: "group announcements" }],
      },
      {
        pattern: /^\/games\/(\w+)(?:\/.*)?$/,
        feeds: [{ url: "https://steamcommunity.com/games/{$1}/rss/", kind: "announcements", label: "announcements" }],
      },
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* (b) Software adapters — detected on the fetched page                        */
/* -------------------------------------------------------------------------- */

export const SOFTWARE_ADAPTERS: SoftwareAdapter[] = [
  {
    // Every Discourse page has a `.rss` twin (incl. Blizzard's forums and
    // their blue-post tracker group).
    id: "discourse",
    name: "Discourse",
    family: "forum",
    detect: {
      generator: /^Discourse\b/i,
      selectors: ["meta#data-discourse-setup", 'meta[name="discourse_theme_id"]'],
    },
    base: {
      fallback: "dir",
      attrs: [{ selector: "meta#data-discourse-setup[data-base-uri]", attr: "data-base-uri" }],
      before: ["c", "t", "u", "g", "groups", "tag", "tags", "latest", "top", "new", "hot", "posts", "categories", "badges"],
    },
    routes: [
      { pattern: /^\/t\/([^/]+)\/(\d+)(?:\/\d+)?\/?$/, feeds: [{ url: "{base}/t/{$1}/{$2}.rss", kind: "thread", label: "topic" }] },
      { pattern: /^\/c\/(.+?)\/?$/, feeds: [{ url: "{base}/c/{$1}.rss", kind: "category", label: "category" }] },
      { pattern: /^\/tags?\/([^/]+)\/?$/, feeds: [{ url: "{base}/tag/{$1}.rss", kind: "tag", label: "tag" }] },
      { pattern: /^\/u\/([^/]+)(?:\/.*)?$/, feeds: [{ url: "{base}/u/{$1}/activity.rss", kind: "activity", label: "user activity" }] },
      { pattern: /^\/g(?:roups)?\/([^/]+)(?:\/.*)?$/, feeds: [{ url: "{base}/groups/{$1}/posts.rss", kind: "posts", label: "group posts" }] },
      { pattern: /^\/(top|posts)\/?$/, feeds: [{ url: "{base}/{$1}.rss", kind: "top", label: "{$1}" }] },
    ],
    site: [{ url: "{base}/latest.rss", kind: "latest", label: "latest topics" }],
  },
  {
    // phpBB 3.1+ (`app.php/feed`) and 3.0 (`feed.php`); feeds can be disabled by the board.
    id: "phpbb",
    name: "phpBB",
    family: "forum",
    detect: {
      generator: /phpBB/i,
      selectors: ['a[href*="viewforum.php?f="]', 'a[href*="viewtopic.php?t="]', 'a[href*="ucp.php?mode=login"]', "body#phpbb"],
    },
    base: { fallback: "dir" },
    routes: [
      {
        pattern: /^\/viewforum\.php$/,
        feeds: [
          { url: "{base}/app.php/feed/forum/{?f}", kind: "category", label: "forum" },
          { url: "{base}/feed.php?f={?f}", kind: "category", label: "forum" },
        ],
      },
      {
        pattern: /^\/viewtopic\.php$/,
        feeds: [
          { url: "{base}/app.php/feed/topic/{?t}", kind: "thread", label: "topic" },
          { url: "{base}/feed.php?t={?t}", kind: "thread", label: "topic" },
        ],
      },
    ],
    site: [
      { url: "{base}/app.php/feed", kind: "latest", label: "latest posts" },
      { url: "{base}/app.php/feed/topics", kind: "new", label: "new topics" },
      { url: "{base}/feed.php", kind: "latest", label: "latest posts" },
    ],
  },
  {
    id: "xenforo",
    name: "XenForo",
    family: "forum",
    detect: { selectors: ["html#XF", "[data-xf-init]"], scriptIncludes: ["XenForo.init", "XenForo.activate"] },
    base: { fallback: "dir", before: ["forums", "threads", "whats-new", "members", "search", "tags", "help"] },
    routes: [
      { pattern: /^\/forums\/([^/]+\.\d+)(?:\/.*)?$/, feeds: [{ url: "{base}/forums/{$1}/index.rss", kind: "category", label: "forum" }] },
    ],
    site: [{ url: "{base}/forums/-/index.rss", kind: "latest", label: "latest threads" }],
  },
  {
    id: "vbulletin",
    name: "vBulletin",
    family: "forum",
    detect: {
      generator: /vBulletin/i,
      selectors: ['input[name="vb_login_username"]', '[id^="vbmenu_"]'],
      scriptIncludes: ["vBulletin.version", "vb_disable_ajax"],
    },
    base: { fallback: "dir" },
    routes: [
      {
        pattern: /^\/forumdisplay\.php$/,
        feeds: [{ url: "{base}/external.php?type=RSS2&forumids={?f}", kind: "category", label: "forum" }],
      },
    ],
    site: [
      { url: "{base}/external.php?type=RSS2", kind: "latest", label: "latest threads" },
      { url: "{base}/external?type=rss2", kind: "latest", label: "latest threads" },
    ],
  },
  {
    // Invision Community: forum pages have an `.xml/` twin; site-wide feeds
    // are admin-defined and usually advertised with <link rel=alternate>.
    id: "invision",
    name: "Invision Community",
    family: "forum",
    detect: { selectors: ["body.ipsApp", "[data-ipsquote]"], scriptIncludes: ["ipsSettings"] },
    base: {
      fallback: "dir",
      script: [/baseURL\s{0,10}:\s{0,10}["']([^"'\s]{1,300})["']/],
      before: ["forum", "topic", "discover", "profile", "search", "rss"],
    },
    routes: [
      { pattern: /^\/forum\/(\d+-[^/]+?)\/?$/, feeds: [{ url: "{base}/forum/{$1}.xml/", kind: "category", label: "forum" }] },
    ],
    site: [{ url: "{base}/discover/all.xml/", kind: "latest", label: "all activity" }],
  },
  {
    // Flarum core has no feeds; the widespread syndication extension adds /atom and /rss.
    id: "flarum",
    name: "Flarum",
    family: "forum",
    detect: { selectors: ["#flarum-loading", "script#flarum-json-payload"], scriptIncludes: ["flarum.core.app"] },
    base: { fallback: "dir", script: [/"baseUrl"\s{0,10}:\s{0,10}"([^"\s]{1,300})"/], before: ["d", "t", "u", "tags", "all"] },
    routes: [
      { pattern: /^\/d\/(\d+)(?:-[^/]*)?(?:\/.*)?$/, feeds: [{ url: "{base}/atom/d/{$1}", kind: "thread", label: "discussion" }] },
      { pattern: /^\/t\/([^/]+)\/?$/, feeds: [{ url: "{base}/atom/t/{$1}", kind: "tag", label: "tag" }] },
    ],
    site: [
      { url: "{base}/atom", kind: "latest", label: "latest discussions" },
      { url: "{base}/rss", kind: "latest", label: "latest discussions" },
    ],
  },
  {
    id: "nodebb",
    name: "NodeBB",
    family: "forum",
    detect: {
      headers: { "x-powered-by": /NodeBB/i },
      generator: /NodeBB/i,
      selectors: ['script[src*="/assets/nodebb.min.js"]', "[data-nodebb]"],
    },
    base: {
      fallback: "dir",
      script: [/"relative_path"\s{0,10}:\s{0,10}"([^"\s]{0,300})"/],
      before: ["category", "topic", "user", "tags", "recent", "popular", "unread"],
    },
    routes: [
      { pattern: /^\/category\/(\d+)(?:\/.*)?$/, feeds: [{ url: "{base}/category/{$1}.rss", kind: "category", label: "category" }] },
      { pattern: /^\/topic\/(\d+)(?:\/.*)?$/, feeds: [{ url: "{base}/topic/{$1}.rss", kind: "thread", label: "topic" }] },
    ],
    site: [{ url: "{base}/recent.rss", kind: "latest", label: "recent topics" }],
  },
  {
    id: "mybb",
    name: "MyBB",
    family: "forum",
    detect: { generator: /MyBB/i, selectors: ['a[href*="forumdisplay.php?fid="]'], scriptIncludes: ["my_post_key"] },
    base: { fallback: "dir" },
    routes: [{ pattern: /^\/forumdisplay\.php$/, feeds: [{ url: "{base}/syndication.php?fid={?fid}", kind: "category", label: "forum" }] }],
    site: [{ url: "{base}/syndication.php", kind: "latest", label: "latest threads" }],
  },
  {
    id: "smf",
    name: "Simple Machines Forum",
    family: "forum",
    detect: { generator: /\bSMF\b|Simple Machines/i, scriptIncludes: ["smf_scripturl", "var smf_"] },
    base: { fallback: "dir" },
    routes: [],
    site: [{ url: "{base}/index.php?action=.xml;type=rss2", kind: "latest", label: "latest posts" }],
  },
  {
    id: "wordpress",
    name: "WordPress",
    family: "blog",
    detect: {
      generator: /^WordPress\b/i,
      selectors: ['link[rel="https://api.w.org/"]', 'link[href*="/wp-content/themes/"]', 'script[src*="/wp-content/"]', 'link[href*="/wp-content/plugins/"]'],
    },
    base: {
      attrs: [{ selector: 'link[rel="https://api.w.org/"][href]', attr: "href", stripSuffix: "/wp-json" }],
      before: ["category", "tag", "author", "page", "feed"],
    },
    routes: [
      { pattern: /^\/(category|tag|author)\/(.+?)\/?$/, feeds: [{ url: "{base}/{$1}/{$2}/feed/", kind: "category", label: "{$2}" }] },
    ],
    site: [{ url: "{base}/feed/", kind: "posts", label: "posts" }],
  },
  {
    id: "ghost",
    name: "Ghost",
    family: "blog",
    detect: { generator: /^Ghost\b/i },
    base: { before: ["tag", "author", "page"] },
    routes: [{ pattern: /^\/(tag|author)\/([^/]+)\/?$/, feeds: [{ url: "{base}/{$1}/{$2}/rss/", kind: "category", label: "{$2}" }] }],
    site: [{ url: "{base}/rss/", kind: "posts", label: "posts" }],
  },
  {
    // Substack publications on their own domain (*.substack.com is a URL rule).
    id: "substack",
    name: "Substack",
    family: "blog",
    detect: { generator: /^Substack\b/i, selectors: ['link[href^="https://substackcdn.com/"]', 'script[src^="https://substackcdn.com/"]'] },
    base: { before: ["p", "archive", "about", "s"] },
    routes: [],
    site: [{ url: "{origin}/feed", kind: "posts", label: "posts" }],
  },
  {
    id: "blogger",
    name: "Blogger",
    family: "blog",
    detect: { generator: /^Blogger\b/i },
    routes: [{ pattern: /^\/search\/label\/([^/]+)\/?$/, feeds: [{ url: "{origin}/feeds/posts/default/-/{$1}", kind: "tag", label: "{$1}" }] }],
    site: [{ url: "{origin}/feeds/posts/default", kind: "posts", label: "posts" }],
  },
  {
    id: "mediawiki",
    name: "MediaWiki",
    family: "wiki",
    detect: { generator: /^MediaWiki\b/i },
    base: { attrs: [{ selector: 'link[rel="EditURI"][href]', attr: "href", stripSuffix: "/api.php" }], before: ["wiki", "index.php"] },
    routes: [],
    site: [{ url: "{base}/index.php?title=Special:RecentChanges&feed=atom", kind: "activity", label: "recent changes" }],
  },
];

/* -------------------------------------------------------------------------- */
/* (d) Platforms that only work through RSSHub                                 */
/* -------------------------------------------------------------------------- */

/**
 * Hosts whose content has no native feed: the UI names the platform in the
 * "Braucht RSSHub" hint. The routes themselves are radar rules
 * (lib/rsshub-radar-rules.ts) and are availability-checked against the
 * configured instance before they are offered.
 */
export const RSSHUB_ONLY_PLATFORMS: Array<{ name: string; hosts: string[] }> = [
  { name: "X/Twitter", hosts: ["x.com", "twitter.com"] },
  { name: "Facebook", hosts: ["facebook.com"] },
  { name: "Instagram", hosts: ["instagram.com"] },
  { name: "TikTok", hosts: ["tiktok.com"] },
  { name: "Threads", hosts: ["threads.net", "threads.com"] },
  { name: "Telegram", hosts: ["t.me"] },
  { name: "Blizzard News", hosts: ["news.blizzard.com"] },
];
