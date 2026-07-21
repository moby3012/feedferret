export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiError, clampInt, parseBool, readJson, requireApiUser, scopeError, type ApiUser } from "@/lib/api-auth";
import { checkRateLimit, getClientIdentifier, rateLimitHeaders, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { buildAdvancedSearchWhere } from "@/lib/search";
import { fetchFeedArticles } from "@/lib/feed-fetcher";
import { syncFeed, syncUserFeeds } from "@/lib/rss-sync";
import { generateOpml, parseOpml, scraperConfigFromOutline, httpOptionsFromOutline, type OpmlOutline } from "@/lib/opml";
import { normalizeSourceType, stringifyNonEmpty } from "@/lib/feed-extraction";
import { validateFeedUrl, validateOpml } from "@/lib/validation";
import { logger } from "@/lib/logger";
import { renderMarkdownToHtml } from "@/lib/markdown-render";
import { refetchArticleFullText } from "@/lib/full-text-fetch";
import { isRsshubConfigured, getRsshubConfig, buildRsshubRouteUrl, validateRsshubRoute } from "@/lib/rsshub";
import { isChangedetectionConfigured, getChangedetectionConfig, createWatch, buildWatchFeedUrl } from "@/lib/changedetection";
import { fetchAndSuggestFeedCandidates } from "@/lib/page-feed-suggest";
import { createPageFeedForUser, suggestTopPageFeedConfig } from "@/lib/page-feed-create";

const ARTICLE_INCLUDE = {
  feed: { select: { id: true, name: true, url: true, icon: true, category: { select: { id: true, name: true } } } },
  labels: { include: { label: true } },
} as const;

async function articlePayload(article: any) {
  const content =
    article.contentFormat === "markdown" && article.content
      ? await renderMarkdownToHtml(article.content)
      : article.content;
  return {
    id: article.id,
    feedId: article.feedId,
    title: article.title,
    link: article.link,
    externalId: article.externalId,
    excerpt: article.excerpt,
    content,
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
    consecutiveFailureCount: feed.consecutiveFailureCount,
    autoMuted: feed.autoMuted,
    customUserAgent: feed.customUserAgent,
    fetchTimeoutSecs: feed.fetchTimeoutSecs,
    sslVerify: feed.sslVerify,
    maxSizeKb: feed.maxSizeKb,
    // Per-feed auth: type/username are exposed; the password never is.
    authType: feed.authType,
    authUsername: feed.authUsername,
    // Full-text / Feed Intelligence
    fullTextMode: feed.fullTextMode,
    fullTextSelector: feed.fullTextSelector,
    fullTextRemoveSelectors: feed.fullTextRemoveSelectors,
    fullTextConditions: feed.fullTextConditions,
    autoFetchFullText: feed.autoFetchFullText,
    defaultContentFormat: feed.defaultContentFormat,
    // Per-feed keyword content filter: newline-separated words that mark
    // matching new articles read on arrival.
    filtersActionRead: feed.filtersActionRead,
    // Per-feed display overrides (null = inherit the user default)
    hideArticleImage: feed.hideArticleImage,
    hideFromAllFeeds: feed.hideFromAllFeeds,
    readerFontSizeOverride: feed.readerFontSizeOverride,
    readerWidthOverride: feed.readerWidthOverride,
    openOriginalOverride: feed.openOriginalOverride,
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
    items: await Promise.all(items.map(articlePayload)),
    pagination: { limit, offset, total, nextOffset: offset + items.length < total ? offset + items.length : null },
  });
}

async function getArticle(user: ApiUser, articleId: string) {
  const article = await db.article.findFirst({ where: { id: articleId, userId: user.id }, include: ARTICLE_INCLUDE });
  if (!article) return apiError("Article not found", 404);
  return NextResponse.json(await articlePayload(article));
}

async function fetchArticleFullText(user: ApiUser, articleId: string) {
  try {
    const { article, suggestAutoFullText } = await refetchArticleFullText(user.id, articleId);
    return NextResponse.json({ ...(await articlePayload(article)), suggestAutoFullText });
  } catch (error) {
    // The shared helper throws clean, user-facing messages ("Article not found",
    // "Article has no source link", anti-bot block, "could not improve", …).
    const message = error instanceof Error ? error.message : "Could not fetch full text";
    const status = /not found/i.test(message) ? 404 : 422;
    return apiError(message, status);
  }
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
  return NextResponse.json(await articlePayload(updated));
}

async function batchArticles(user: ApiUser, request: Request) {
  const body = await readJson<any>(request);
  if (!body) return apiError("Invalid JSON body", 400);

  const ids: string[] = Array.isArray(body.ids) ? body.ids.filter((id: unknown) => typeof id === "string") : [];
  if (ids.length === 0) return apiError("ids must be a non-empty array of strings", 400);
  if (ids.length > 500) return apiError("ids array must not exceed 500 items", 400);

  const action: string = typeof body.action === "string" ? body.action : "";
  const VALID_ACTIONS = ["read", "unread", "star", "unstar", "label", "unlabel", "read_later", "remove_read_later"] as const;
  if (!VALID_ACTIONS.includes(action as (typeof VALID_ACTIONS)[number])) {
    return apiError(`action must be one of: ${VALID_ACTIONS.join(", ")}`, 400);
  }

  if ((action === "label" || action === "unlabel") && typeof body.labelId !== "string") {
    return apiError("labelId is required for label/unlabel actions", 400);
  }

  // Filter to only articles belonging to the authenticated user
  const owned = await db.article.findMany({ where: { id: { in: ids }, userId: user.id }, select: { id: true } });
  const ownedIds = owned.map((a) => a.id);
  if (ownedIds.length === 0) return apiError("No matching articles found", 404);

  if (action === "label") {
    // Verify the label belongs to the user
    const label = await db.label.findFirst({ where: { id: body.labelId, userId: user.id }, select: { id: true } });
    if (!label) return apiError("Label not found", 404);
    // Find which article-label pairs already exist to skip duplicates (SQLite does not support createMany skipDuplicates)
    const existing = await db.articleLabel.findMany({ where: { labelId: body.labelId, articleId: { in: ownedIds } }, select: { articleId: true } });
    const existingSet = new Set(existing.map((e) => e.articleId));
    const toCreate = ownedIds.filter((id) => !existingSet.has(id));
    if (toCreate.length > 0) {
      await db.articleLabel.createMany({ data: toCreate.map((articleId) => ({ userId: user.id, articleId, labelId: body.labelId })) });
    }
    return NextResponse.json({ updated: ownedIds.length });
  }

  if (action === "unlabel") {
    const result = await db.articleLabel.deleteMany({ where: { userId: user.id, articleId: { in: ownedIds }, labelId: body.labelId } });
    return NextResponse.json({ updated: result.count });
  }

  let data: any = {};
  if (action === "read") { data = { isRead: true, readAt: new Date() }; }
  else if (action === "unread") { data = { isRead: false, readAt: null }; }
  else if (action === "star") { data = { isStarred: true }; }
  else if (action === "unstar") { data = { isStarred: false }; }
  else if (action === "read_later") { data = { isReadLater: true, readLaterSavedAt: new Date() }; }
  else if (action === "remove_read_later") { data = { isReadLater: false, readLaterSavedAt: null }; }

  const result = await db.article.updateMany({ where: { id: { in: ownedIds } }, data });
  return NextResponse.json({ updated: result.count });
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

// Shared feed-creation core: create a feed row for `url` (already validated by
// the caller), optionally sync it, and return the serialized feed. Used by the
// plain add-feed endpoint and by the connector-backed create endpoints, which
// resolve a connector-specific URL first. The feed title is taken from the
// remote feed when reachable, else the caller's fallback, else the URL — a
// fetch failure never blocks creation (the feed lands in "pending" and its
// health surfaces the error, matching the UI's add-feed behavior).
async function createFeedFromUrl(
  user: ApiUser,
  url: string,
  opts: { name?: string; categoryId?: string; icon?: string; sync?: boolean; fallbackName?: string },
) {
  const remoteFeed = await fetchFeedArticles({ url }).catch(() => null);
  const order = await db.feed.count({ where: { userId: user.id } });
  const feed = await db.feed.create({
    data: {
      userId: user.id,
      url,
      name: opts.name || remoteFeed?.title || opts.fallbackName || url,
      categoryId: opts.categoryId,
      icon: opts.icon || "📰",
      order,
      lastStatus: "pending",
    },
    include: { category: true },
  });

  if (opts.sync !== false) await syncFeed(user.id, feed.id).catch((error) => logger.error("[api/v1] initial feed sync failed", error));
  const fresh = await db.feed.findFirst({ where: { id: feed.id, userId: user.id }, include: { category: true } });
  return NextResponse.json(feedPayload(fresh), { status: 201 });
}

async function createFeed(user: ApiUser, request: Request) {
  const body = await readJson<any>(request);
  const url = allowedString(body?.url);
  if (!url) return apiError("url is required", 400);
  const urlError = validateFeedUrl(url);
  if (urlError) return apiError(urlError, 400);

  return createFeedFromUrl(user, url, {
    name: allowedString(body?.name),
    categoryId: allowedString(body?.categoryId),
    icon: allowedString(body?.icon),
    sync: body?.sync,
  });
}

async function createRsshubFeed(user: ApiUser, request: Request) {
  const body = await readJson<any>(request);
  const routePath = allowedString(body?.routePath);
  if (!routePath) return apiError("routePath is required", 400);

  const config = await getRsshubConfig();
  if (!config) return apiError("RSSHub is not configured on this server", 400);

  const validation = await validateRsshubRoute(config, routePath);
  if (!validation.ok) return apiError(`RSSHub route did not validate: ${validation.reason}`, 422);

  return createFeedFromUrl(user, buildRsshubRouteUrl(config, routePath), {
    name: allowedString(body?.name),
    categoryId: allowedString(body?.categoryId),
    icon: allowedString(body?.icon),
    sync: body?.sync,
    fallbackName: validation.title ?? undefined,
  });
}

async function createChangedetectionFeed(user: ApiUser, request: Request) {
  const body = await readJson<any>(request);
  const url = allowedString(body?.url);
  if (!url) return apiError("url is required", 400);
  const urlError = validateFeedUrl(url);
  if (urlError) return apiError(urlError, 400);

  const config = await getChangedetectionConfig();
  if (!config) return apiError("changedetection.io is not configured on this server", 400);

  const watch = await createWatch(config, { url });
  if (!watch.ok) return apiError(`Could not create changedetection.io watch: ${watch.reason}`, 422);

  // A changedetection watch feed has no items until at least two checks have
  // run, so we skip the initial sync (there is nothing to fetch yet) unless the
  // caller explicitly asks for it.
  return createFeedFromUrl(user, buildWatchFeedUrl(config, watch.uuid), {
    name: allowedString(body?.name) || url,
    categoryId: allowedString(body?.categoryId),
    icon: allowedString(body?.icon),
    sync: body?.sync === true,
  });
}

async function suggestPageFeed(_user: ApiUser, request: Request) {
  const body = await readJson<any>(request);
  const url = allowedString(body?.url);
  if (!url) return apiError("url is required", 400);
  const urlError = validateFeedUrl(url);
  if (urlError) return apiError(urlError, 400);

  const candidates = await fetchAndSuggestFeedCandidates(url);
  return NextResponse.json({
    candidates: candidates.map((c) => ({
      config: c.config,
      score: c.score,
      itemCount: c.itemCount,
      sampleTitles: c.sampleTitles,
    })),
  });
}

async function createPageFeed(user: ApiUser, request: Request) {
  const body = await readJson<any>(request);
  const url = allowedString(body?.url);
  if (!url) return apiError("url is required", 400);
  const urlError = validateFeedUrl(url);
  if (urlError) return apiError(urlError, 400);

  // Use the caller's explicit config when given; otherwise auto-pick the
  // top-scoring candidate so a URL alone is enough to build a page-feed.
  let config = body?.config;
  if (!config || typeof config !== "object" || !allowedString(config.xPathItem)) {
    config = await suggestTopPageFeedConfig(url);
    if (!config) return apiError("No feed-like repeating items found on that page; provide an explicit config with xPathItem", 422);
  }

  try {
    const feed = await createPageFeedForUser(user.id, {
      url,
      config,
      name: allowedString(body?.name),
      categoryId: allowedString(body?.categoryId),
      sync: body?.sync,
    });
    return NextResponse.json(feedPayload(feed), { status: 201 });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : "Could not create feed from that page", 422);
  }
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
  for (const key of [
    "name", "icon", "categoryId", "updateFrequency", "retentionDays", "keepMinArticles",
    "customUserAgent", "fetchTimeoutSecs", "sslVerify", "maxSizeKb",
    "sourceType", "priority", "unicityCriteria", "unicityCriteriaForced", "scraperConfig", "httpOptions",
    // Feed Intelligence / full-text extraction
    "fullTextMode", "fullTextSelector", "fullTextRemoveSelectors", "fullTextConditions", "autoFetchFullText", "defaultContentFormat",
    // Per-feed keyword content filter
    "filtersActionRead",
    // Per-feed HTTP auth (password is write-only: accepted here, never serialized back)
    "authType", "authUsername", "authPassword",
    // Per-feed display overrides (null = inherit the user default)
    "hideArticleImage", "hideFromAllFeeds", "readerFontSizeOverride", "readerWidthOverride", "openOriginalOverride",
    // Muting
    "autoMuted",
  ] as const) {
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

async function listConnectors(_user: ApiUser) {
  // Server-level integrations an admin may have configured. These gate the
  // platform/monitor add-feed paths; exposing them lets an automation or LLM
  // discover what connector-backed feeds it can create before trying.
  const [rsshub, changedetection] = await Promise.all([
    isRsshubConfigured(),
    isChangedetectionConfigured(),
  ]);
  return NextResponse.json({
    rsshub: { configured: rsshub },
    changedetection: { configured: changedetection },
  });
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

// ─── Keyword Alerts ───────────────────────────────────────────────────────────

async function listAlerts(user: ApiUser) {
  const items = await db.keywordAlert.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
  return NextResponse.json({ items });
}

async function createAlert(user: ApiUser, request: Request) {
  const body = await readJson<any>(request);
  const name = allowedString(body?.name);
  const query = allowedString(body?.query);
  if (!name || !query) return apiError("name and query are required", 400);
  const actions = Array.isArray(body?.actions) ? body.actions.filter((a: unknown) => typeof a === "string") : ["notify_inapp"];
  const item = await db.keywordAlert.create({
    data: {
      userId: user.id,
      name,
      query,
      scope: allowedString(body?.scope) || "all",
      actions: JSON.stringify(actions),
      enabled: typeof body?.enabled === "boolean" ? body.enabled : true,
    },
  });
  return NextResponse.json(item, { status: 201 });
}

async function getAlert(user: ApiUser, alertId: string) {
  const item = await db.keywordAlert.findFirst({ where: { id: alertId, userId: user.id } });
  if (!item) return apiError("Alert not found", 404);
  return NextResponse.json(item);
}

async function patchAlert(user: ApiUser, alertId: string, request: Request) {
  const body = await readJson<any>(request);
  if (!body) return apiError("Invalid JSON body", 400);
  const data: any = {};
  if (body.name !== undefined) data.name = allowedString(body.name);
  if (body.query !== undefined) data.query = allowedString(body.query);
  if (body.scope !== undefined) data.scope = allowedString(body.scope);
  if (body.enabled !== undefined) data.enabled = Boolean(body.enabled);
  if (Array.isArray(body.actions)) data.actions = JSON.stringify(body.actions.filter((a: unknown) => typeof a === "string"));
  const result = await db.keywordAlert.updateMany({ where: { id: alertId, userId: user.id }, data });
  if (!result.count) return apiError("Alert not found", 404);
  return NextResponse.json(await db.keywordAlert.findFirst({ where: { id: alertId, userId: user.id } }));
}

async function deleteAlert(user: ApiUser, alertId: string) {
  const result = await db.keywordAlert.deleteMany({ where: { id: alertId, userId: user.id } });
  if (!result.count) return apiError("Alert not found", 404);
  return NextResponse.json({ deleted: true, id: alertId });
}

// ─── Auto-Read Rules ──────────────────────────────────────────────────────────

async function listRules(user: ApiUser) {
  const items = await db.autoReadRule.findMany({ where: { userId: user.id }, orderBy: { order: "asc" } });
  return NextResponse.json({ items });
}

async function createRule(user: ApiUser, request: Request) {
  const body = await readJson<any>(request);
  const name = allowedString(body?.name);
  const query = allowedString(body?.query);
  if (!name || !query) return apiError("name and query are required", 400);
  const actions = Array.isArray(body?.actions) ? body.actions.filter((a: unknown) => typeof a === "string") : null;
  const order = await db.autoReadRule.count({ where: { userId: user.id } });
  const item = await db.autoReadRule.create({
    data: {
      userId: user.id,
      name,
      query,
      action: "mark_read",
      actions: actions ? JSON.stringify(actions) : null,
      scope: allowedString(body?.scope) || null,
      trigger: allowedString(body?.trigger) || "article",
      enabled: typeof body?.enabled === "boolean" ? body.enabled : true,
      order,
    },
  });
  return NextResponse.json(item, { status: 201 });
}

async function getRule(user: ApiUser, ruleId: string) {
  const item = await db.autoReadRule.findFirst({ where: { id: ruleId, userId: user.id } });
  if (!item) return apiError("Rule not found", 404);
  return NextResponse.json(item);
}

async function patchRule(user: ApiUser, ruleId: string, request: Request) {
  const body = await readJson<any>(request);
  if (!body) return apiError("Invalid JSON body", 400);
  const data: any = {};
  if (body.name !== undefined) data.name = allowedString(body.name);
  if (body.query !== undefined) data.query = allowedString(body.query);
  if (body.scope !== undefined) data.scope = allowedString(body.scope);
  if (body.trigger !== undefined) data.trigger = allowedString(body.trigger);
  if (body.enabled !== undefined) data.enabled = Boolean(body.enabled);
  if (Array.isArray(body.actions)) data.actions = JSON.stringify(body.actions.filter((a: unknown) => typeof a === "string"));
  const result = await db.autoReadRule.updateMany({ where: { id: ruleId, userId: user.id }, data });
  if (!result.count) return apiError("Rule not found", 404);
  return NextResponse.json(await db.autoReadRule.findFirst({ where: { id: ruleId, userId: user.id } }));
}

async function deleteRule(user: ApiUser, ruleId: string) {
  const result = await db.autoReadRule.deleteMany({ where: { id: ruleId, userId: user.id } });
  if (!result.count) return apiError("Rule not found", 404);
  return NextResponse.json({ deleted: true, id: ruleId });
}

// ─── Notifications ────────────────────────────────────────────────────────────

async function listNotifications(user: ApiUser, request: Request) {
  const url = new URL(request.url);
  const isRead = parseBool(url.searchParams.get("isRead"));
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 100);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 100_000);
  const where: any = { userId: user.id };
  if (isRead !== undefined) where.isRead = isRead;
  const [items, total] = await Promise.all([
    db.notification.findMany({ where, orderBy: { createdAt: "desc" }, skip: offset, take: limit }),
    db.notification.count({ where }),
  ]);
  return NextResponse.json({ items, pagination: { limit, offset, total, nextOffset: offset + items.length < total ? offset + items.length : null } });
}

async function markAllNotificationsRead(user: ApiUser) {
  const result = await db.notification.updateMany({ where: { userId: user.id, isRead: false }, data: { isRead: true } });
  return NextResponse.json({ updated: result.count });
}

async function markNotificationRead(user: ApiUser, notificationId: string) {
  const result = await db.notification.updateMany({ where: { id: notificationId, userId: user.id }, data: { isRead: true } });
  if (!result.count) return apiError("Notification not found", 404);
  return NextResponse.json(await db.notification.findFirst({ where: { id: notificationId, userId: user.id } }));
}

// ─── Stats ────────────────────────────────────────────────────────────────────

async function getStats(user: ApiUser) {
  const [
    totalFeeds,
    totalArticles,
    unreadArticles,
    starredArticles,
    readLaterArticles,
    totalLabels,
    totalCategories,
    totalSavedSearches,
    totalKeywordAlerts,
    totalAutoReadRules,
    unreadNotifications,
  ] = await db.$transaction([
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
  return NextResponse.json({ totalFeeds, totalArticles, unreadArticles, starredArticles, readLaterArticles, totalLabels, totalCategories, totalSavedSearches, totalKeywordAlerts, totalAutoReadRules, unreadNotifications });
}

function openApiSpec(request: Request) {
  const origin = new URL(request.url).origin;
  return NextResponse.json({
    openapi: "3.1.0",
    info: { title: "FeedFerret API", version: "1.1.0", description: "Public REST API for FeedFerret readers, automations and AI tools." },
    servers: [{ url: origin }],
    security: [{ bearerAuth: [] }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "FeedFerret API token" } } },
    paths: {
      "/api/v1/me": { get: { summary: "Current account" } },
      "/api/v1/articles": { get: { summary: "Search/list articles" } },
      "/api/v1/articles/{id}": { get: { summary: "Get article" }, patch: { summary: "Update read/star/read-later state and labels" } },
      "/api/v1/articles/{id}/fetch-full-text": { post: { summary: "Fetch & extract the article's full text from its source page and persist it if it improves the article" } },
      "/api/v1/articles/mark-all-read": { post: { summary: "Bulk mark matching articles as read" } },
      "/api/v1/articles/batch": {
        post: {
          summary: "Batch update articles",
          description: "Apply an action to up to 500 articles at once.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ids", "action"],
                  properties: {
                    ids: { type: "array", items: { type: "string" }, maxItems: 500, description: "Article IDs to update" },
                    action: { type: "string", enum: ["read", "unread", "star", "unstar", "label", "unlabel", "read_later", "remove_read_later"] },
                    labelId: { type: "string", description: "Required when action is label or unlabel" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Number of updated articles", content: { "application/json": { schema: { type: "object", properties: { updated: { type: "integer" } } } } } },
            "400": { description: "Invalid input" },
            "404": { description: "No matching articles found" },
          },
        },
      },
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
      "/api/v1/connectors": { get: { summary: "List server-configured connectors (RSSHub, changedetection.io) and whether each is available" } },
      "/api/v1/connectors/rsshub/feeds": { post: { summary: "Create a feed from an RSSHub route path (validated against the configured RSSHub instance)" } },
      "/api/v1/connectors/changedetection/feeds": { post: { summary: "Create a changedetection.io watch for a URL and add it as a feed (empty until the watch has run twice)" } },
      "/api/v1/connectors/page/suggest": { post: { summary: "Suggest feed-item selector configs for an arbitrary web page (heuristic repeating-item detection)" } },
      "/api/v1/connectors/page/feeds": { post: { summary: "Create an HTML+XPath page-feed from a web page (uses the given config, or auto-picks the top suggestion)" } },
      "/api/v1/openapi.json": { get: { summary: "OpenAPI document" } },
      "/api/v1/alerts": { get: { summary: "List keyword alerts" }, post: { summary: "Create keyword alert" } },
      "/api/v1/alerts/{id}": { get: { summary: "Get keyword alert" }, patch: { summary: "Update keyword alert" }, delete: { summary: "Delete keyword alert" } },
      "/api/v1/rules": { get: { summary: "List auto-read rules" }, post: { summary: "Create auto-read rule" } },
      "/api/v1/rules/{id}": { get: { summary: "Get auto-read rule" }, patch: { summary: "Update auto-read rule" }, delete: { summary: "Delete auto-read rule" } },
      "/api/v1/notifications": { get: { summary: "List notifications" } },
      "/api/v1/notifications/mark-all-read": { post: { summary: "Mark all notifications as read" } },
      "/api/v1/notifications/{id}/read": { post: { summary: "Mark one notification as read" } },
      "/api/v1/stats": { get: { summary: "Aggregate user stats" } },
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

  // Enforce admin scope and role for administrative paths
  const isAdminPath = path[0] === "admin" || path[0] === "users" ||
    ((path[0] === "settings" || path[0] === "starter-packs") && isWriteMethod);
  if (isAdminPath) {
    const se = scopeError(user, "admin");
    if (se) return withRl(se);
    if (user.role !== "ADMIN") {
      return withRl(apiError("Admin role required", 403));
    }
  }

  let res: Response;
  try {
    if (method === "GET" && path[0] === "me" && path.length === 1) res = NextResponse.json({ id: user.id, email: user.email, name: user.name, role: user.role, tokenScope: user.tokenScope ?? "session" });
    else if (path[0] === "articles") {
      if (method === "GET" && path.length === 1) res = await listArticles(user, request);
      else if (method === "POST" && path[1] === "mark-all-read") { const se = scopeError(user, "write"); if (se) res = se; else res = await markAllRead(user, request); }
      else if (method === "POST" && path[1] === "batch") { const se = scopeError(user, "write"); if (se) res = se; else res = await batchArticles(user, request); }
      else if (method === "GET" && path.length === 2) res = await getArticle(user, path[1]);
      else if (method === "PATCH" && path.length === 2) { const se = scopeError(user, "write"); if (se) res = se; else res = await patchArticle(user, path[1], request); }
      else if (method === "POST" && path.length === 3 && path[2] === "fetch-full-text") { const se = scopeError(user, "write"); if (se) res = se; else res = await fetchArticleFullText(user, path[1]); }
      else res = apiError("Not found", 404);
    } else if (path[0] === "feeds") {
      if (method === "GET" && path.length === 1) res = await listFeeds(user);
      else if (method === "POST" && path.length === 1) { const se = scopeError(user, "write"); if (se) res = se; else res = await createFeed(user, request); }
      else if (method === "GET" && path.length === 2) res = await getFeed(user, path[1]);
      else if (method === "PATCH" && path.length === 2) { const se = scopeError(user, "write"); if (se) res = se; else res = await patchFeed(user, path[1], request); }
      else if (method === "DELETE" && path.length === 2) { const se = scopeError(user, "write"); if (se) res = se; else res = await deleteFeed(user, path[1]); }
      else if (method === "POST" && path.length === 3 && path[2] === "sync") { const se = scopeError(user, "write"); if (se) res = se; else res = await syncOneFeed(user, path[1]); }
      else res = apiError("Not found", 404);
    } else if (path[0] === "categories") {
      if (method === "GET" && path.length === 1) res = await listCategories(user);
      else if (method === "POST" && path.length === 1) { const se = scopeError(user, "write"); if (se) res = se; else res = await createCategory(user, request); }
      else if (method === "PATCH" && path.length === 2) { const se = scopeError(user, "write"); if (se) res = se; else res = await patchCategory(user, path[1], request); }
      else if (method === "DELETE" && path.length === 2) { const se = scopeError(user, "write"); if (se) res = se; else res = await deleteCategory(user, path[1]); }
      else res = apiError("Not found", 404);
    } else if (path[0] === "labels") {
      if (method === "GET" && path.length === 1) res = await listLabels(user);
      else if (method === "POST" && path.length === 1) { const se = scopeError(user, "write"); if (se) res = se; else res = await createLabel(user, request); }
      else if (method === "PATCH" && path.length === 2) { const se = scopeError(user, "write"); if (se) res = se; else res = await patchLabel(user, path[1], request); }
      else if (method === "DELETE" && path.length === 2) { const se = scopeError(user, "write"); if (se) res = se; else res = await deleteLabel(user, path[1]); }
      else res = apiError("Not found", 404);
    } else if (path[0] === "saved-searches") {
      if (method === "GET" && path.length === 1) res = await listSavedSearches(user);
      else if (method === "POST" && path.length === 1) { const se = scopeError(user, "write"); if (se) res = se; else res = await createSavedSearch(user, request); }
      else if (method === "PATCH" && path.length === 2) { const se = scopeError(user, "write"); if (se) res = se; else res = await patchSavedSearch(user, path[1], request); }
      else if (method === "DELETE" && path.length === 2) { const se = scopeError(user, "write"); if (se) res = se; else res = await deleteSavedSearch(user, path[1]); }
      else if (method === "POST" && path.length === 3 && path[2] === "share") { const se = scopeError(user, "write"); if (se) res = se; else res = await setSavedSearchShare(user, path[1], request); }
      else res = apiError("Not found", 404);
    } else if (path[0] === "opml" && path.length === 1) {
      if (method === "GET") res = await exportOpml(user);
      else if (method === "POST") { const se = scopeError(user, "write"); if (se) res = se; else res = await importOpml(user, request); }
      else res = apiError("Not found", 404);
    } else if (path[0] === "sync" && path.length === 1 && method === "POST") {
      const se = scopeError(user, "write"); if (se) res = se;
      else { const results = await syncUserFeeds(user.id); res = NextResponse.json({ success: true, synced: results.filter((r) => r.success && !r.skipped).length, total: results.length, results }); }
    } else if (path[0] === "alerts") {
      if (method === "GET" && path.length === 1) res = await listAlerts(user);
      else if (method === "POST" && path.length === 1) { const se = scopeError(user, "write"); if (se) res = se; else res = await createAlert(user, request); }
      else if (method === "GET" && path.length === 2) res = await getAlert(user, path[1]);
      else if (method === "PATCH" && path.length === 2) { const se = scopeError(user, "write"); if (se) res = se; else res = await patchAlert(user, path[1], request); }
      else if (method === "DELETE" && path.length === 2) { const se = scopeError(user, "write"); if (se) res = se; else res = await deleteAlert(user, path[1]); }
      else res = apiError("Not found", 404);
    } else if (path[0] === "rules") {
      if (method === "GET" && path.length === 1) res = await listRules(user);
      else if (method === "POST" && path.length === 1) { const se = scopeError(user, "write"); if (se) res = se; else res = await createRule(user, request); }
      else if (method === "GET" && path.length === 2) res = await getRule(user, path[1]);
      else if (method === "PATCH" && path.length === 2) { const se = scopeError(user, "write"); if (se) res = se; else res = await patchRule(user, path[1], request); }
      else if (method === "DELETE" && path.length === 2) { const se = scopeError(user, "write"); if (se) res = se; else res = await deleteRule(user, path[1]); }
      else res = apiError("Not found", 404);
    } else if (path[0] === "notifications") {
      if (method === "GET" && path.length === 1) res = await listNotifications(user, request);
      else if (method === "POST" && path[1] === "mark-all-read") { const se = scopeError(user, "write"); if (se) res = se; else res = await markAllNotificationsRead(user); }
      else if (method === "POST" && path.length === 3 && path[2] === "read") { const se = scopeError(user, "write"); if (se) res = se; else res = await markNotificationRead(user, path[1]); }
      else res = apiError("Not found", 404);
    } else if (path[0] === "stats" && path.length === 1 && method === "GET") {
      res = await getStats(user);
    } else if (path[0] === "connectors") {
      if (method === "GET" && path.length === 1) res = await listConnectors(user);
      else if (method === "POST" && path.length === 3 && path[1] === "rsshub" && path[2] === "feeds") { const se = scopeError(user, "write"); if (se) res = se; else res = await createRsshubFeed(user, request); }
      else if (method === "POST" && path.length === 3 && path[1] === "changedetection" && path[2] === "feeds") { const se = scopeError(user, "write"); if (se) res = se; else res = await createChangedetectionFeed(user, request); }
      else if (method === "POST" && path.length === 3 && path[1] === "page" && path[2] === "suggest") { const se = scopeError(user, "write"); if (se) res = se; else res = await suggestPageFeed(user, request); }
      else if (method === "POST" && path.length === 3 && path[1] === "page" && path[2] === "feeds") { const se = scopeError(user, "write"); if (se) res = se; else res = await createPageFeed(user, request); }
      else res = apiError("Not found", 404);
    } else {
      res = apiError("Not found", 404);
    }
  } catch (error) {
    logger.error("[api/v1]", error);
    logger.error("[api/v1] unhandled error", error);
    res = apiError("Internal server error", 500);
  }

  return withRl(res);
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
