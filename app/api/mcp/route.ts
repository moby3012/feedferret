export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiError, clampInt, readJson, requireApiUser, type ApiUser } from "@/lib/api-auth";
import { buildAdvancedSearchWhere } from "@/lib/search";
import { fetchFeedArticles } from "@/lib/feed-fetcher";
import { syncFeed, syncUserFeeds } from "@/lib/rss-sync";
import { checkRateLimit, getClientIdentifier, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

function rpc(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, data } }, { status: code === -32600 ? 400 : 200 });
}

function textContent(data: unknown) {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

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
  { name: "feedferret.update_article_state", description: "Update read/starred/read-later state on an article.", inputSchema: { type: "object", properties: { articleId: { type: "string" }, isRead: { type: "boolean" }, isStarred: { type: "boolean" }, isReadLater: { type: "boolean" } }, required: ["articleId"] } },
  { name: "feedferret.list_feeds", description: "List RSS feeds with category and unread counts.", inputSchema: { type: "object", properties: {} } },
  { name: "feedferret.add_feed", description: "Add a new RSS/Atom feed and optionally sync it immediately.", inputSchema: { type: "object", properties: { url: { type: "string" }, name: { type: "string" }, categoryId: { type: "string" }, sync: { type: "boolean" } }, required: ["url"] } },
  { name: "feedferret.sync_feeds", description: "Sync all feeds or one feed when feedId is supplied.", inputSchema: { type: "object", properties: { feedId: { type: "string" } } } },
  { name: "feedferret.list_categories", description: "List feed categories/folders.", inputSchema: { type: "object", properties: {} } },
  { name: "feedferret.list_labels", description: "List article labels/tags.", inputSchema: { type: "object", properties: {} } },
  { name: "feedferret.create_label", description: "Create a label/tag.", inputSchema: { type: "object", properties: { name: { type: "string" }, color: { type: "string" } }, required: ["name"] } },
  { name: "feedferret.mark_all_read", description: "Mark matching unread articles as read. Use with care.", inputSchema: { type: "object", properties: { query: { type: "string" }, feedId: { type: "string" }, categoryId: { type: "string" }, labelId: { type: "string" } } } },
  // Feed management
  { name: "feedferret.delete_feed", description: "Delete a feed and all its articles.", inputSchema: { type: "object", properties: { feedId: { type: "string" } }, required: ["feedId"] } },
  { name: "feedferret.update_feed", description: "Update feed metadata and fetch/reader options.", inputSchema: { type: "object", properties: { feedId: { type: "string" }, name: { type: "string" }, categoryId: { type: ["string", "null"] }, updateFrequency: { type: ["number", "null"] }, retentionDays: { type: ["number", "null"] }, priority: { type: "string" } }, required: ["feedId"] } },
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

async function callTool(user: ApiUser, name: string, args: any) {
  switch (name) {
    case "feedferret.search_articles":
      return searchArticles(user, args);
    case "feedferret.get_article":
      return db.article.findFirst({ where: { id: String(args.articleId), userId: user.id }, include: { feed: true, labels: { include: { label: true } } } });
    case "feedferret.update_article_state": {
      const data: any = {};
      if (typeof args.isRead === "boolean") { data.isRead = args.isRead; data.readAt = args.isRead ? new Date() : null; }
      if (typeof args.isStarred === "boolean") data.isStarred = args.isStarred;
      if (typeof args.isReadLater === "boolean") { data.isReadLater = args.isReadLater; data.readLaterSavedAt = args.isReadLater ? new Date() : null; }
      const updated = await db.article.updateMany({ where: { id: String(args.articleId), userId: user.id }, data });
      return { updated: updated.count };
    }
    case "feedferret.list_feeds":
      return db.feed.findMany({ where: { userId: user.id }, include: { category: true, _count: { select: { articles: { where: { isRead: false } } } } }, orderBy: [{ order: "asc" }, { name: "asc" }] });
    case "feedferret.add_feed": {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) throw new Error("url is required");
      const remoteFeed = await fetchFeedArticles({ url });
      const order = await db.feed.count({ where: { userId: user.id } });
      const feed = await db.feed.create({ data: { userId: user.id, url, name: typeof args.name === "string" ? args.name : remoteFeed.title || url, categoryId: typeof args.categoryId === "string" ? args.categoryId : undefined, icon: "📰", order } });
      if (args.sync !== false) await syncFeed(user.id, feed.id).catch(() => null);
      return feed;
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
      for (const key of ["name", "categoryId", "updateFrequency", "retentionDays", "priority"] as const) {
        if (args[key] !== undefined) data[key] = args[key];
      }
      const result = await db.feed.updateMany({ where: { id: String(args.feedId), userId: user.id }, data });
      if (!result.count) throw new Error("Feed not found");
      return db.feed.findFirst({ where: { id: String(args.feedId), userId: user.id }, include: { category: true } });
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
      const validLabelIds = validLabels.map((l) => l.id);
      await db.$transaction([
        db.articleLabel.deleteMany({ where: { userId: user.id, articleId } }),
        ...validLabelIds.map((labelId) => db.articleLabel.create({ data: { userId: user.id, articleId, labelId } })),
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
      const ownedIds = owned.map((a) => a.id);
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
    version: "1.1.0",
    tools: 28,
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
