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
  countGReaderFeedsAndTags,
  isKnownGReaderStream,
  normalizeGReaderReadStream,
  countGReaderUnread,
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
} from "@/lib/greader";


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
      where: { userId, ...externalItemWhere(batch) },
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
  if (!trimmed) return null;

  let label = await db.label.findFirst({
    where: { userId, name: trimmed },
    orderBy: { createdAt: "asc" },
  });

  if (!label) {
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
  const feedUrl = String(form.get("quickadd") || form.get("url") || "").trim();
  if (!feedUrl) return textResponse("Missing quickadd parameter", 400);

  const existing = await db.feed.findFirst({ where: { userId, ...(/^\d+$/.test(feedUrl) ? { extId: storedExternalId(feedUrl) } : { url: feedUrl }) } });
  if (existing) {
    return NextResponse.json({ numResults: 1, query: feedUrl, streamId: `feed/${decimalExternalId(existing.extId)}`, numSubscribers: 1, title: existing.name });
  }

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
    title: feed.name,
  });
}

async function handleSubscriptionEdit(userId: string, form: FormData) {
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

  let nextCategoryId: string | null | undefined = undefined;
  const addedCategoryTag = [...addTags].reverse().find((tag) => tag.startsWith(GREADER_LABEL_PREFIX));
  if (addedCategoryTag) {
    const categoryName = normalizeCategoryNameFromTag(addedCategoryTag);
    const category = categoryName ? await getOrCreateCategory(userId, categoryName) : null;
    nextCategoryId = category?.id ?? null;
  }
  for (const tag of removeTags) {
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
      return textResponse(createGReaderToken(user.id));
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

    if (path.endsWith("subscription/list")) {
      const feeds = await db.feed.findMany({
        where: { userId: user.id },
        include: { category: true },
        orderBy: [{ order: "asc" }, { name: "asc" }],
      });

      return NextResponse.json({
        subscriptions: feeds.map((feed: { id: string; extId: string | null; url: string; name: string; category: { name: string } | null }) => ({
          id: `feed/${decimalExternalId(feed.extId)}`,
          title: feed.name,
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
      const [reading, starred, grouped] = await Promise.all([
        countGReaderUnread(user.id, GREADER_READING_LIST), countGReaderUnread(user.id, GREADER_STARRED),
        countGReaderFeedsAndTags(user.id),
      ]);
      return NextResponse.json({ max: reading.count, unreadcounts: [reading, starred, ...grouped] });
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
    const form = await request.formData();

    if (path.endsWith("subscription/quickadd")) {
      return await handleSubscriptionQuickAdd(user.id, form);
    }

    if (path.endsWith("subscription/edit")) {
      return await handleSubscriptionEdit(user.id, form);
    }

    if (path.endsWith("preference/stream/set")) {
      const streamId = String(form.get("s") || form.get("stream") || "").trim();
      const key = String(form.get("k") || form.get("key") || "").trim();
      const value = String(form.get("v") || form.get("value") || "");
      if (!streamId || !key) return textResponse("Missing stream preference parameters", 400);
      await upsertGReaderStreamPref(user.id, streamId, key, value);
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
