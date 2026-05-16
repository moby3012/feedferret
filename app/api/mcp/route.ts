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
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function GET() {
  return NextResponse.json({
    name: "FeedFerret MCP",
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
