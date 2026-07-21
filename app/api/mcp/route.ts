export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiError, clampInt, readJson, requireApiUser, type ApiUser } from "@/lib/api-auth";
import { buildAdvancedSearchWhere } from "@/lib/search";
import { fetchFeedArticles } from "@/lib/feed-fetcher";
import { syncFeed, syncUserFeeds } from "@/lib/rss-sync";
import { checkRateLimit, getClientIdentifier, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { refetchArticleFullText } from "@/lib/full-text-fetch";
import { isRsshubConfigured, getRsshubConfig, buildRsshubRouteUrl, validateRsshubRoute } from "@/lib/rsshub";
import { isChangedetectionConfigured, getChangedetectionConfig, createWatch, buildWatchFeedUrl } from "@/lib/changedetection";
import { fetchAndSuggestFeedCandidates } from "@/lib/page-feed-suggest";
import { createPageFeedForUser, suggestTopPageFeedConfig } from "@/lib/page-feed-create";

function rpc(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, data } }, { status: code === -32600 ? 400 : 200 });
}

function textContent(data: unknown) {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

// The per-feed HTTP Basic Auth password must never leave the server. Strip it
// from any feed object (or array of feed objects) before returning it to a client.
function stripFeedSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripFeedSecrets(item)) as T;
  if (value && typeof value === "object" && "authPassword" in (value as Record<string, unknown>)) {
    const { authPassword: _authPassword, ...rest } = value as Record<string, unknown>;
    return rest as T;
  }
  return value;
}

// Feed config fields an MCP client may set via update_feed / add_feed.
const FEED_WRITABLE_KEYS = [
  "name", "icon", "categoryId", "updateFrequency", "retentionDays", "keepMinArticles", "priority",
  // Fetch / HTTP options
  "customUserAgent", "fetchTimeoutSecs", "sslVerify", "maxSizeKb",
  // Per-feed HTTP auth (password is write-only: accepted, never serialized back)
  "authType", "authUsername", "authPassword",
  // Feed Intelligence / full-text extraction
  "fullTextMode", "fullTextSelector", "fullTextRemoveSelectors", "fullTextConditions", "autoFetchFullText", "defaultContentFormat",
  // Per-feed keyword content filter (newline-separated words → mark matching new articles read)
  "filtersActionRead",
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
  { name: "feedferret.list_feeds", description: "List RSS feeds with category, unread counts and full per-feed configuration (fetch/HTTP options, full-text settings, reader/display overrides, health). The auth password is never included.", inputSchema: { type: "object", properties: {} } },
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
        updateFrequency: { type: ["number", "null"], description: "Refresh interval in minutes; null = inherit default." },
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
        filtersActionRead: { type: ["string", "null"], description: "Newline-separated keywords; new articles containing any are marked read on arrival." },
        // Per-feed display overrides (null = inherit the user default)
        hideArticleImage: { type: ["boolean", "null"] },
        hideFromAllFeeds: { type: ["boolean", "null"] },
        readerFontSizeOverride: { type: ["string", "null"] },
        readerWidthOverride: { type: ["string", "null"] },
        openOriginalOverride: { type: ["boolean", "null"] },
        // Muting
        autoMuted: { type: "boolean", description: "Mute/unmute the feed (suppresses notifications & unread counting)." },
      },
      required: ["feedId"],
    },
  },
  // Category management
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
  // Notifications & stats
  { name: "feedferret.list_notifications", description: "List user notifications ordered by newest first.", inputSchema: { type: "object", properties: { isRead: { type: "boolean" }, limit: { type: "number", minimum: 1, maximum: 100 } } } },
  { name: "feedferret.get_stats", description: "Get aggregate stats for the current user.", inputSchema: { type: "object", properties: {} } },
  // Connectors
  { name: "feedferret.list_connectors", description: "List server-configured connectors (RSSHub, changedetection.io) and whether each is available. Useful to discover what connector-backed feeds can be created on this server.", inputSchema: { type: "object", properties: {} } },
  { name: "feedferret.create_rsshub_feed", description: "Create a feed from an RSSHub route path (e.g. '/github/trending/daily/any'). The route is validated against the server's configured RSSHub instance before the feed is created. Requires the RSSHub connector to be configured.", inputSchema: { type: "object", properties: { routePath: { type: "string", description: "RSSHub route path, e.g. '/github/issue/DIYgod/RSSHub'." }, name: { type: "string" }, categoryId: { type: "string" }, sync: { type: "boolean" } }, required: ["routePath"] } },
  { name: "feedferret.create_changedetection_feed", description: "Create a changedetection.io watch for a web page URL and add it as a feed. The feed stays empty until changedetection has checked the page at least twice. Requires the changedetection.io connector to be configured.", inputSchema: { type: "object", properties: { url: { type: "string" }, name: { type: "string" }, categoryId: { type: "string" }, sync: { type: "boolean" } }, required: ["url"] } },
  { name: "feedferret.suggest_page_feed", description: "Given an arbitrary web page URL, heuristically detect repeating item lists and return candidate feed configs (XPath selectors) with scores and sample titles. Use before create_page_feed to inspect/choose, or call create_page_feed directly to auto-pick the best candidate.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "feedferret.create_page_feed", description: "Create an HTML+XPath feed from an arbitrary web page. Pass a `config` (as returned by suggest_page_feed) to use it, or omit it to auto-pick the top-scoring detected candidate. Fails if no repeating item list is found and no config is given.", inputSchema: { type: "object", properties: { url: { type: "string" }, config: { type: "object", description: "XPath field config: { xPathItem (required), xPathItemTitle?, xPathItemUri?, xPathItemContent?, xPathItemTimestamp?, xPathItemThumbnail? }.", properties: { xPathItem: { type: "string" }, xPathItemTitle: { type: "string" }, xPathItemUri: { type: "string" }, xPathItemContent: { type: "string" }, xPathItemTimestamp: { type: "string" }, xPathItemThumbnail: { type: "string" } } }, name: { type: "string" }, categoryId: { type: "string" }, sync: { type: "boolean" } }, required: ["url"] } },
];

async function searchArticles(user: ApiUser, args: any) {
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
  return db.article.findMany({
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
}

// Shared feed-creation core for the MCP add-feed + connector-feed tools. The
// URL is already validated/resolved by the caller. A fetch failure never blocks
// creation (the feed lands "pending" and its health carries the error).
async function createFeedForUser(
  userId: string,
  url: string,
  opts: { name?: unknown; categoryId?: unknown; icon?: unknown; fallbackName?: string; sync?: boolean },
) {
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
  return stripFeedSecrets(fresh);
}

async function callTool(user: ApiUser, name: string, args: any) {
  switch (name) {
    case "feedferret.search_articles":
      return searchArticles(user, args);
    case "feedferret.get_article": {
      const article = await db.article.findFirst({ where: { id: String(args.articleId), userId: user.id }, include: { feed: true, labels: { include: { label: true } } } });
      if (article && (article as any).feed) (article as any).feed = stripFeedSecrets((article as any).feed);
      return article;
    }
    case "feedferret.fetch_full_text": {
      const { article, suggestAutoFullText } = await refetchArticleFullText(user.id, String(args.articleId));
      if ((article as any).feed) (article as any).feed = stripFeedSecrets((article as any).feed);
      return { ...article, suggestAutoFullText };
    }
    case "feedferret.update_article_state": {
      const data: any = {};
      if (typeof args.isRead === "boolean") { data.isRead = args.isRead; data.readAt = args.isRead ? new Date() : null; }
      if (typeof args.isStarred === "boolean") data.isStarred = args.isStarred;
      if (typeof args.isReadLater === "boolean") { data.isReadLater = args.isReadLater; data.readLaterSavedAt = args.isReadLater ? new Date() : null; }
      const updated = await db.article.updateMany({ where: { id: String(args.articleId), userId: user.id }, data });
      return { updated: updated.count };
    }
    case "feedferret.list_feeds":
      return stripFeedSecrets(await db.feed.findMany({ where: { userId: user.id }, include: { category: true, _count: { select: { articles: { where: { isRead: false } } } } }, orderBy: [{ order: "asc" }, { name: "asc" }] }));
    case "feedferret.get_feed": {
      const feed = await db.feed.findFirst({ where: { id: String(args.feedId), userId: user.id }, include: { category: true, _count: { select: { articles: { where: { isRead: false } } } } } });
      if (!feed) throw new Error("Feed not found");
      return stripFeedSecrets(feed);
    }
    case "feedferret.add_feed": {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) throw new Error("url is required");
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
      const result = await db.article.updateMany({ where, data: { isRead: true, readAt: new Date() } });
      return { updated: result.count };
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
      const result = await db.feed.updateMany({ where: { id: String(args.feedId), userId: user.id }, data });
      if (!result.count) throw new Error("Feed not found");
      const feed = await db.feed.findFirst({ where: { id: String(args.feedId), userId: user.id }, include: { category: true, _count: { select: { articles: { where: { isRead: false } } } } } });
      return stripFeedSecrets(feed);
    }
    // Category management
    case "feedferret.create_category": {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) throw new Error("name is required");
      return db.category.create({ data: { userId: user.id, name, parentId: typeof args.parentId === "string" ? args.parentId : undefined } });
    }
    case "feedferret.update_category": {
      const data: any = {};
      if (typeof args.name === "string") data.name = args.name.trim();
      if (args.parentId !== undefined) data.parentId = args.parentId;
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
      let data: any = {};
      if (action === "read") { data = { isRead: true, readAt: new Date() }; }
      else if (action === "unread") { data = { isRead: false, readAt: null }; }
      else if (action === "star") { data = { isStarred: true }; }
      else if (action === "unstar") { data = { isStarred: false }; }
      const result = await db.article.updateMany({ where: { id: { in: ownedIds } }, data });
      return { updated: result.count, notFound: ids.length - ownedIds.length };
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
    // Notifications & stats
    case "feedferret.list_notifications": {
      const where: any = { userId: user.id };
      if (typeof args.isRead === "boolean") where.isRead = args.isRead;
      const limit = Math.min(100, Math.max(1, clampInt(args.limit, 50, 1, 100)));
      return db.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: limit });
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
      return createFeedForUser(user.id, buildRsshubRouteUrl(config, routePath), {
        name: args.name,
        categoryId: args.categoryId,
        fallbackName: validation.title ?? undefined,
        sync: args.sync !== false,
      });
    }
    case "feedferret.create_changedetection_feed": {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) throw new Error("url is required");
      const config = await getChangedetectionConfig();
      if (!config) throw new Error("changedetection.io is not configured on this server");
      const watch = await createWatch(config, { url });
      if (!watch.ok) throw new Error(`Could not create changedetection.io watch: ${watch.reason}`);
      // The watch feed is empty until changedetection has checked twice, so
      // don't sync on create unless explicitly requested.
      return createFeedForUser(user.id, buildWatchFeedUrl(config, watch.uuid), {
        name: args.name || url,
        categoryId: args.categoryId,
        sync: args.sync === true,
      });
    }
    case "feedferret.suggest_page_feed": {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) throw new Error("url is required");
      const candidates = await fetchAndSuggestFeedCandidates(url);
      return {
        candidates: candidates.map((c) => ({ config: c.config, score: c.score, itemCount: c.itemCount, sampleTitles: c.sampleTitles })),
      };
    }
    case "feedferret.create_page_feed": {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) throw new Error("url is required");
      let config = args.config;
      if (!config || typeof config !== "object" || typeof config.xPathItem !== "string" || !config.xPathItem.trim()) {
        config = await suggestTopPageFeedConfig(url);
        if (!config) throw new Error("No feed-like repeating items found on that page; provide an explicit config with xPathItem");
      }
      const feed = await createPageFeedForUser(user.id, {
        url,
        config,
        name: typeof args.name === "string" ? args.name : undefined,
        categoryId: typeof args.categoryId === "string" ? args.categoryId : undefined,
        sync: args.sync,
      });
      return stripFeedSecrets(feed);
    }
    case "feedferret.get_stats": {
      const [totalFeeds, totalArticles, unreadArticles, starredArticles, readLaterArticles, totalLabels, totalCategories, totalSavedSearches, totalKeywordAlerts, totalAutoReadRules, unreadNotifications] = await db.$transaction([
        db.feed.count({ where: { userId: user.id } }),
        db.article.count({ where: { userId: user.id } }),
        db.article.count({ where: { userId: user.id, isRead: false } }),
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
    version: "1.6.0",
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
