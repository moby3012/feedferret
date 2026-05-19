export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiError, clampInt, parseBool, readJson, requireApiUser, type ApiUser } from "@/lib/api-auth";
import { checkRateLimit, getClientIdentifier, rateLimitHeaders, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { buildAdvancedSearchWhere } from "@/lib/search";
import { fetchFeedArticles } from "@/lib/feed-fetcher";
import { syncFeed, syncUserFeeds } from "@/lib/rss-sync";
import { generateOpml, parseOpml, scraperConfigFromOutline, httpOptionsFromOutline, type OpmlOutline } from "@/lib/opml";
import { normalizeSourceType, stringifyNonEmpty } from "@/lib/feed-extraction";
import { validateFeedUrl, validateOpml } from "@/lib/validation";
import { logger } from "@/lib/logger";

const ARTICLE_INCLUDE = {
  feed: { select: { id: true, name: true, url: true, icon: true, category: { select: { id: true, name: true } } } },
  labels: { include: { label: true } },
} as const;

function articlePayload(article: any) {
  return {
    id: article.id,
    feedId: article.feedId,
    title: article.title,
    link: article.link,
    externalId: article.externalId,
    excerpt: article.excerpt,
    content: article.content,
    author: article.author,
    publishedAt: article.publishedAt,
    imageUrl: article.imageUrl,
    isRead: article.isRead,
    readAt: article.readAt,
    isStarred: article.isStarred,
    isReadLater: article.isReadLater,
    readLaterSavedAt: article.readLaterSavedAt,
    isDuplicate: article.isDuplicate,
    duplicateOf: article.duplicateOf,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
    feed: article.feed,
    labels: (article.labels || []).map((item: any) => item.label),
  };
}

function feedPayload(feed: any) {
  return {
    id: feed.id,
    url: feed.url,
    name: feed.name,
    icon: feed.icon,
    sourceType: feed.sourceType,
    htmlUrl: feed.htmlUrl,
    description: feed.description,
    priority: feed.priority,
    categoryId: feed.categoryId,
    category: feed.category || null,
    order: feed.order,
    updateFrequency: feed.updateFrequency,
    retentionDays: feed.retentionDays,
    keepMinArticles: feed.keepMinArticles,
    lastFetchedAt: feed.lastFetchedAt,
    lastStatus: feed.lastStatus,
    lastError: feed.lastError,
    customUserAgent: feed.customUserAgent,
    fetchTimeoutSecs: feed.fetchTimeoutSecs,
    sslVerify: feed.sslVerify,
    maxSizeKb: feed.maxSizeKb,
    fullTextSelector: feed.fullTextSelector,
    fullTextRemoveSelectors: feed.fullTextRemoveSelectors,
    autoFetchFullText: feed.autoFetchFullText,
    createdAt: feed.createdAt,
    updatedAt: feed.updatedAt,
    unreadCount: feed._count?.articles,
  };
}

function allowedString(value: unknown) {
  return typeof value === "string" ? value.trim() : undefined;
}

function parsePath(params: { path?: string[] }) {
  return params.path?.filter(Boolean) || [];
}

async function listArticles(user: ApiUser, request: Request) {
  const url = new URL(request.url);
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 200);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 100_000);
  const q = url.searchParams.get("q") || url.searchParams.get("search") || undefined;
  const where: any = { userId: user.id };

  const feedId = url.searchParams.get("feedId");
  const categoryId = url.searchParams.get("categoryId");
  const labelId = url.searchParams.get("labelId");
  const isRead = parseBool(url.searchParams.get("isRead"));
  const isStarred = parseBool(url.searchParams.get("isStarred"));
  const isReadLater = parseBool(url.searchParams.get("isReadLater"));
  const includeDuplicates = parseBool(url.searchParams.get("includeDuplicates")) ?? false;

  if (feedId) where.feedId = feedId;
  if (categoryId) where.feed = { ...(where.feed || {}), categoryId };
  if (labelId) where.labels = { some: { labelId, userId: user.id } };
  if (isRead !== undefined) where.isRead = isRead;
  if (isStarred !== undefined) where.isStarred = isStarred;
  if (isReadLater !== undefined) where.isReadLater = isReadLater;
  if (!includeDuplicates) where.NOT = { isDuplicate: true, duplicateOf: { not: null } };

  const after = url.searchParams.get("after");
  const before = url.searchParams.get("before");
  if (after || before) {
    where.publishedAt = {
      ...(after ? { gte: new Date(after) } : {}),
      ...(before ? { lte: new Date(before) } : {}),
    };
  }

  const advancedWhere = await buildAdvancedSearchWhere(user.id, q);
  if (Object.keys(advancedWhere).length) where.AND = [...(where.AND || []), advancedWhere];

  const sort = url.searchParams.get("sort") || "newest";
  const orderBy = sort === "oldest" ? { publishedAt: "asc" as const } : sort === "recentlyRead" ? { readAt: "desc" as const } : { publishedAt: "desc" as const };

  const [items, total] = await Promise.all([
    db.article.findMany({ where, include: ARTICLE_INCLUDE, orderBy, skip: offset, take: limit }),
    db.article.count({ where }),
  ]);

  return NextResponse.json({
    items: items.map(articlePayload),
    pagination: { limit, offset, total, nextOffset: offset + items.length < total ? offset + items.length : null },
  });
}

async function getArticle(user: ApiUser, articleId: string) {
  const article = await db.article.findFirst({ where: { id: articleId, userId: user.id }, include: ARTICLE_INCLUDE });
  if (!article) return apiError("Article not found", 404);
  return NextResponse.json(articlePayload(article));
}

async function patchArticle(user: ApiUser, articleId: string, request: Request) {
  const body = await readJson<any>(request);
  if (!body) return apiError("Invalid JSON body", 400);

  const data: any = {};
  if (typeof body.isRead === "boolean") {
    data.isRead = body.isRead;
    data.readAt = body.isRead ? new Date() : null;
  }
  if (typeof body.isStarred === "boolean") data.isStarred = body.isStarred;
  if (typeof body.isReadLater === "boolean") {
    data.isReadLater = body.isReadLater;
    data.readLaterSavedAt = body.isReadLater ? new Date() : null;
  }

  const article = await db.article.findFirst({ where: { id: articleId, userId: user.id }, select: { id: true } });
  if (!article) return apiError("Article not found", 404);

  await db.$transaction(async (tx) => {
    if (Object.keys(data).length) await tx.article.update({ where: { id: articleId }, data });
    if (Array.isArray(body.labelIds)) {
      const labels = await tx.label.findMany({ where: { userId: user.id, id: { in: body.labelIds.filter((id: unknown) => typeof id === "string") } }, select: { id: true } });
      await tx.articleLabel.deleteMany({ where: { userId: user.id, articleId } });
      for (const label of labels) await tx.articleLabel.create({ data: { userId: user.id, articleId, labelId: label.id } });
    }
  });

  const updated = await db.article.findFirst({ where: { id: articleId, userId: user.id }, include: ARTICLE_INCLUDE });
  return NextResponse.json(articlePayload(updated));
}

async function batchArticles(user: ApiUser, request: Request) {
  const body = await readJson<any>(request);
  if (!body) return apiError("Invalid JSON body", 400);
  const ids: string[] = Array.isArray(body.ids) ? body.ids.filter((id: unknown) => typeof id === "string") : [];
  if (ids.length === 0) return apiError("ids must be a non-empty array of strings", 400);
  if (ids.length > 200) return apiError("ids array must not exceed 200 items", 400);

  const action: string = typeof body.action === "string" ? body.action : "";
  const VALID_ACTIONS = ["read", "unread", "star", "unstar", "label"] as const;
  if (!VALID_ACTIONS.includes(action as (typeof VALID_ACTIONS)[number])) {
    return apiError(`action must be one of: ${VALID_ACTIONS.join(", ")}`, 400);
  }

  // Verify ownership in one query
  const owned = await db.article.findMany({ where: { id: { in: ids }, userId: user.id }, select: { id: true } });
  const ownedIds = owned.map((a) => a.id);
  if (ownedIds.length === 0) return apiError("No matching articles found", 404);

  let data: any = {};
  if (action === "read") { data = { isRead: true, readAt: new Date() }; }
  else if (action === "unread") { data = { isRead: false, readAt: null }; }
  else if (action === "star") { data = { isStarred: true }; }
  else if (action === "unstar") { data = { isStarred: false }; }
  else if (action === "label") {
    const labelIds: string[] = Array.isArray(body.labelIds) ? body.labelIds.filter((id: unknown) => typeof id === "string") : [];
    const validLabels = await db.label.findMany({ where: { userId: user.id, id: { in: labelIds } }, select: { id: true } });
    const validLabelIds = validLabels.map((l) => l.id);
    await db.$transaction([
      db.articleLabel.deleteMany({ where: { userId: user.id, articleId: { in: ownedIds } } }),
      ...ownedIds.flatMap((articleId) =>
        validLabelIds.map((labelId) => db.articleLabel.create({ data: { userId: user.id, articleId, labelId } }))
      ),
    ]);
    return NextResponse.json({ updated: ownedIds.length, notFound: ids.length - ownedIds.length });
  }

  const result = await db.article.updateMany({ where: { id: { in: ownedIds } }, data });
  return NextResponse.json({ updated: result.count, notFound: ids.length - ownedIds.length });
}

async function markAllRead(user: ApiUser, request: Request) {
  const body = (await readJson<any>(request)) || {};
  const where: any = { userId: user.id, isRead: false };
  if (typeof body.feedId === "string") where.feedId = body.feedId;
  if (typeof body.categoryId === "string") where.feed = { categoryId: body.categoryId };
  if (typeof body.labelId === "string") where.labels = { some: { labelId: body.labelId, userId: user.id } };
  if (typeof body.query === "string" && body.query.trim()) {
    const advancedWhere = await buildAdvancedSearchWhere(user.id, body.query);
    if (Object.keys(advancedWhere).length) where.AND = [...(where.AND || []), advancedWhere];
  }
  const result = await db.article.updateMany({ where, data: { isRead: true, readAt: new Date() } });
  return NextResponse.json({ updated: result.count });
}

async function listFeeds(user: ApiUser) {
  const feeds = await db.feed.findMany({
    where: { userId: user.id },
    include: { category: true, _count: { select: { articles: { where: { isRead: false } } } } },
    orderBy: [{ order: "asc" }, { name: "asc" }],
  });
  return NextResponse.json({ items: feeds.map(feedPayload) });
}

async function createFeed(user: ApiUser, request: Request) {
  const body = await readJson<any>(request);
  const url = allowedString(body?.url);
  if (!url) return apiError("url is required", 400);
  const urlError = validateFeedUrl(url);
  if (urlError) return apiError(urlError, 400);

  const remoteFeed = await fetchFeedArticles({ url });
  const order = await db.feed.count({ where: { userId: user.id } });
  const feed = await db.feed.create({
    data: {
      userId: user.id,
      url,
      name: allowedString(body?.name) || remoteFeed.title || url,
      categoryId: allowedString(body?.categoryId),
      icon: allowedString(body?.icon) || "📰",
      order,
      lastStatus: "pending",
    },
    include: { category: true },
  });

  if (body?.sync !== false) await syncFeed(user.id, feed.id).catch((error) => logger.error("[api/v1] initial feed sync failed", error));
  const fresh = await db.feed.findFirst({ where: { id: feed.id, userId: user.id }, include: { category: true } });
  return NextResponse.json(feedPayload(fresh), { status: 201 });
}

async function getFeed(user: ApiUser, feedId: string) {
  const feed = await db.feed.findFirst({ where: { id: feedId, userId: user.id }, include: { category: true } });
  if (!feed) return apiError("Feed not found", 404);
  return NextResponse.json(feedPayload(feed));
}

async function patchFeed(user: ApiUser, feedId: string, request: Request) {
  const body = await readJson<any>(request);
  if (!body) return apiError("Invalid JSON body", 400);
  const data: any = {};
  for (const key of ["name", "icon", "categoryId", "updateFrequency", "retentionDays", "keepMinArticles", "customUserAgent", "fetchTimeoutSecs", "sslVerify", "maxSizeKb", "fullTextSelector", "fullTextRemoveSelectors", "autoFetchFullText", "sourceType", "priority", "unicityCriteria", "unicityCriteriaForced", "scraperConfig", "httpOptions"] as const) {
    if (body[key] !== undefined) data[key] = body[key];
  }
  const result = await db.feed.updateMany({ where: { id: feedId, userId: user.id }, data });
  if (!result.count) return apiError("Feed not found", 404);
  const feed = await db.feed.findFirst({ where: { id: feedId, userId: user.id }, include: { category: true } });
  return NextResponse.json(feedPayload(feed));
}

async function deleteFeed(user: ApiUser, feedId: string) {
  const result = await db.feed.deleteMany({ where: { id: feedId, userId: user.id } });
  if (!result.count) return apiError("Feed not found", 404);
  return NextResponse.json({ deleted: true, id: feedId });
}

async function syncOneFeed(user: ApiUser, feedId: string) {
  const feed = await db.feed.findFirst({ where: { id: feedId, userId: user.id }, select: { id: true } });
  if (!feed) return apiError("Feed not found", 404);
  const result = await syncFeed(user.id, feedId);
  return NextResponse.json(result);
}

async function listCategories(user: ApiUser) {
  const items = await db.category.findMany({ where: { userId: user.id }, orderBy: [{ order: "asc" }, { name: "asc" }] });
  return NextResponse.json({ items });
}

async function createCategory(user: ApiUser, request: Request) {
  const body = await readJson<any>(request);
  const name = allowedString(body?.name);
  if (!name) return apiError("name is required", 400);
  const category = await db.category.create({ data: { userId: user.id, name, parentId: allowedString(body?.parentId), order: Number.isFinite(Number(body?.order)) ? Number(body.order) : 0 } });
  return NextResponse.json(category, { status: 201 });
}

async function patchCategory(user: ApiUser, categoryId: string, request: Request) {
  const body = await readJson<any>(request);
  if (!body) return apiError("Invalid JSON body", 400);
  const data: any = {};
  for (const key of ["name", "parentId", "order", "updateFrequency"] as const) if (body[key] !== undefined) data[key] = body[key];
  const result = await db.category.updateMany({ where: { id: categoryId, userId: user.id }, data });
  if (!result.count) return apiError("Category not found", 404);
  return NextResponse.json(await db.category.findFirst({ where: { id: categoryId, userId: user.id } }));
}

async function deleteCategory(user: ApiUser, categoryId: string) {
  const result = await db.category.deleteMany({ where: { id: categoryId, userId: user.id } });
  if (!result.count) return apiError("Category not found", 404);
  return NextResponse.json({ deleted: true, id: categoryId });
}

async function listLabels(user: ApiUser) {
  const items = await db.label.findMany({ where: { userId: user.id }, include: { _count: { select: { articles: true } } }, orderBy: { name: "asc" } });
  return NextResponse.json({ items });
}

async function createLabel(user: ApiUser, request: Request) {
  const body = await readJson<any>(request);
  const name = allowedString(body?.name);
  if (!name) return apiError("name is required", 400);
  const label = await db.label.create({ data: { userId: user.id, name, color: allowedString(body?.color) || "#3b82f6" } });
  return NextResponse.json(label, { status: 201 });
}

async function patchLabel(user: ApiUser, labelId: string, request: Request) {
  const body = await readJson<any>(request);
  if (!body) return apiError("Invalid JSON body", 400);
  const data: any = {};
  if (body.name !== undefined) data.name = allowedString(body.name);
  if (body.color !== undefined) data.color = allowedString(body.color);
  const result = await db.label.updateMany({ where: { id: labelId, userId: user.id }, data });
  if (!result.count) return apiError("Label not found", 404);
  return NextResponse.json(await db.label.findFirst({ where: { id: labelId, userId: user.id } }));
}

async function deleteLabel(user: ApiUser, labelId: string) {
  const result = await db.label.deleteMany({ where: { id: labelId, userId: user.id } });
  if (!result.count) return apiError("Label not found", 404);
  return NextResponse.json({ deleted: true, id: labelId });
}

async function listSavedSearches(user: ApiUser) {
  const items = await db.savedSearch.findMany({ where: { userId: user.id }, orderBy: [{ order: "asc" }, { name: "asc" }] });
  return NextResponse.json({ items });
}

async function createSavedSearch(user: ApiUser, request: Request) {
  const body = await readJson<any>(request);
  const name = allowedString(body?.name);
  const query = allowedString(body?.query);
  if (!name || !query) return apiError("name and query are required", 400);
  const item = await db.savedSearch.create({ data: { userId: user.id, name, query, order: Number.isFinite(Number(body?.order)) ? Number(body.order) : 0 } });
  return NextResponse.json(item, { status: 201 });
}

async function patchSavedSearch(user: ApiUser, searchId: string, request: Request) {
  const body = await readJson<any>(request);
  if (!body) return apiError("Invalid JSON body", 400);
  const data: any = {};
  for (const key of ["name", "query", "order"] as const) if (body[key] !== undefined) data[key] = key === "order" ? body[key] : allowedString(body[key]);
  const result = await db.savedSearch.updateMany({ where: { id: searchId, userId: user.id }, data });
  if (!result.count) return apiError("Saved search not found", 404);
  return NextResponse.json(await db.savedSearch.findFirst({ where: { id: searchId, userId: user.id } }));
}

async function deleteSavedSearch(user: ApiUser, searchId: string) {
  const result = await db.savedSearch.deleteMany({ where: { id: searchId, userId: user.id } });
  if (!result.count) return apiError("Saved search not found", 404);
  return NextResponse.json({ deleted: true, id: searchId });
}

async function setSavedSearchShare(user: ApiUser, searchId: string, request: Request) {
  const body = (await readJson<any>(request)) || {};
  const enabled = body.enabled !== false;
  const existing = await db.savedSearch.findFirst({ where: { id: searchId, userId: user.id }, select: { id: true, shareToken: true } });
  if (!existing) return apiError("Saved search not found", 404);
  const { randomBytes } = await import("crypto");
  const savedSearch = await db.savedSearch.update({
    where: { id: searchId },
    data: enabled ? { shareToken: existing.shareToken || randomBytes(24).toString("base64url"), sharedAt: new Date() } : { shareToken: null, sharedAt: null },
  });
  return NextResponse.json(savedSearch);
}

async function exportOpml(user: ApiUser) {
  const [feeds, categories] = await Promise.all([
    db.feed.findMany({ where: { userId: user.id }, include: { category: true }, orderBy: [{ category: { name: "asc" } }, { name: "asc" }] }),
    db.category.findMany({ where: { userId: user.id }, orderBy: [{ order: "asc" }, { name: "asc" }] }),
  ]);
  return new NextResponse(generateOpml(feeds, categories), { headers: { "content-type": "application/xml; charset=utf-8" } });
}

async function importOpml(user: ApiUser, request: Request) {
  const body = await readJson<any>(request);
  const xml = typeof body?.xml === "string" ? body.xml : null;
  if (!xml) return apiError("xml is required", 400);
  const opmlError = validateOpml(xml);
  if (opmlError) return apiError(opmlError, 400);
  const outlines = await parseOpml(xml);
  const report = { feedsAdded: 0, feedsUpdated: 0, categoriesAdded: 0, categoriesUpdated: 0, errors: [] as string[] };

  const getOrCreateCategory = async (name: string, parentId?: string | null, opmlUrl?: string | null) => {
    const existing = await db.category.findUnique({ where: { userId_name_parentId: { userId: user.id, name, parentId: (parentId || null) as any } } });
    const category = await db.category.upsert({
      where: { userId_name_parentId: { userId: user.id, name, parentId: (parentId || null) as any } },
      update: opmlUrl !== undefined ? { opmlUrl } : {},
      create: { userId: user.id, name, parentId: parentId || undefined, opmlUrl: opmlUrl || undefined },
    });
    if (existing) report.categoriesUpdated += 1;
    else report.categoriesAdded += 1;
    return category;
  };

  const processOutline = async (outline: OpmlOutline, categoryId?: string) => {
    if (outline.xmlUrl) {
      let targetCategoryId = categoryId;
      if (!targetCategoryId && outline.category) targetCategoryId = (await getOrCreateCategory(outline.category)).id;
      const scraperConfig = scraperConfigFromOutline(outline);
      const httpOptions = httpOptionsFromOutline(outline);
      const extensions = outline.extensions ?? {};
      const existing = await db.feed.findUnique({ where: { userId_url: { userId: user.id, url: outline.xmlUrl } } });
      await db.feed.upsert({
        where: { userId_url: { userId: user.id, url: outline.xmlUrl } },
        update: { name: outline.text, categoryId: targetCategoryId, sourceType: normalizeSourceType(outline.type), htmlUrl: outline.htmlUrl || null, description: outline.description || null, priority: extensions.priority || "main", unicityCriteria: extensions.unicityCriteria || "id", unicityCriteriaForced: extensions.unicityCriteriaForced === "true" || extensions.unicityCriteriaForced === "1", scraperConfig: stringifyNonEmpty(scraperConfig), httpOptions: stringifyNonEmpty(httpOptions) },
        create: { userId: user.id, url: outline.xmlUrl, name: outline.text, categoryId: targetCategoryId, sourceType: normalizeSourceType(outline.type), htmlUrl: outline.htmlUrl || null, description: outline.description || null, priority: extensions.priority || "main", unicityCriteria: extensions.unicityCriteria || "id", unicityCriteriaForced: extensions.unicityCriteriaForced === "true" || extensions.unicityCriteriaForced === "1", scraperConfig: stringifyNonEmpty(scraperConfig), httpOptions: stringifyNonEmpty(httpOptions) },
      });
      if (existing) report.feedsUpdated += 1;
      else report.feedsAdded += 1;
    } else if (outline.children) {
      const category = await getOrCreateCategory(outline.text, categoryId, outline.extensions?.opmlUrl ?? null);
      for (const child of outline.children) await processOutline(child, category.id);
    }
  };

  for (const outline of outlines) {
    try { await processOutline(outline); } catch (error) { report.errors.push(`${outline.text}: ${String(error)}`); }
  }
  return NextResponse.json(report);
}

function openApiSpec(request: Request) {
  const origin = new URL(request.url).origin;
  return NextResponse.json({
    openapi: "3.1.0",
    info: { title: "FeedFerret API", version: "1.0.0", description: "Public REST API for FeedFerret readers, automations and AI tools." },
    servers: [{ url: origin }],
    security: [{ bearerAuth: [] }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "FeedFerret API token" } } },
    paths: {
      "/api/v1/me": { get: { summary: "Current account" } },
      "/api/v1/articles": { get: { summary: "Search/list articles" } },
      "/api/v1/articles/{id}": { get: { summary: "Get article" }, patch: { summary: "Update read/star/read-later state and labels" } },
      "/api/v1/articles/mark-all-read": { post: { summary: "Bulk mark matching articles as read" } },
      "/api/v1/feeds": { get: { summary: "List feeds" }, post: { summary: "Add feed" } },
      "/api/v1/feeds/{id}": { get: { summary: "Get feed" }, patch: { summary: "Update feed" }, delete: { summary: "Delete feed" } },
      "/api/v1/feeds/{id}/sync": { post: { summary: "Sync one feed" } },
      "/api/v1/sync": { post: { summary: "Sync all feeds for the current user" } },
      "/api/v1/categories": { get: { summary: "List categories" }, post: { summary: "Create category" } },
      "/api/v1/categories/{id}": { patch: { summary: "Update category" }, delete: { summary: "Delete category" } },
      "/api/v1/labels": { get: { summary: "List labels" }, post: { summary: "Create label" } },
      "/api/v1/labels/{id}": { patch: { summary: "Update label" }, delete: { summary: "Delete label" } },
      "/api/v1/saved-searches": { get: { summary: "List saved searches" }, post: { summary: "Create saved search" } },
      "/api/v1/saved-searches/{id}": { patch: { summary: "Update saved search" }, delete: { summary: "Delete saved search" } },
      "/api/v1/saved-searches/{id}/share": { post: { summary: "Enable/disable public saved-search sharing" } },
      "/api/v1/opml": { get: { summary: "Export OPML" }, post: { summary: "Import OPML" } },
      "/api/v1/openapi.json": { get: { summary: "OpenAPI document" } },
    },
  });
}

async function handle(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const params = await context.params;
  const path = parsePath(params);
  const method = request.method.toUpperCase();

  if (method === "GET" && (path.join("/") === "openapi.json" || path.join("/") === "openapi")) return openApiSpec(request);

  const authResult = await requireApiUser(request);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  // Rate limiting: reads 200/min, writes 60/min (per user)
  const isWriteMethod = method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE";
  const rlConfig = isWriteMethod ? RATE_LIMITS.apiV1Write : RATE_LIMITS.apiV1Read;
  const rlResult = checkRateLimit(getClientIdentifier(request, user.id), rlConfig);
  if (!rlResult.success) return rateLimitResponse(rlResult);
  const rlHeaders = rateLimitHeaders(rlResult);

  // Wraps a Response with X-RateLimit-* headers
  const withRl = (res: Response) => {
    Object.entries(rlHeaders).forEach(([k, v]) => res.headers.set(k, v as string));
    return res;
  };

  // Scope enforcement: "read" tokens can only use safe GET endpoints
  if (user.tokenScope === "read" && isWriteMethod) {
    return withRl(apiError("Forbidden: read-only token cannot perform write operations", 403));
  }

  let res: Response;
  try {
    if (method === "GET" && path[0] === "me" && path.length === 1) res = NextResponse.json({ id: user.id, email: user.email, name: user.name, role: user.role, tokenScope: user.tokenScope ?? "session" });
    else if (path[0] === "articles") {
      if (method === "GET" && path.length === 1) res = await listArticles(user, request);
      else if (method === "POST" && path[1] === "mark-all-read") res = await markAllRead(user, request);
      else if (method === "POST" && path[1] === "batch") res = await batchArticles(user, request);
      else if (method === "GET" && path.length === 2) res = await getArticle(user, path[1]);
      else if (method === "PATCH" && path.length === 2) res = await patchArticle(user, path[1], request);
      else res = apiError("Not found", 404);
    } else if (path[0] === "feeds") {
      if (method === "GET" && path.length === 1) res = await listFeeds(user);
      else if (method === "POST" && path.length === 1) res = await createFeed(user, request);
      else if (method === "GET" && path.length === 2) res = await getFeed(user, path[1]);
      else if (method === "PATCH" && path.length === 2) res = await patchFeed(user, path[1], request);
      else if (method === "DELETE" && path.length === 2) res = await deleteFeed(user, path[1]);
      else if (method === "POST" && path.length === 3 && path[2] === "sync") res = await syncOneFeed(user, path[1]);
      else res = apiError("Not found", 404);
    } else if (path[0] === "categories") {
      if (method === "GET" && path.length === 1) res = await listCategories(user);
      else if (method === "POST" && path.length === 1) res = await createCategory(user, request);
      else if (method === "PATCH" && path.length === 2) res = await patchCategory(user, path[1], request);
      else if (method === "DELETE" && path.length === 2) res = await deleteCategory(user, path[1]);
      else res = apiError("Not found", 404);
    } else if (path[0] === "labels") {
      if (method === "GET" && path.length === 1) res = await listLabels(user);
      else if (method === "POST" && path.length === 1) res = await createLabel(user, request);
      else if (method === "PATCH" && path.length === 2) res = await patchLabel(user, path[1], request);
      else if (method === "DELETE" && path.length === 2) res = await deleteLabel(user, path[1]);
      else res = apiError("Not found", 404);
    } else if (path[0] === "saved-searches") {
      if (method === "GET" && path.length === 1) res = await listSavedSearches(user);
      else if (method === "POST" && path.length === 1) res = await createSavedSearch(user, request);
      else if (method === "PATCH" && path.length === 2) res = await patchSavedSearch(user, path[1], request);
      else if (method === "DELETE" && path.length === 2) res = await deleteSavedSearch(user, path[1]);
      else if (method === "POST" && path.length === 3 && path[2] === "share") res = await setSavedSearchShare(user, path[1], request);
      else res = apiError("Not found", 404);
    } else if (path[0] === "opml" && path.length === 1) {
      if (method === "GET") res = await exportOpml(user);
      else if (method === "POST") res = await importOpml(user, request);
      else res = apiError("Not found", 404);
    } else if (path[0] === "sync" && path.length === 1 && method === "POST") {
      const results = await syncUserFeeds(user.id);
      res = NextResponse.json({ success: true, synced: results.filter((r) => r.success && !r.skipped).length, total: results.length, results });
    } else {
      res = apiError("Not found", 404);
    }
  } catch (error) {
    logger.error("[api/v1]", error);
    res = apiError(error instanceof Error ? error.message : String(error), 500);
  }

  return withRl(res);
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
