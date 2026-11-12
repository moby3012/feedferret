import { normalizeFeedContentRules } from "@/lib/feed-content-rules";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { restoreArchivedFeedByUrl } from "@/lib/archived-feed";
import { assertComplete, markWhereRead, setReadStateByIds } from "@/server/articles/bulk-read";
import { userStateGroups, writeUserState, type UserStatePatch } from "@/server/articles/user-state";
import { apiError, clampInt, readJson, requireApiUser, scopeError, type ApiUser } from "@/lib/api-auth";
import { buildAdvancedSearchWhere } from "@/lib/search";
import { fetchFeedArticles } from "@/lib/feed-fetcher";
import { syncFeed, syncUserFeeds } from "@/lib/rss-sync";
import { checkRateLimit, getClientIdentifier, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { refetchArticleFullText } from "@/lib/full-text-fetch";
import { isRsshubConfigured, getRsshubConfig, buildRsshubPublicRouteUrl, validateRsshubRoute } from "@/lib/rsshub";
import { connectorFeedUrlError, getConnectorSecretRules, redactArticleWith, redactFeedForClient, redactFeedsForClient, stripConnectorSecrets } from "@/lib/connector-secrets";
import { stripFeedSecrets } from "@/lib/feed-secrets";
import { discoverFeeds } from "@/lib/feed-discovery";
import { normalizeActionUrl } from "@/lib/add-feed-input";
import { isChangedetectionConfigured, getChangedetectionConfig, createWatch, buildWatchFeedPublicUrl } from "@/lib/changedetection";
import { fetchAndSuggestFeedCandidatesDetailed } from "@/lib/page-feed-suggest";
import { createPageFeedForUser, noPageFeedCandidateMessage, suggestTopPageFeed } from "@/lib/page-feed-create";
import { importOpmlXml, OpmlImportInputError } from "@/lib/import/opml-import";
import { OpmlParseError } from "@/lib/opml";
import { sanitizeWebhookConfigs, actionsReferenceConfigs, redactWebhookConfigs } from "@/lib/webhooks";
import { AI_OPERATOR_DELETE_ERROR, ruleHasAiDeleteConflict } from "@/lib/rule-ai-operators";
import { parseRuleActions } from "@/lib/auto-read-rules";
import { assertOwnedCategories } from "@/lib/owned-categories";
import { clampFeedLimits } from "@/lib/feed-limits";

function rpc(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, data } }, { status: code === -32600 ? 400 : 200 });
}

function textContent(data: unknown) {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

// Feed credentials, fetch options and connector secrets must never leave the
// server: strip the secret columns (lib/feed-secrets.ts) and redact connector
// keys from URLs / errors (lib/connector-secrets.ts) on every feed output.
/** `archived` argument → Feed filter: archived feeds are hidden unless asked for. */
function archivedFeedFilter(mode: unknown): { archivedAt?: null | { not: null } } {
  if (mode === "only") return { archivedAt: { not: null } };
  if (mode === "include") return {};
  return { archivedAt: null };
}

async function clientFeed<T>(value: T): Promise<T> {
  if (!value || typeof value !== "object") return value;
  const stripped = stripFeedSecrets(value);
  if (Array.isArray(stripped)) return (await redactFeedsForClient(stripped as any[])) as T;
  return (await redactFeedForClient(stripped as any)) as T;
}

// Serialize an auto-read rule for MCP output: never return the raw
// webhookConfigs JSON (it holds HMAC secrets); expose a redacted `webhooks`
// array with a hasSecret flag instead.
function ruleForMcp(rule: any) {
  if (!rule) return rule;
  const { webhookConfigs, ...rest } = rule;
  return { ...rest, webhooks: redactWebhookConfigs(webhookConfigs) };
}

// Feed config fields an MCP client may set via update_feed / add_feed.

/** Bare domains / missing scheme / pasted junk → https URL (same normaliser as the web UI). */
function mcpUrlArg(raw: unknown): string {
  const normalized = normalizeActionUrl(raw);
  if (!normalized.ok) throw new Error(normalized.errorCode === "url-empty" ? "url is required" : normalized.error);
  return normalized.url;
}

const FEED_WRITABLE_KEYS = [
  "name", "icon", "categoryId", "updateFrequency", "retentionDays", "keepMinArticles", "priority",
  // Fetch / HTTP options
  "customUserAgent", "fetchTimeoutSecs", "sslVerify", "maxSizeKb",
  // Per-feed HTTP auth (password is write-only: accepted, never serialized back)
  "authType", "authUsername", "authPassword",
  // Feed Intelligence / full-text extraction
  "fullTextMode", "fullTextSelector", "fullTextRemoveSelectors", "fullTextConditions", "autoFetchFullText", "defaultContentFormat",
  // Per-feed keyword content filter (newline-separated words → mark matching new articles read)
  "contentRules", "filtersActionRead",
  // Per-feed display overrides (null = inherit the user default)
  "hideArticleImage", "hideFromAllFeeds", "readerFontSizeOverride", "readerWidthOverride", "openOriginalOverride",
  // Muting
  "autoMuted",
] as const;

const tools = [
  {
    name: "feedferret.search_articles",
    description: "Search/list FeedFerret articles with advanced query syntax and state/feed/category/label filters.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free text or advanced query, e.g. 'is:unread label:AI after:7d'." },
        feedId: { type: "string" },
        categoryId: { type: "string" },
        labelId: { type: "string" },
        isRead: { type: "boolean" },
        isStarred: { type: "boolean" },
        isReadLater: { type: "boolean" },
        limit: { type: "number", minimum: 1, maximum: 50 },
      },
    },
  },
  { name: "feedferret.get_article", description: "Get one full article by ID.", inputSchema: { type: "object", properties: { articleId: { type: "string" } }, required: ["articleId"] } },
  { name: "feedferret.fetch_full_text", description: "Fetch and extract the full readable text of an article from its source page, and persist it onto the article if it's a genuine improvement over the current (often truncated) feed content. Returns the updated article. Throws a clean message if the page can't be read or the result wouldn't improve the article.", inputSchema: { type: "object", properties: { articleId: { type: "string" } }, required: ["articleId"] } },
  { name: "feedferret.update_article_state", description: "Update read/starred/read-later state on an article.", inputSchema: { type: "object", properties: { articleId: { type: "string" }, isRead: { type: "boolean" }, isStarred: { type: "boolean" }, isReadLater: { type: "boolean" } }, required: ["articleId"] } },
  { name: "feedferret.list_feeds", description: "List RSS feeds with category, unread counts and full per-feed configuration (fetch/HTTP options, full-text settings, reader/display overrides, health). The auth password is never included.", inputSchema: { type: "object", properties: { archived: { type: "string", enum: ["exclude", "only", "include"], description: "Archived feeds (stopped syncing, hidden from the reader): exclude (default), only, or include." } } } },
  { name: "feedferret.get_feed", description: "Get one feed by ID with its full configuration (fetch/HTTP options, full-text/Feed Intelligence settings, reader/display overrides, health, unread count). The auth password is never included.", inputSchema: { type: "object", properties: { feedId: { type: "string" } }, required: ["feedId"] } },
  { name: "feedferret.add_feed", description: "Add a new RSS/Atom feed and optionally sync it immediately.", inputSchema: { type: "object", properties: { url: { type: "string" }, name: { type: "string" }, icon: { type: "string" }, categoryId: { type: "string" }, sync: { type: "boolean" } }, required: ["url"] } },
  { name: "feedferret.sync_feeds", description: "Sync all feeds or one feed when feedId is supplied.", inputSchema: { type: "object", properties: { feedId: { type: "string" } } } },
  { name: "feedferret.list_categories", description: "List feed categories/folders.", inputSchema: { type: "object", properties: {} } },
  { name: "feedferret.list_labels", description: "List article labels/tags.", inputSchema: { type: "object", properties: {} } },
  { name: "feedferret.create_label", description: "Create a label/tag.", inputSchema: { type: "object", properties: { name: { type: "string" }, color: { type: "string" } }, required: ["name"] } },
  { name: "feedferret.mark_all_read", description: "Mark matching unread articles as read. Use with care.", inputSchema: { type: "object", properties: { query: { type: "string" }, feedId: { type: "string" }, categoryId: { type: "string" }, labelId: { type: "string" } } } },
  // Feed management
  { name: "feedferret.delete_feed", description: "Delete a feed and all its articles.", inputSchema: { type: "object", properties: { feedId: { type: "string" } }, required: ["feedId"] } },
  {
    name: "feedferret.update_feed",
    description: "Update a feed's metadata, fetch/HTTP options, full-text (Feed Intelligence) settings, per-feed reader/display overrides, and mute state. Only provided fields change. The auth password is write-only and is never returned.",
    inputSchema: {
      type: "object",
      properties: {
        feedId: { type: "string" },
        name: { type: "string" },
        icon: { type: "string", description: "Emoji or short icon string." },
        categoryId: { type: ["string", "null"], description: "Category/folder id, or null to remove." },
        updateFrequency: { type: ["number", "null"], description: "Refresh interval in minutes; null = automatic cadence with inherited minimum." },
        retentionDays: { type: ["number", "null"] },
        keepMinArticles: { type: ["number", "null"] },
        priority: { type: "string", description: "e.g. 'low' | 'normal' | 'high'." },
        // Fetch / HTTP options
        customUserAgent: { type: ["string", "null"] },
        fetchTimeoutSecs: { type: ["number", "null"] },
        sslVerify: { type: "boolean" },
        maxSizeKb: { type: ["number", "null"] },
        // Per-feed HTTP auth (password write-only)
        authType: { type: ["string", "null"], description: "e.g. 'none' | 'basic'." },
        authUsername: { type: ["string", "null"] },
        authPassword: { type: ["string", "null"], description: "Write-only; never returned in feed output." },
        // Feed Intelligence / full-text extraction
        fullTextMode: { type: ["string", "null"], enum: ["off", "auto", "selector", "ai", null], description: "How full text is extracted for this feed." },
        fullTextSelector: { type: ["string", "null"], description: "CSS selector for the article body (selector mode)." },
        fullTextRemoveSelectors: { type: ["string", "null"], description: "CSS selectors to strip from extracted content." },
        fullTextConditions: { type: ["string", "null"] },
        autoFetchFullText: { type: "boolean", description: "Fetch full text automatically on sync." },
        defaultContentFormat: { type: ["string", "null"], enum: ["html", "markdown", null] },
        contentRules: { type: ["string", "null"], description: "Ordered content transforms and ingestion gates as JSON. Null disables them. Validated for regex safety." },
        filtersActionRead: { type: ["string", "null"], description: "Newline-separated keywords; new articles containing any are marked read on arrival." },
        // Per-feed display overrides (null = inherit the user default)
        hideArticleImage: { type: ["boolean", "null"] },
        hideFromAllFeeds: { type: ["boolean", "null"] },
        readerFontSizeOverride: { type: ["string", "null"] },
        readerWidthOverride: { type: ["string", "null"] },
        openOriginalOverride: { type: ["boolean", "null"] },
        // Muting
        autoMuted: { type: "boolean", description: "Mute/unmute the feed (suppresses notifications & unread counting)." },
        archived: { type: "boolean", description: "Archive (true) or restore (false) the feed. Archived feeds stop syncing and leave the reader / API subscription lists but keep their articles." },
      },
      required: ["feedId"],
    },
  },
  // Category management
  { name: "feedferret.import_opml", description: "Import subscriptions from an OPML document (any reader; FreshRSS `frss:*` extension attributes such as XPath/JSON scraping, full-content CSS selector, read filters, ttl/mute and empty categories are mapped). Returns counts plus `issues`: every attribute that was adapted, preserved or not supported. Use dryRun to preview without writing.", inputSchema: { type: "object", properties: { xml: { type: "string", description: "The OPML document (max 5 MB)." }, dryRun: { type: "boolean", description: "Only report what would change." } }, required: ["xml"] } },
  { name: "feedferret.create_category", description: "Create a feed category/folder.", inputSchema: { type: "object", properties: { name: { type: "string" }, parentId: { type: "string" } }, required: ["name"] } },
  { name: "feedferret.update_category", description: "Update a feed category name, parent or order.", inputSchema: { type: "object", properties: { categoryId: { type: "string" }, name: { type: "string" }, parentId: { type: ["string", "null"] }, order: { type: "number" } }, required: ["categoryId"] } },
  { name: "feedferret.delete_category", description: "Delete a feed category.", inputSchema: { type: "object", properties: { categoryId: { type: "string" } }, required: ["categoryId"] } },
  // Label management
  { name: "feedferret.update_label", description: "Update a label name or color.", inputSchema: { type: "object", properties: { labelId: { type: "string" }, name: { type: "string" }, color: { type: "string" } }, required: ["labelId"] } },
  { name: "feedferret.delete_label", description: "Delete a label and its article associations.", inputSchema: { type: "object", properties: { labelId: { type: "string" } }, required: ["labelId"] } },
  { name: "feedferret.label_article", description: "Replace all labels on an article.", inputSchema: { type: "object", properties: { articleId: { type: "string" }, labelIds: { type: "array", items: { type: "string" } } }, required: ["articleId", "labelIds"] } },
  // Bulk article action
  { name: "feedferret.batch_update_articles", description: "Bulk update read/star state on multiple articles (up to 200).", inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, action: { type: "string", enum: ["read", "unread", "star", "unstar"] } }, required: ["ids", "action"] } },
  // Saved searches
  { name: "feedferret.list_saved_searches", description: "List saved searches.", inputSchema: { type: "object", properties: {} } },
  { name: "feedferret.create_saved_search", description: "Create a saved search.", inputSchema: { type: "object", properties: { name: { type: "string" }, query: { type: "string" } }, required: ["name", "query"] } },
  { name: "feedferret.delete_saved_search", description: "Delete a saved search.", inputSchema: { type: "object", properties: { searchId: { type: "string" } }, required: ["searchId"] } },
  // Keyword alerts
  { name: "feedferret.list_keyword_alerts", description: "List keyword alerts.", inputSchema: { type: "object", properties: {} } },
  { name: "feedferret.create_keyword_alert", description: "Create a keyword alert.", inputSchema: { type: "object", properties: { name: { type: "string" }, query: { type: "string" }, scope: { type: "string" }, actions: { type: "array", items: { type: "string" } } }, required: ["name", "query"] } },
  { name: "feedferret.update_keyword_alert", description: "Update a keyword alert.", inputSchema: { type: "object", properties: { alertId: { type: "string" }, enabled: { type: "boolean" }, name: { type: "string" }, query: { type: "string" }, scope: { type: "string" }, actions: { type: "array", items: { type: "string" } } }, required: ["alertId"] } },
  { name: "feedferret.delete_keyword_alert", description: "Delete a keyword alert.", inputSchema: { type: "object", properties: { alertId: { type: "string" } }, required: ["alertId"] } },
  // Auto-read rules (incl. webhook actions)
  { name: "feedferret.list_auto_read_rules", description: "List auto-read rules. Each rule's webhook configs are returned with the secret redacted (hasSecret flag only).", inputSchema: { type: "object", properties: {} } },
  {
    name: "feedferret.create_auto_read_rule",
    description: "Create an auto-read rule. `actions` may include `webhook_call:<index>` entries that fire the webhook at that index in `webhookConfigs` when the rule matches. Webhook secrets are accepted here but never returned.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        query: { type: "string" },
        actions: { type: "array", items: { type: "string" }, description: "e.g. [\"mark_read\", \"webhook_call:0\"]." },
        scope: { type: "string" },
        trigger: { type: "string", description: "'article' (default) or 'feed_error'." },
        enabled: { type: "boolean" },
        webhookConfigs: {
          type: "array",
          description: "Webhook targets referenced by webhook_call:<index> actions.",
          items: {
            type: "object",
            properties: {
              url: { type: "string" },
              method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
              headers: { type: "object" },
              bodyTemplate: { type: "string", description: "Supports {{event}}, {{rule_name}}, {{article_title}}, {{article_link}}, {{feed_name}}, … placeholders." },
              secret: { type: "string", description: "HMAC signing secret (write-only; never returned)." },
            },
            required: ["url"],
          },
        },
      },
      required: ["name", "query"],
    },
  },
  { name: "feedferret.update_auto_read_rule", description: "Update an auto-read rule (all fields optional). Passing webhookConfigs replaces the full list. Secrets are write-only.", inputSchema: { type: "object", properties: { ruleId: { type: "string" }, name: { type: "string" }, query: { type: "string" }, actions: { type: "array", items: { type: "string" } }, scope: { type: "string" }, trigger: { type: "string" }, enabled: { type: "boolean" }, order: { type: "number" }, webhookConfigs: { type: "array", items: { type: "object", properties: { url: { type: "string" }, method: { type: "string" }, headers: { type: "object" }, bodyTemplate: { type: "string" }, secret: { type: ["string", "null"], description: "Write-only. On update: omit or \"\" keeps the stored secret of the entry named by secretRef, null removes it." }, secretRef: { type: "number", description: "Index from the redacted output; keeps the stored secret and every header sent as \"__keep__\"." } }, required: ["url"] } } }, required: ["ruleId"] } },
  { name: "feedferret.delete_auto_read_rule", description: "Delete an auto-read rule.", inputSchema: { type: "object", properties: { ruleId: { type: "string" } }, required: ["ruleId"] } },
  // Notifications & stats
  { name: "feedferret.list_notifications", description: "List user notifications ordered by newest first.", inputSchema: { type: "object", properties: { isRead: { type: "boolean" }, limit: { type: "number", minimum: 1, maximum: 100 } } } },
  { name: "feedferret.get_stats", description: "Get aggregate stats for the current user.", inputSchema: { type: "object", properties: {} } },
  // Connectors
  { name: "feedferret.discover_feeds", description: "Resolve a URL, @handle, subreddit/channel shorthand (r/rust, @user@mastodon.social) or a plain topic phrase into subscribable feed candidates [{url,title,kind,platform,confidence,source}]. Uses deterministic platform rules first (YouTube, Reddit, GitHub, Mastodon, Bluesky, arXiv, Hacker News, Apple Podcasts, …), then HTML feed discovery and RSSHub Radar rules; a plain phrase returns Google News/Bing News/Hacker News/arXiv search feeds. Pass a candidate's url to add_feed.", inputSchema: { type: "object", properties: { query: { type: "string", description: "URL, handle or topic phrase." }, locale: { type: "string", description: "Optional locale (e.g. 'de') for localized news feeds." } }, required: ["query"] } },
  { name: "feedferret.list_connectors", description: "List server-configured connectors (RSSHub, changedetection.io) and whether each is available. Useful to discover what connector-backed feeds can be created on this server.", inputSchema: { type: "object", properties: {} } },
  { name: "feedferret.create_rsshub_feed", description: "Create a feed from an RSSHub route path (e.g. '/github/trending/daily/any'). The route is validated against the server's configured RSSHub instance before the feed is created. Requires the RSSHub connector to be configured.", inputSchema: { type: "object", properties: { routePath: { type: "string", description: "RSSHub route path, e.g. '/github/issue/DIYgod/RSSHub'." }, name: { type: "string" }, categoryId: { type: "string" }, sync: { type: "boolean" } }, required: ["routePath"] } },
  { name: "feedferret.create_changedetection_feed", description: "Create a changedetection.io watch for a web page URL and add it as a feed. The feed stays empty until changedetection has checked the page at least twice. Requires the changedetection.io connector to be configured.", inputSchema: { type: "object", properties: { url: { type: "string" }, name: { type: "string" }, categoryId: { type: "string" }, sync: { type: "boolean" } }, required: ["url"] } },
  { name: "feedferret.suggest_page_feed", description: "Given an arbitrary web page URL, heuristically detect repeating item lists and return candidate feed configs (XPath selectors) with scores, sample titles and a preview quality verdict (`quality.verdict` ok or review, with `quality.reasons`; navigation/login/placeholder lists are never returned). Use before create_page_feed to inspect/choose, or call create_page_feed directly to auto-pick the best candidate.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "feedferret.create_page_feed", description: "Create an HTML+XPath feed from an arbitrary web page. Pass a `config` (as returned by suggest_page_feed) to use it, or omit it to auto-pick the top-scoring detected candidate. Fails if no repeating item list is found and no config is given.", inputSchema: { type: "object", properties: { url: { type: "string" }, config: { type: "object", description: "XPath field config: { xPathItem (required), xPathItemTitle?, xPathItemUri?, xPathItemContent?, xPathItemTimestamp?, xPathItemTimeFormat? (PHP createFromFormat, e.g. \"d.m.Y H:i\"), xPathItemThumbnail? }.", properties: { xPathItem: { type: "string" }, xPathItemTitle: { type: "string" }, xPathItemUri: { type: "string" }, xPathItemContent: { type: "string" }, xPathItemTimestamp: { type: "string" }, xPathItemTimeFormat: { type: "string" }, xPathItemThumbnail: { type: "string" } } }, name: { type: "string" }, categoryId: { type: "string" }, sync: { type: "boolean" } }, required: ["url"] } },
];

async function searchArticles(user: ApiUser, args: any) {
  // N13: same per-user search bucket as the web list and REST v1.
  if (typeof args.query === "string" && args.query.trim() && !checkRateLimit(`user:${user.id}`, RATE_LIMITS.articleSearch).success) {
    throw new Error("Rate limit exceeded for article search");
  }
  const where: any = { userId: user.id };
  if (typeof args.feedId === "string") where.feedId = args.feedId;
  if (typeof args.categoryId === "string") where.feed = { categoryId: args.categoryId };
  if (typeof args.labelId === "string") where.labels = { some: { labelId: args.labelId, userId: user.id } };
  if (typeof args.isRead === "boolean") where.isRead = args.isRead;
  if (typeof args.isStarred === "boolean") where.isStarred = args.isStarred;
  if (typeof args.isReadLater === "boolean") where.isReadLater = args.isReadLater;
  if (typeof args.query === "string") {
    const advancedWhere = await buildAdvancedSearchWhere(user.id, args.query);
    if (Object.keys(advancedWhere).length) where.AND = [...(where.AND || []), advancedWhere];
  }
  const limit = Math.min(50, Math.max(1, clampInt(args.limit, 10, 1, 50)));
  const articles = await db.article.findMany({
    where,
    orderBy: { publishedAt: "desc" },
    take: limit,
    select: {
      id: true, title: true, link: true, excerpt: true, author: true, publishedAt: true,
      isRead: true, isStarred: true, isReadLater: true,
      feed: { select: { id: true, name: true, url: true, icon: true } },
      labels: { include: { label: true } },
    },
  });
  // link / feed.url without connector secrets (N3).
  const rules = await getConnectorSecretRules();
  return articles.map((article) => redactArticleWith(rules, article));
}

// Shared feed-creation core for the MCP add-feed + connector-feed tools. The
// URL is already validated/resolved by the caller. A fetch failure never blocks
// creation (the feed lands "pending" and its health carries the error).
async function createFeedForUser(
  userId: string,
  url: string,
  opts: { name?: unknown; categoryId?: unknown; icon?: unknown; fallbackName?: string; sync?: boolean },
) {
  // Only allowed connector routes (no /rsshub/transform/…, no all-watches feed) — N3.
  const connectorError = await connectorFeedUrlError(url);
  if (connectorError) throw new Error(connectorError);
  url = await stripConnectorSecrets(url);
  // An archived subscription to this URL is restored instead of a duplicate error.
  const restored = await restoreArchivedFeedByUrl(userId, url);
  if (restored) return clientFeed({ ...restored, restored: true });
  const remoteFeed = await fetchFeedArticles({ url }).catch(() => null);
  const order = await db.feed.count({ where: { userId } });
  const name = (typeof opts.name === "string" && opts.name.trim()) || remoteFeed?.title || opts.fallbackName || url;
  const feed = await db.feed.create({
    data: {
      userId,
      url,
      name,
      categoryId: typeof opts.categoryId === "string" ? opts.categoryId : undefined,
      icon: typeof opts.icon === "string" ? opts.icon : "📰",
      order,
      lastStatus: "pending",
    },
  });
  if (opts.sync !== false) await syncFeed(userId, feed.id).catch(() => null);
  const fresh = await db.feed.findFirst({
    where: { id: feed.id, userId },
    include: { category: true, _count: { select: { articles: { where: { isRead: false } } } } },
  });
  return clientFeed(fresh);
}

async function callTool(user: ApiUser, name: string, args: any) {
  const readTools = new Set(["search_articles", "get_article", "list_feeds", "get_feed", "list_categories", "list_labels", "list_saved_searches", "list_keyword_alerts", "list_auto_read_rules", "list_notifications", "list_connectors", "get_stats", "suggest_page_feed", "discover_feeds"]);
  if (scopeError(user, readTools.has(name.replace(/^feedferret\./, "")) ? "read" : "write")) {
    throw new Error("Insufficient token scope");
  }
  switch (name) {
    case "feedferret.search_articles":
      return searchArticles(user, args);
    case "feedferret.get_article": {
      const article = await db.article.findFirst({ where: { id: String(args.articleId), userId: user.id }, omit: { feedContent: true }, include: { feed: true, labels: { include: { label: true } } } });
      if (article && (article as any).feed) (article as any).feed = await clientFeed((article as any).feed);
      return article ? redactArticleWith(await getConnectorSecretRules(), article) : article;
    }
    case "feedferret.fetch_full_text": {
      const { article, suggestAutoFullText } = await refetchArticleFullText(user.id, String(args.articleId));
      if ((article as any).feed) (article as any).feed = await clientFeed((article as any).feed);
      return { ...redactArticleWith(await getConnectorSecretRules(), article), suggestAutoFullText };
    }
    case "feedferret.update_article_state": {
      const patch: UserStatePatch = {};
      if (typeof args.isRead === "boolean") patch.isRead = args.isRead;
      if (typeof args.isStarred === "boolean") patch.isStarred = args.isStarred;
      if (typeof args.isReadLater === "boolean") patch.isReadLater = args.isReadLater;
      const articleId = String(args.articleId);
      const groups = userStateGroups([articleId], patch);
      if (groups.length === 0) return { updated: 0 }; // nothing to update: no write, no count
      const owned = await db.article.findFirst({ where: { id: articleId, userId: user.id }, select: { id: true } });
      if (!owned) return { updated: 0 };
      await writeUserState(user.id, groups); // raw writes: updatedAt untouched
      return { updated: 1 };
    }
    case "feedferret.list_feeds":
      return clientFeed(await db.feed.findMany({ where: { userId: user.id, ...archivedFeedFilter(args.archived) }, include: { category: true, _count: { select: { articles: { where: { isRead: false } } } } }, orderBy: [{ order: "asc" }, { name: "asc" }] }));
    case "feedferret.get_feed": {
      const feed = await db.feed.findFirst({ where: { id: String(args.feedId), userId: user.id }, include: { category: true, _count: { select: { articles: { where: { isRead: false } } } } } });
      if (!feed) throw new Error("Feed not found");
      return clientFeed(feed);
    }
    case "feedferret.add_feed": {
      const url = mcpUrlArg(args.url);
      return createFeedForUser(user.id, url, { name: args.name, categoryId: args.categoryId, icon: args.icon, sync: args.sync !== false });
    }
    case "feedferret.sync_feeds":
      if (typeof args.feedId === "string") return syncFeed(user.id, args.feedId);
      return syncUserFeeds(user.id);
    case "feedferret.list_categories":
      return db.category.findMany({ where: { userId: user.id }, orderBy: [{ order: "asc" }, { name: "asc" }] });
    case "feedferret.list_labels":
      return db.label.findMany({ where: { userId: user.id }, include: { _count: { select: { articles: true } } }, orderBy: { name: "asc" } });
    case "feedferret.create_label":
      if (typeof args.name !== "string" || !args.name.trim()) throw new Error("name is required");
      return db.label.create({ data: { userId: user.id, name: args.name.trim(), color: typeof args.color === "string" ? args.color : "#3b82f6" } });
    case "feedferret.mark_all_read": {
      const where: any = { userId: user.id, isRead: false };
      if (typeof args.feedId === "string") where.feedId = args.feedId;
      if (typeof args.categoryId === "string") where.feed = { categoryId: args.categoryId };
      if (typeof args.labelId === "string") where.labels = { some: { labelId: args.labelId, userId: user.id } };
      if (typeof args.query === "string") {
        const advancedWhere = await buildAdvancedSearchWhere(user.id, args.query);
        if (Object.keys(advancedWhere).length) where.AND = [...(where.AND || []), advancedWhere];
      }
      // Aggregate scopes (everything / a category) skip archived feeds like the reader's "All articles"; a feed, a
      // label or a search addresses articles explicitly and keeps them.
      if (typeof args.feedId !== "string" && typeof args.labelId !== "string" && !(typeof args.query === "string" && args.query.trim())) {
        where.feed = { ...(where.feed || {}), archivedAt: null };
      }
      const now = new Date();
      // Partial write → tool error with counts (PartialBulkWriteError); re-running is idempotent.
      const result = assertComplete(await markWhereRead(user.id, where, { cutoff: now, now }));
      return { updated: result.ids.length };
    }
    // Feed management
    case "feedferret.delete_feed": {
      const result = await db.feed.deleteMany({ where: { id: String(args.feedId), userId: user.id } });
      if (!result.count) throw new Error("Feed not found");
      return { deleted: true, id: String(args.feedId) };
    }
    case "feedferret.update_feed": {
      const data: any = {};
      for (const key of FEED_WRITABLE_KEYS) {
        if (args[key] !== undefined) data[key] = args[key];
      }
      if (data.contentRules !== undefined) data.contentRules = normalizeFeedContentRules(data.contentRules);
      if (data.categoryId) await assertOwnedCategories(user.id, [data.categoryId]);
      if (data.updateFrequency !== undefined || data.categoryId !== undefined) data.nextSyncAt = null;
      clampFeedLimits(data);
      if (typeof args.archived === "boolean") {
        // Keep the original archive date when archiving an already archived feed.
        if (args.archived) await db.feed.updateMany({ where: { id: String(args.feedId), userId: user.id, archivedAt: null }, data: { archivedAt: new Date() } });
        else { data.archivedAt = null; data.nextSyncAt = null; }
      }
      // An archive-only call leaves `data` empty (Prisma matches nothing then): existence is checked instead.
      const matched = Object.keys(data).length
        ? (await db.feed.updateMany({ where: { id: String(args.feedId), userId: user.id }, data })).count
        : await db.feed.count({ where: { id: String(args.feedId), userId: user.id } });
      if (!matched) throw new Error("Feed not found");
      const feed = await db.feed.findFirst({ where: { id: String(args.feedId), userId: user.id }, include: { category: true, _count: { select: { articles: { where: { isRead: false } } } } } });
      return clientFeed(feed);
    }
    // Category management
    case "feedferret.create_category": {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) throw new Error("name is required");
      if (typeof args.parentId === "string") await assertOwnedCategories(user.id, [args.parentId]);
      return db.category.create({ data: { userId: user.id, name, parentId: typeof args.parentId === "string" ? args.parentId : undefined } });
    }
    case "feedferret.update_category": {
      const data: any = {};
      if (typeof args.name === "string") data.name = args.name.trim();
      if (args.parentId !== undefined) data.parentId = args.parentId;
      if (data.parentId) {
        if (data.parentId === String(args.categoryId)) throw new Error("Invalid category");
        await assertOwnedCategories(user.id, [data.parentId]);
      }
      if (typeof args.order === "number") data.order = args.order;
      const result = await db.category.updateMany({ where: { id: String(args.categoryId), userId: user.id }, data });
      if (!result.count) throw new Error("Category not found");
      return db.category.findFirst({ where: { id: String(args.categoryId), userId: user.id } });
    }
    case "feedferret.delete_category": {
      const result = await db.category.deleteMany({ where: { id: String(args.categoryId), userId: user.id } });
      if (!result.count) throw new Error("Category not found");
      return { deleted: true, id: String(args.categoryId) };
    }
    // Label management
    case "feedferret.update_label": {
      const data: any = {};
      if (typeof args.name === "string") data.name = args.name.trim();
      if (typeof args.color === "string") data.color = args.color.trim();
      const result = await db.label.updateMany({ where: { id: String(args.labelId), userId: user.id }, data });
      if (!result.count) throw new Error("Label not found");
      return db.label.findFirst({ where: { id: String(args.labelId), userId: user.id } });
    }
    case "feedferret.delete_label": {
      const result = await db.label.deleteMany({ where: { id: String(args.labelId), userId: user.id } });
      if (!result.count) throw new Error("Label not found");
      return { deleted: true, id: String(args.labelId) };
    }
    case "feedferret.label_article": {
      const articleId = String(args.articleId);
      const article = await db.article.findFirst({ where: { id: articleId, userId: user.id }, select: { id: true } });
      if (!article) throw new Error("Article not found");
      const labelIds: string[] = Array.isArray(args.labelIds) ? args.labelIds.filter((id: unknown) => typeof id === "string") : [];
      const validLabels = await db.label.findMany({ where: { userId: user.id, id: { in: labelIds } }, select: { id: true } });
      const validLabelIds = validLabels.map((l: { id: string }) => l.id);
      await db.$transaction([
        db.articleLabel.deleteMany({ where: { userId: user.id, articleId } }),
        ...validLabelIds.map((labelId: string) => db.articleLabel.create({ data: { userId: user.id, articleId, labelId } })),
      ]);
      return { updated: true, articleId, labelIds: validLabelIds };
    }
    // Bulk article action
    case "feedferret.batch_update_articles": {
      const ids: string[] = Array.isArray(args.ids) ? args.ids.filter((id: unknown) => typeof id === "string") : [];
      if (ids.length === 0) throw new Error("ids must be a non-empty array");
      if (ids.length > 200) throw new Error("ids array must not exceed 200 items");
      const action = String(args.action);
      if (!["read", "unread", "star", "unstar"].includes(action)) throw new Error("action must be one of: read, unread, star, unstar");
      const owned = await db.article.findMany({ where: { id: { in: ids }, userId: user.id }, select: { id: true } });
      const ownedIds = owned.map((a: { id: string }) => a.id);
      if (ownedIds.length === 0) throw new Error("No matching articles found");
      if (action === "read" || action === "unread") {
        const result = assertComplete(await setReadStateByIds(user.id, ownedIds, action === "read"));
        return { updated: result.ids.length, notFound: ids.length - ownedIds.length };
      }
      const patch: UserStatePatch = action === "star" ? { isStarred: true } : { isStarred: false };
      await writeUserState(user.id, userStateGroups(ownedIds, patch));
      return { updated: ownedIds.length, notFound: ids.length - ownedIds.length };
    }
    // Saved searches
    case "feedferret.list_saved_searches":
      return db.savedSearch.findMany({ where: { userId: user.id }, orderBy: [{ order: "asc" }, { name: "asc" }] });
    case "feedferret.create_saved_search": {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!name || !query) throw new Error("name and query are required");
      return db.savedSearch.create({ data: { userId: user.id, name, query } });
    }
    case "feedferret.delete_saved_search": {
      const result = await db.savedSearch.deleteMany({ where: { id: String(args.searchId), userId: user.id } });
      if (!result.count) throw new Error("Saved search not found");
      return { deleted: true, id: String(args.searchId) };
    }
    // Keyword alerts
    case "feedferret.list_keyword_alerts":
      return db.keywordAlert.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    case "feedferret.create_keyword_alert": {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!name || !query) throw new Error("name and query are required");
      const actions = Array.isArray(args.actions) ? args.actions.filter((a: unknown) => typeof a === "string") : ["notify_inapp"];
      return db.keywordAlert.create({
        data: {
          userId: user.id,
          name,
          query,
          scope: typeof args.scope === "string" ? args.scope : "all",
          actions: JSON.stringify(actions),
        },
      });
    }
    case "feedferret.update_keyword_alert": {
      const data: any = {};
      if (typeof args.name === "string") data.name = args.name.trim();
      if (typeof args.query === "string") data.query = args.query.trim();
      if (typeof args.scope === "string") data.scope = args.scope;
      if (typeof args.enabled === "boolean") data.enabled = args.enabled;
      if (Array.isArray(args.actions)) data.actions = JSON.stringify(args.actions.filter((a: unknown) => typeof a === "string"));
      const result = await db.keywordAlert.updateMany({ where: { id: String(args.alertId), userId: user.id }, data });
      if (!result.count) throw new Error("Alert not found");
      return db.keywordAlert.findFirst({ where: { id: String(args.alertId), userId: user.id } });
    }
    case "feedferret.delete_keyword_alert": {
      const result = await db.keywordAlert.deleteMany({ where: { id: String(args.alertId), userId: user.id } });
      if (!result.count) throw new Error("Alert not found");
      return { deleted: true, id: String(args.alertId) };
    }
    // Auto-read rules (incl. webhook actions). webhookConfigs secrets are
    // accepted on write but redacted on read via ruleForMcp().
    case "feedferret.list_auto_read_rules": {
      const rules = await db.autoReadRule.findMany({ where: { userId: user.id }, orderBy: { order: "asc" } });
      return rules.map(ruleForMcp);
    }
    case "feedferret.create_auto_read_rule": {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!name || !query) throw new Error("name and query are required");
      const actions = Array.isArray(args.actions) ? args.actions.filter((a: unknown) => typeof a === "string") : null;
      if (ruleHasAiDeleteConflict(query, actions ?? ["mark_read"])) throw new Error(AI_OPERATOR_DELETE_ERROR);
      const { configs, valid } = sanitizeWebhookConfigs(args.webhookConfigs);
      if (!valid) throw new Error("Each webhook needs a valid http(s) URL");
      if (actions && !actionsReferenceConfigs(actions, configs.length)) throw new Error("A webhook_call action references a missing webhook config");
      const order = await db.autoReadRule.count({ where: { userId: user.id } });
      const rule = await db.autoReadRule.create({
        data: {
          userId: user.id,
          name,
          query,
          action: "mark_read",
          actions: actions ? JSON.stringify(actions) : null,
          scope: typeof args.scope === "string" ? args.scope : null,
          trigger: typeof args.trigger === "string" ? args.trigger : "article",
          enabled: typeof args.enabled === "boolean" ? args.enabled : true,
          webhookConfigs: configs.length ? JSON.stringify(configs) : null,
          order,
        },
      });
      return ruleForMcp(rule);
    }
    case "feedferret.update_auto_read_rule": {
      const data: any = {};
      if (typeof args.name === "string") data.name = args.name.trim();
      if (typeof args.query === "string") data.query = args.query.trim();
      if (typeof args.scope === "string") data.scope = args.scope;
      if (typeof args.trigger === "string") data.trigger = args.trigger;
      if (typeof args.enabled === "boolean") data.enabled = args.enabled;
      if (typeof args.order === "number") data.order = args.order;
      const nextActions = Array.isArray(args.actions) ? args.actions.filter((a: unknown) => typeof a === "string") : null;
      if (nextActions) data.actions = JSON.stringify(nextActions);
      if (data.query !== undefined || nextActions) {
        const current = await db.autoReadRule.findFirst({ where: { id: String(args.ruleId), userId: user.id } });
        if (!current) throw new Error("Rule not found");
        if (ruleHasAiDeleteConflict(data.query ?? current.query, nextActions ?? parseRuleActions(current))) {
          throw new Error(AI_OPERATOR_DELETE_ERROR);
        }
      }
      if (args.webhookConfigs !== undefined) {
        // Keep-if-unchanged: entries sent back with their `secretRef` keep the stored secret / masked headers.
        const stored = await db.autoReadRule.findFirst({ where: { id: String(args.ruleId), userId: user.id }, select: { webhookConfigs: true } });
        if (!stored) throw new Error("Rule not found");
        const { configs, valid } = sanitizeWebhookConfigs(args.webhookConfigs, { existing: stored.webhookConfigs });
        if (!valid) throw new Error("Each webhook needs a valid http(s) URL");
        if (nextActions && !actionsReferenceConfigs(nextActions, configs.length)) throw new Error("A webhook_call action references a missing webhook config");
        data.webhookConfigs = configs.length ? JSON.stringify(configs) : null;
      }
      const result = await db.autoReadRule.updateMany({ where: { id: String(args.ruleId), userId: user.id }, data });
      if (!result.count) throw new Error("Rule not found");
      return ruleForMcp(await db.autoReadRule.findFirst({ where: { id: String(args.ruleId), userId: user.id } }));
    }
    case "feedferret.delete_auto_read_rule": {
      const result = await db.autoReadRule.deleteMany({ where: { id: String(args.ruleId), userId: user.id } });
      if (!result.count) throw new Error("Rule not found");
      return { deleted: true, id: String(args.ruleId) };
    }
    // Notifications & stats
    case "feedferret.list_notifications": {
      const where: any = { userId: user.id };
      if (typeof args.isRead === "boolean") where.isRead = args.isRead;
      const limit = Math.min(100, Math.max(1, clampInt(args.limit, 50, 1, 100)));
      return db.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: limit });
    }
    case "feedferret.discover_feeds": {
      const query = typeof args.query === "string" ? args.query.trim().slice(0, 2000) : "";
      if (!query) throw new Error("query is required");
      const locale = typeof args.locale === "string" ? args.locale.slice(0, 10) : null;
      if (!checkRateLimit(`user:${user.id}`, RATE_LIMITS.urlDiscover).success) throw new Error("Rate limit exceeded for feed discovery");
      const { mode, feeds } = await discoverFeeds(query, { locale });
      return { mode, feeds };
    }
    case "feedferret.import_opml": {
      const xml = typeof args.xml === "string" ? args.xml : "";
      if (!xml) throw new Error("xml is required");
      if (!checkRateLimit(`user:${user.id}`, RATE_LIMITS.opmlImport).success) throw new Error("Rate limit exceeded for OPML import");
      try {
        return await importOpmlXml(user.id, xml, { dryRun: args.dryRun === true });
      } catch (error) {
        if (error instanceof OpmlImportInputError || error instanceof OpmlParseError) throw new Error(error.message);
        throw error;
      }
    }
    case "feedferret.list_connectors": {
      const [rsshub, changedetection] = await Promise.all([isRsshubConfigured(), isChangedetectionConfigured()]);
      return { rsshub: { configured: rsshub }, changedetection: { configured: changedetection } };
    }
    case "feedferret.create_rsshub_feed": {
      const routePath = typeof args.routePath === "string" ? args.routePath.trim() : "";
      if (!routePath) throw new Error("routePath is required");
      const config = await getRsshubConfig();
      if (!config) throw new Error("RSSHub is not configured on this server");
      const validation = await validateRsshubRoute(config, routePath);
      if (!validation.ok) throw new Error(`RSSHub route did not validate: ${validation.reason}`);
      return createFeedForUser(user.id, buildRsshubPublicRouteUrl(config, routePath), {
        name: args.name,
        categoryId: args.categoryId,
        fallbackName: validation.title ?? undefined,
        sync: args.sync !== false,
      });
    }
    case "feedferret.create_changedetection_feed": {
      const url = mcpUrlArg(args.url);
      const config = await getChangedetectionConfig();
      if (!config) throw new Error("changedetection.io is not configured on this server");
      const watch = await createWatch(config, { url });
      if (!watch.ok) throw new Error(`Could not create changedetection.io watch: ${watch.reason}`);
      // The watch feed is empty until changedetection has checked twice, so
      // don't sync on create unless explicitly requested.
      return createFeedForUser(user.id, buildWatchFeedPublicUrl(config, watch.uuid), {
        name: args.name || url,
        categoryId: args.categoryId,
        sync: args.sync === true,
      });
    }
    case "feedferret.suggest_page_feed": {
      const url = mcpUrlArg(args.url);
      const { candidates, rejected } = await fetchAndSuggestFeedCandidatesDetailed(url);
      return {
        rejected,
        candidates: candidates.map((c) => ({ config: c.config, score: c.score, itemCount: c.itemCount, sampleTitles: c.sampleTitles, quality: c.quality })),
      };
    }
    case "feedferret.create_page_feed": {
      const url = mcpUrlArg(args.url);
      let config = args.config;
      if (!config || typeof config !== "object" || typeof config.xPathItem !== "string" || !config.xPathItem.trim()) {
        const top = await suggestTopPageFeed(url);
        config = top.config;
        if (!config) throw new Error(noPageFeedCandidateMessage(top.rejected));
      }
      const feed = await createPageFeedForUser(user.id, {
        url,
        config,
        name: typeof args.name === "string" ? args.name : undefined,
        categoryId: typeof args.categoryId === "string" ? args.categoryId : undefined,
        sync: args.sync,
      });
      return clientFeed(feed);
    }
    case "feedferret.get_stats": {
      const [totalFeeds, totalArticles, unreadArticles, starredArticles, readLaterArticles, totalLabels, totalCategories, totalSavedSearches, totalKeywordAlerts, totalAutoReadRules, unreadNotifications] = await db.$transaction([
        db.feed.count({ where: { userId: user.id, archivedAt: null } }),
        db.article.count({ where: { userId: user.id } }),
        db.article.count({ where: { userId: user.id, isRead: false, feed: { archivedAt: null } } }),
        db.article.count({ where: { userId: user.id, isStarred: true } }),
        db.article.count({ where: { userId: user.id, isReadLater: true } }),
        db.label.count({ where: { userId: user.id } }),
        db.category.count({ where: { userId: user.id } }),
        db.savedSearch.count({ where: { userId: user.id } }),
        db.keywordAlert.count({ where: { userId: user.id } }),
        db.autoReadRule.count({ where: { userId: user.id } }),
        db.notification.count({ where: { userId: user.id, isRead: false } }),
      ]);
      return { totalFeeds, totalArticles, unreadArticles, starredArticles, readLaterArticles, totalLabels, totalCategories, totalSavedSearches, totalKeywordAlerts, totalAutoReadRules, unreadNotifications };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function GET() {
  return NextResponse.json({
    name: "FeedFerret MCP",
    version: "1.7.0",
    tools: tools.length,
    transport: "Streamable HTTP JSON-RPC",
    endpoint: "/api/mcp",
    auth: "Authorization: Bearer <FeedFerret API token>",
  });
}

export async function POST(request: Request) {
  const rlResult = checkRateLimit(getClientIdentifier(request), RATE_LIMITS.mcp);
  if (!rlResult.success) return rateLimitResponse(rlResult);

  const body = await readJson<any>(request);
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") return rpcError(body?.id, -32600, "Invalid JSON-RPC request");

  if (body.method === "initialize") {
    return rpc(body.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "feedferret", version: "1.0.0" },
    });
  }
  if (body.method === "notifications/initialized") return new NextResponse(null, { status: 202 });
  if (body.method === "tools/list") return rpc(body.id, { tools });

  const authResult = await requireApiUser(request);
  if (authResult instanceof NextResponse) return apiError("Unauthorized", 401);
  const user = authResult;

  if (body.method === "tools/call") {
    try {
      const name = body.params?.name;
      const args = body.params?.arguments || {};
      if (typeof name !== "string") return rpcError(body.id, -32602, "params.name is required");
      const result = await callTool(user, name, args);
      return rpc(body.id, textContent(result));
    } catch (error) {
      return rpc(body.id, { ...textContent(error instanceof Error ? error.message : String(error)), isError: true });
    }
  }

  return rpcError(body.id, -32601, `Method not found: ${body.method}`);
}
