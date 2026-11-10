import { timingSafeEqual } from "crypto";
import { readGReaderBody } from "@/lib/bounded-body";
import { manageGReaderTag } from "@/lib/greader-management";
import { discoverFeeds } from "@/lib/feed-discovery";
import { assertSafeFetchUrl } from "@/lib/ssrf";
import { generateApiOpml } from "@/lib/opml";
import { importOpmlXml } from "@/lib/import/opml-import";
import { decimalExternalId, externalItemWhere, storedExternalId } from "@/lib/external-ids";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { syncFeed } from "@/lib/rss-sync";
import { fetchFeedArticles } from "@/lib/feed-fetcher";
import { checkRateLimit, getClientIdentifier, RATE_LIMITS, rateLimitResponse } from "@/lib/rate-limit";
import {
  authenticateGReaderRequest,
  buildCursorWhere,
  buildStreamWhere,
  getGReaderUnreadCounts,
  isKnownGReaderStream,
  normalizeGReaderReadStream,
  greaderLimit,
  createContinuationToken,
  createGReaderToken,
  deleteGReaderStreamPref,
  getGReaderStreamTitle,
  GREADER_BROADCAST,
  GREADER_KEEP_UNREAD,
  GREADER_LABEL_PREFIX,
  GREADER_LIKE,
  GREADER_READ,
  GREADER_READING_LIST,
  GREADER_STARRED,
  listGReaderStreamPrefs,
  listGReaderTags,
  normalizeCategoryNameFromTag,
  parseContinuationToken,
  parseGReaderItemId,
  toGReaderArticle,
  toGReaderItemRef,
  upsertGReaderStreamPref,
  GReaderLimitError,
  GREADER_MAX_LABELS,
  MAX_GREADER_LABEL_NAME,
} from "@/lib/greader";
import { connectorFeedUrlError, redactFeedsForClient, stripConnectorSecrets } from "@/lib/connector-secrets";


class UnauthorizedError extends Error {}
class InvalidRequestError extends Error {}

function errorResponse(error: unknown) {
  const status = error instanceof UnauthorizedError ? 401 : error instanceof InvalidRequestError ? 400 : 500;
  return NextResponse.json({ error: status === 401 ? "Unauthorized" : status === 400 ? (error as Error).message : "Internal server error" }, { status });
}

function itemIds(values: string[]) {
  const ids = [...new Set(values.filter(Boolean).map(parseGReaderItemId))];
  if (ids.length > 1000) throw new InvalidRequestError("At most 1000 item IDs are allowed");
  return ids;
}

function chunks<T>(items: T[]) {
  return Array.from({ length: Math.ceil(items.length / 200) }, (_, i) => items.slice(i * 200, (i + 1) * 200));
}

async function requireUser(request: Request) {
  const user = await authenticateGReaderRequest(request);
  if (!user) throw new UnauthorizedError();
  return user;
}

function textResponse(body: string, status = 200) {
  return new NextResponse(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function okResponse() {
  return textResponse("OK");
}

function getPath(requestPath: string[], marker: string) {
  const joined = requestPath.join("/");
  const index = joined.indexOf(`${marker}/`);
  if (index === -1) return null;
  return decodeURIComponent(joined.slice(index + marker.length + 1));
}

function getStreamId(pathParts: string[], url: URL, marker: string) {
  return normalizeGReaderReadStream(url.searchParams.get("s") || url.searchParams.get("stream") || getPath(pathParts, marker) || GREADER_READING_LIST);
}

async function getArticlesForStream(userId: string, streamId: string, url: URL, idsOnly = false) {
  const limit = greaderLimit(url.searchParams.get("n"), idsOnly);
  const timestamp = (name: "ot" | "nt") => {
    const value = Number(url.searchParams.get(name));
    // nt includes the whole second; validate its exclusive upper bound too.
    const ms = (Math.trunc(value) + (name === "nt" ? 1 : 0)) * 1000;
    if (!Number.isFinite(value) || !Number.isFinite(new Date(ms).getTime())) {
      throw new InvalidRequestError(`Invalid ${name}`);
    }
    return value;
  };
  const cursor = parseContinuationToken(url.searchParams.get("c"));
  const ascending = url.searchParams.get("r") === "o";
  const scope = buildStreamWhere(userId, streamId, url.searchParams.getAll("it"), url.searchParams.getAll("xt"), timestamp("ot"), timestamp("nt"));
  // Freeze the discovery high-water mark, including its ID tie-breaker. New arrivals
  // are picked up by the next sync, not inserted into this pagination sequence.
  const newest = cursor?.ceiling ? null : await db.article.findFirst({ where: scope, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { createdAt: true, id: true } });
  const ceiling = cursor?.ceiling || (newest ? { createdAt: newest.createdAt.toISOString(), id: newest.id } : undefined);
  const where = { AND: [scope, buildCursorWhere(cursor, ascending), ...(ceiling ? [{ OR: [
    { createdAt: { lt: new Date(ceiling.createdAt) } },
    { createdAt: new Date(ceiling.createdAt), id: { lte: ceiling.id } },
  ] }] : [])] };
  const direction = ascending ? "asc" as const : "desc" as const;
  const rows = await db.article.findMany({
    where,
    include: { feed: { include: { category: true } }, ...(!idsOnly ? { labels: { include: { label: true } } } : {}) },
    orderBy: [{ createdAt: direction }, { id: direction }],
    take: limit + 1,
  });
  const articles = rows.slice(0, limit);
  return { articles, continuation: rows.length > limit ? createContinuationToken(articles[articles.length - 1], ceiling) : undefined };
}

async function getItemsByIds(userId: string, ids: string[], order: string | null) {
  const direction = order === "o" ? "asc" as const : "desc" as const;
  const rows = [];
  for (const batch of chunks(itemIds(ids))) {
    rows.push(...await db.article.findMany({
      where: { userId, extId: { not: null }, feed: { extId: { not: null } }, ...externalItemWhere(batch) },
      include: { feed: { include: { category: true } }, labels: { include: { label: true } } },
    }));
  }
  return rows.sort((a, b) => {
    const comparison = a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return direction === "asc" ? comparison : -comparison;
  });
}

async function getOrCreateCategory(userId: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) return null;

  let category = await db.category.findFirst({
    where: { userId, name: trimmed },
    orderBy: { createdAt: "asc" },
  });

  if (!category) {
    const count = await db.category.count({ where: { userId } });
    category = await db.category.create({
      data: {
        userId,
        name: trimmed,
        order: count,
      },
    });
  }

  return category;
}

async function getOrCreateLabel(userId: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_GREADER_LABEL_NAME) return null;

  let label = await db.label.findFirst({
    where: { userId, name: trimmed },
    orderBy: { createdAt: "asc" },
  });

  if (!label) {
    // N11: an API client must not create labels without bound.
    if ((await db.label.count({ where: { userId } })) >= GREADER_MAX_LABELS) return null;
    label = await db.label.create({
      data: { userId, name: trimmed },
    });
  }

  return label;
}

/**
 * Applies a GReader edit-tag request (read/starred state + label add/remove) to a
 * batch of articles at once, scoped to `userId`. Preserves the same tag→field mapping
 * and label dedup semantics as the previous per-article implementation, but replaces
 * the per-id round trips with one `updateMany` for the read/starred bit and batched
 * `createMany`/`deleteMany` (keyed on `articleId: { in: ids }`) for labels.
 */
async function applyTagEdit(userId: string, ids: string[], add: string[], remove: string[]) {
  const owned = await db.article.findMany({ where: { userId, ...externalItemWhere(ids) }, select: { id: true } });
  ids = [...new Set(owned.map((row) => row.id))];
  if (ids.length === 0) return;

  const updates: Record<string, unknown> = {};
  if (add.includes(GREADER_READ)) {
    updates.isRead = true;
    updates.readAt = new Date();
  }
  if (remove.includes(GREADER_READ)) {
    updates.isRead = false;
    updates.readAt = null;
  }
  if (add.includes(GREADER_STARRED)) updates.isStarred = true;
  if (remove.includes(GREADER_STARRED)) updates.isStarred = false;
  if (Object.keys(updates).length > 0) {
    await db.article.updateMany({ where: { id: { in: ids }, userId }, data: updates });
  }

  for (const tag of add) {
    const labelName = normalizeCategoryNameFromTag(tag);
    if (!labelName) continue;
    const label = await getOrCreateLabel(userId, labelName);
    if (!label) continue;

    // SQLite's `createMany` doesn't support `skipDuplicates`, so exclude
    // articles that already have this label before inserting the rest.
    const existing = await db.articleLabel.findMany({
      where: { articleId: { in: ids }, labelId: label.id, userId },
      select: { articleId: true },
    });
    const existingIds = new Set(existing.map((row) => row.articleId));
    const toCreate = ids.filter((articleId) => !existingIds.has(articleId));
    if (toCreate.length > 0) {
      await db.articleLabel.createMany({
        data: toCreate.map((articleId) => ({ articleId, labelId: label.id, userId })),
      });
    }
  }

  for (const tag of remove) {
    const labelName = normalizeCategoryNameFromTag(tag);
    if (!labelName) continue;
    const label = await db.label.findFirst({ where: { userId, name: labelName } });
    if (!label) continue;
    await db.articleLabel.deleteMany({ where: { articleId: { in: ids }, labelId: label.id, userId } });
  }
}

async function handleSubscriptionQuickAdd(userId: string, form: FormData) {
  let feedUrl = String(form.get("quickadd") || form.get("url") || "").trim().replace(/^feed\//, "");
  if (!feedUrl || feedUrl.length > 2048) return NextResponse.json({ numResults: 0, error: "Invalid quickadd parameter" });
  const limit = checkRateLimit(`greader-add:${userId}`, RATE_LIMITS.urlDiscover);
  if (!limit.success) return rateLimitResponse(limit);

  const existing = await db.feed.findFirst({ where: { userId, ...(/^\d+$/.test(feedUrl) ? { extId: storedExternalId(feedUrl) } : { url: feedUrl }) } });
  if (existing) {
    if (!existing.extId) {
      const { allocateExternalIds } = await import("@/lib/external-id-store");
      const [extId] = await allocateExternalIds(db as unknown as import("@prisma/client").PrismaClient, 1);
      await db.feed.updateMany({ where: { id: existing.id, extId: null }, data: { extId } });
      existing.extId = (await db.feed.findUniqueOrThrow({ where: { id: existing.id } })).extId;
    }
    return NextResponse.json({ numResults: 1, query: feedUrl, streamId: `feed/${decimalExternalId(existing.extId)}`, numSubscribers: 1, streamName: existing.name, title: existing.name });
  }

  const discovery = await discoverFeeds(feedUrl);
  feedUrl = discovery.feeds[0]?.url || feedUrl;
  try { await assertSafeFetchUrl(feedUrl); } catch { return NextResponse.json({ numResults: 0, error: "Unsafe feed URL" }); }
  // Only allowed connector routes (no /rsshub/transform/…, no all-watches feed); stored without secrets (N3).
  if (await connectorFeedUrlError(feedUrl)) return NextResponse.json({ numResults: 0, error: "Connector route not allowed" });
  feedUrl = await stripConnectorSecrets(feedUrl);
  const resolvedExisting = await db.feed.findFirst({ where: { userId, url: feedUrl } });
  if (resolvedExisting?.extId) return NextResponse.json({ numResults: 1, streamId: `feed/${decimalExternalId(resolvedExisting.extId)}`, streamName: resolvedExisting.name, title: resolvedExisting.name });
  const remoteFeed = await fetchFeedArticles({ url: feedUrl });
  const order = await db.feed.count({ where: { userId } });
  const feed = await db.feed.create({
    data: {
      userId,
      url: feedUrl,
      name: remoteFeed.title || feedUrl,
      order,
      icon: "📰",
    },
  });

  await syncFeed(userId, feed.id);

  return NextResponse.json({
    numResults: 1,
    query: feedUrl,
    streamId: `feed/${decimalExternalId(feed.extId)}`,
    numSubscribers: 1,
    streamName: feed.name, title: feed.name,
  });
}

async function handleSubscriptionEdit(userId: string, form: FormData) {
  const streams = [...new Set(form.getAll("s").map(String))];
  const action = String(form.get("ac") || "edit").toLowerCase();
  if (!streams.length || streams.length > 100 || streams.some((s) => !s.startsWith("feed/") || s.length > 2053) || !["subscribe", "unsubscribe", "edit"].includes(action)) return textResponse("Invalid subscriptions", 400);
  const titles = form.getAll("t").map(String);
  for (const [index, stream] of streams.entries()) {
    const single = new FormData();
    for (const [key, value] of form) if (key !== "s") single.append(key, value);
    single.set("s", stream);
    if (titles[index] !== undefined) single.set("t", titles[index]);
    if (action === "subscribe") {
      single.set("quickadd", stream.slice(5));
      const response = await handleSubscriptionQuickAdd(userId, single);
      if (!response.ok) return response;
      const result = await response.json();
      if (!result.streamId) return NextResponse.json(result);
      single.set("s", result.streamId);
    }
    const response = await handleSingleSubscriptionEdit(userId, single);
    if (!response.ok) return response;
  }
  return okResponse();
}

async function handleSingleSubscriptionEdit(userId: string, form: FormData) {
  const streamId = String(form.get("s") || "");
  if (!streamId.startsWith("feed/")) return textResponse("Unsupported subscription", 400);

  const feedUrl = streamId.slice(5);
  const feed = await db.feed.findFirst({ where: { userId, ...(/^\d+$/.test(feedUrl) ? { extId: storedExternalId(feedUrl) } : { url: feedUrl }) } });
  if (!feed) return textResponse("Feed not found", 404);

  const action = String(form.get("ac") || "edit").toLowerCase();
  if (action === "unsubscribe") {
    await db.feed.delete({ where: { id: feed.id, userId } });
    return okResponse();
  }

  const addTags = form.getAll("a").map(String);
  const removeTags = form.getAll("r").map(String);
  const title = String(form.get("t") || "").trim();
  if (title.length > 512 || [...addTags, ...removeTags].some((tag) => !normalizeCategoryNameFromTag(tag))) return textResponse("Invalid title or folder", 400);

  let nextCategoryId: string | null | undefined = undefined;
  const addedCategoryTag = [...addTags].reverse().find((tag) => normalizeCategoryNameFromTag(tag) !== null);
  if (addedCategoryTag) {
    const categoryName = normalizeCategoryNameFromTag(addedCategoryTag);
    const category = categoryName ? await getOrCreateCategory(userId, categoryName) : null;
    nextCategoryId = category?.id ?? null;
  }
  for (const tag of addedCategoryTag ? [] : removeTags) {
    const categoryName = normalizeCategoryNameFromTag(tag);
    if (categoryName && feed.categoryId) {
      const currentCategory = await db.category.findUnique({ where: { id: feed.categoryId } });
      if (currentCategory?.name === categoryName) nextCategoryId = null;
    }
  }

  await db.feed.update({
    where: { id: feed.id, userId },
    data: {
      ...(title ? { name: title } : {}),
      ...(nextCategoryId !== undefined ? { categoryId: nextCategoryId } : {}),
    },
  });

  return okResponse();
}

async function handleMarkAllAsRead(userId: string, form: FormData) {
  const streamId = String(form.get("s") || GREADER_READING_LIST);
  if (!isKnownGReaderStream(streamId)) return textResponse("Unknown stream", 400);
  // `ts` is a Unix timestamp in microseconds — only mark articles older than this as read.
  // Clients send this to avoid marking freshly-arrived articles as read during a sync.
  const tsParam = form.get("ts");
  const olderThanMs = tsParam ? Number(tsParam) / 1000 : null;
  const cutoff = olderThanMs && Number.isFinite(olderThanMs) && olderThanMs > 0
    ? new Date(olderThanMs)
    : null;

  const where = buildStreamWhere(userId, streamId, [], []);
  const readWhere: any = { ...where, isRead: false };
  if (tsParam && (Number(tsParam) !== 0) && (!cutoff || !Number.isFinite(cutoff.getTime()))) return textResponse("Invalid ts", 400);
  if (cutoff) readWhere.createdAt = { lte: cutoff };

  await db.article.updateMany({
    where: readWhere,
    data: { isRead: true, readAt: new Date() },
  });
  return okResponse();
}

export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const user = await requireUser(request);
    const rl = checkRateLimit(getClientIdentifier(request, user.id), RATE_LIMITS.greader);
    if (!rl.success) return rateLimitResponse(rl);
    const pathParts = (await params).path;
    const path = pathParts.join("/");
    const url = new URL(request.url);

    if (path.endsWith("token")) {
      if (user.tokenScope) return textResponse("Use password authentication for action tokens", 403);
      return textResponse(createGReaderToken(user.id, user.apiTokenVersion));
    }

    if (path.endsWith("user-info")) {
      return NextResponse.json({
        userId: user.id,
        userName: user.email,
        userProfileId: user.id,
        isBloggerUser: false,
        signupTimeSec: Math.floor(user.createdAt.getTime() / 1000),
      });
    }

    if (path.endsWith("preference/list") || path.endsWith("stream/preferences")) {
      const streamprefs = await listGReaderStreamPrefs(user.id);
      return NextResponse.json({
        preferences: [],
        streamprefs,
        streamPrefs: streamprefs,
      });
    }

    if (path.endsWith("preference/stream/list")) {
      const streamprefs = await listGReaderStreamPrefs(user.id);
      return NextResponse.json({ streamprefs, streamPrefs: streamprefs });
    }

    if (path.endsWith("subscription/export")) {
      const [feeds, categories] = await Promise.all([
        db.feed.findMany({ where: { userId: user.id }, include: { category: true } }),
        db.category.findMany({ where: { userId: user.id } }),
      ]);
      return new NextResponse(generateApiOpml(await redactFeedsForClient(feeds), categories), { headers: { "content-type": "text/x-opml; charset=utf-8", "content-disposition": 'attachment; filename="subscriptions.opml"' } });
    }
    if (path.endsWith("subscription/list")) {
      // Connector secrets (RSSHub key, changedetection token) never leave the server (N3).
      const feeds = await redactFeedsForClient(await db.feed.findMany({
        where: { userId: user.id },
        include: { category: true },
        orderBy: [{ order: "asc" }, { name: "asc" }],
      }));

      return NextResponse.json({
        subscriptions: feeds.filter((feed) => feed.extId).map((feed: { id: string; extId: string | null; url: string; name: string; category: { name: string } | null }) => ({
          id: `feed/${decimalExternalId(feed.extId)}`,
          streamName: feed.name, title: feed.name,
          categories: feed.category
            ? [{ id: `${GREADER_LABEL_PREFIX}${feed.category.name}`, label: feed.category.name }]
            : [],
          url: feed.url,
          htmlUrl: feed.url,
          firstitemmsec: "0",
        })),
      });
    }

    if (path.endsWith("tag/list")) {
      return NextResponse.json({ tags: await listGReaderTags(user.id) });
    }

    if (path.endsWith("unread-count")) {
      return NextResponse.json(await getGReaderUnreadCounts(user.id));
    }

    if ((path.includes("stream/items/contents") || path.includes("stream/contents")) && url.searchParams.has("i")) {
      const articles = await getItemsByIds(user.id, url.searchParams.getAll("i"), url.searchParams.get("r"));
      return NextResponse.json({ id: GREADER_READING_LIST, updated: Math.floor(Date.now() / 1000), items: await Promise.all(articles.map(toGReaderArticle)) });
    }

    if (path.includes("stream/items/ids")) {
      const streamId = getStreamId(pathParts, url, "stream/items/ids");
      const { articles, continuation } = await getArticlesForStream(user.id, streamId, url, true);
      return NextResponse.json({
        id: streamId,
        title: getGReaderStreamTitle(streamId),
        itemRefs: articles.map(toGReaderItemRef),
        continuation,
      });
    }

    if (path.includes("stream/items/contents") || path.includes("stream/contents")) {
      const marker = path.includes("stream/items/contents") ? "stream/items/contents" : "stream/contents";
      const streamId = getStreamId(pathParts, url, marker);
      const { articles, continuation } = await getArticlesForStream(user.id, streamId, url);
      return NextResponse.json({
        id: streamId,
        title: getGReaderStreamTitle(streamId),
        updated: Math.floor(Date.now() / 1000),
        continuation,
        items: await Promise.all(articles.map(toGReaderArticle)),
      });
    }

    return NextResponse.json({ error: "Unsupported Google Reader endpoint", path }, { status: 404 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const user = await requireUser(request);
    const rl = checkRateLimit(getClientIdentifier(request, user.id), RATE_LIMITS.greader);
    if (!rl.success) return rateLimitResponse(rl);
    const path = (await params).path.join("/");
    const isContents = path.includes("stream/items/contents") || path.includes("stream/contents");
    if (user.tokenScope && !["write", "admin"].includes(user.tokenScope) && !isContents) return textResponse("Insufficient token scope", 403);
    let raw: string;
    try { raw = await readGReaderBody(request, path.endsWith("subscription/import") ? 5 * 1024 * 1024 : 128 * 1024); }
    catch { return textResponse("Request too large", 413); }
    if (path.endsWith("subscription/import")) {
      const importLimit = checkRateLimit(user.id, { prefix: "greader-import", limit: 5, windowSecs: 3600 });
      if (!importLimit.success) return rateLimitResponse(importLimit);
      try { return NextResponse.json(await importOpmlXml(user.id, raw, { trust: "remote", maxFeeds: 2000 })); }
      catch { return textResponse("Invalid OPML", 400); }
    }
    const form = await new Request(request.url, { method: "POST", headers: request.headers, body: raw }).formData();
    const query = new URL(request.url).searchParams;
    for (const key of ["s", "a", "r"]) for (const value of query.getAll(key)) form.append(key, value);
    if (form.getAll("a").length > 10 || form.getAll("r").length > 10 || form.getAll("s").length > 100) return textResponse("Too many tags or streams", 400);
    const actionToken = form.get("T");
    if (actionToken && actionToken !== "x") {
      const actual = Buffer.from(String(actionToken));
      const expected = Buffer.from(createGReaderToken(user.id, user.apiTokenVersion));
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return textResponse("Invalid action token", 401);
    }
    if (path.endsWith("rename-tag") || path.endsWith("disable-tag")) return await manageGReaderTag(user.id, form, path.endsWith("rename-tag"));

    if (path.endsWith("subscription/quickadd")) {
      try { return await handleSubscriptionQuickAdd(user.id, form); }
      catch { return NextResponse.json({ numResults: 0, error: "Unable to add feed" }); }
    }

    if (path.endsWith("subscription/edit")) {
      return await handleSubscriptionEdit(user.id, form);
    }

    if (path.endsWith("preference/stream/set")) {
      const streamId = String(form.get("s") || form.get("stream") || "").trim();
      const key = String(form.get("k") || form.get("key") || "").trim();
      const value = String(form.get("v") || form.get("value") || "");
      if (!streamId || !key) return textResponse("Missing stream preference parameters", 400);
      try {
        await upsertGReaderStreamPref(user.id, streamId, key, value);
      } catch (error) {
        if (error instanceof GReaderLimitError) return textResponse(error.message, 400);
        throw error;
      }
      return okResponse();
    }

    if (path.endsWith("preference/stream/delete")) {
      const streamId = String(form.get("s") || form.get("stream") || "").trim();
      const key = String(form.get("k") || form.get("key") || "").trim();
      if (!streamId || !key) return textResponse("Missing stream preference parameters", 400);
      await deleteGReaderStreamPref(user.id, streamId, key);
      return okResponse();
    }

    if (path.endsWith("mark-all-as-read")) {
      return await handleMarkAllAsRead(user.id, form);
    }

    if (path.endsWith("edit-tag")) {
      const ids = itemIds(form.getAll("i").map(String));
      const add = form.getAll("a").map(String);
      const remove = form.getAll("r").map(String);
      for (const batch of chunks(ids)) await applyTagEdit(user.id, batch, add, remove);
      return okResponse();
    }

    // Clients (Reeder, NetNewsWire, FeedMe, ReadKit) call:
    //   GET  stream/items/ids   → list of item IDs
    //   POST stream/items/contents  i=<id>&i=<id>&...  → fetch full content
    if (path.includes("stream/items/contents") || path.includes("stream/contents")) {
      const rawIds = form.getAll("i").map(String).filter(Boolean);
      if (rawIds.length === 0) {
        return NextResponse.json({ id: "user/-/state/com.google/reading-list", updated: Math.floor(Date.now() / 1000), items: [] });
      }
      const articles = await getItemsByIds(user.id, rawIds, String(form.get("r") || new URL(request.url).searchParams.get("r") || ""));
      return NextResponse.json({
        id: "user/-/state/com.google/reading-list",
        updated: Math.floor(Date.now() / 1000),
        items: await Promise.all(articles.map(toGReaderArticle)),
      });
    }

    return NextResponse.json({ error: "Unsupported Google Reader endpoint", path }, { status: 404 });
  } catch (error) {
    return errorResponse(error);
  }
}
