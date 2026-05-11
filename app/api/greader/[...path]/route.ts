import { NextResponse } from "next/server";
import Parser from "rss-parser";
import { db } from "@/lib/db";
import { syncFeed } from "@/lib/rss-sync";
import {
  authenticateGReaderRequest,
  buildStreamWhere,
  createContinuationToken,
  createGReaderToken,
  getGReaderStreamTitle,
  GREADER_BROADCAST,
  GREADER_KEEP_UNREAD,
  GREADER_LABEL_PREFIX,
  GREADER_LIKE,
  GREADER_READ,
  GREADER_READING_LIST,
  GREADER_STARRED,
  normalizeCategoryNameFromTag,
  parseContinuationToken,
  parseGReaderItemId,
  parseGReaderStreamId,
  toGReaderArticle,
  toGReaderItemRef,
} from "@/lib/greader";

const parser = new Parser();

async function requireUser(request: Request) {
  const user = await authenticateGReaderRequest(request);
  if (!user) throw new Error("Unauthorized");
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
  return url.searchParams.get("s") || url.searchParams.get("stream") || getPath(pathParts, marker) || GREADER_READING_LIST;
}

async function getArticlesForStream(userId: string, streamId: string, url: URL) {
  const limit = Math.min(Number(url.searchParams.get("n") || 20), 200);
  const offset = parseContinuationToken(url.searchParams.get("c"));
  const includeStates = url.searchParams.getAll("it");
  const excludeStates = url.searchParams.getAll("xt");
  const where = buildStreamWhere(userId, streamId, includeStates, excludeStates);

  const articles = await db.article.findMany({
    where,
    include: {
      feed: true,
      labels: { include: { label: true } },
    },
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
    skip: offset,
    take: limit,
  });

  const total = await db.article.count({ where });
  return {
    articles,
    continuation: offset + articles.length < total ? createContinuationToken(offset + articles.length) : undefined,
  };
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

async function applyTagEdit(userId: string, articleId: string, add: string[], remove: string[]) {
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
    await db.article.update({ where: { id: articleId, userId }, data: updates });
  }

  for (const tag of add) {
    const labelName = normalizeCategoryNameFromTag(tag);
    if (!labelName) continue;
    const label = await getOrCreateLabel(userId, labelName);
    if (!label) continue;
    await db.articleLabel.upsert({
      where: { articleId_labelId: { articleId, labelId: label.id } },
      update: { userId },
      create: { articleId, labelId: label.id, userId },
    });
  }

  for (const tag of remove) {
    const labelName = normalizeCategoryNameFromTag(tag);
    if (!labelName) continue;
    const label = await db.label.findFirst({ where: { userId, name: labelName } });
    if (!label) continue;
    await db.articleLabel.deleteMany({ where: { articleId, labelId: label.id, userId } });
  }
}

async function handleSubscriptionQuickAdd(userId: string, form: FormData) {
  const feedUrl = String(form.get("quickadd") || form.get("url") || "").trim();
  if (!feedUrl) return textResponse("Missing quickadd parameter", 400);

  const existing = await db.feed.findFirst({ where: { userId, url: feedUrl } });
  if (existing) {
    return NextResponse.json({ numResults: 1, query: feedUrl, streamId: `feed/${existing.url}`, numSubscribers: 1, title: existing.name });
  }

  const remoteFeed = await parser.parseURL(feedUrl);
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
    streamId: `feed/${feed.url}`,
    numSubscribers: 1,
    title: feed.name,
  });
}

async function handleSubscriptionEdit(userId: string, form: FormData) {
  const streamId = String(form.get("s") || "");
  if (!streamId.startsWith("feed/")) return textResponse("Unsupported subscription", 400);

  const feedUrl = streamId.slice(5);
  const feed = await db.feed.findFirst({ where: { userId, url: feedUrl } });
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
  const where = buildStreamWhere(userId, streamId, [], [GREADER_STARRED]);
  await db.article.updateMany({
    where: { ...where, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  return okResponse();
}

export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const user = await requireUser(request);
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
        signupTimeSec: 0,
      });
    }

    if (path.endsWith("preference/list") || path.endsWith("stream/preferences")) {
      return NextResponse.json({ preferences: [] });
    }

    if (path.endsWith("subscription/list")) {
      const feeds = await db.feed.findMany({
        where: { userId: user.id },
        include: { category: true },
        orderBy: [{ order: "asc" }, { name: "asc" }],
      });

      return NextResponse.json({
        subscriptions: feeds.map((feed) => ({
          id: `feed/${feed.url}`,
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
      const labels = await db.label.findMany({ where: { userId: user.id }, orderBy: { name: "asc" } });
      const systemTags = [
        GREADER_READING_LIST,
        GREADER_READ,
        GREADER_STARRED,
        GREADER_BROADCAST,
        GREADER_KEEP_UNREAD,
        GREADER_LIKE,
      ].map((id) => ({ id, type: "state", sortid: id }));
      const customTags = labels.map((label) => ({ id: `${GREADER_LABEL_PREFIX}${label.name}`, type: "label", sortid: label.name }));
      return NextResponse.json({ tags: [...systemTags, ...customTags] });
    }

    if (path.endsWith("unread-count")) {
      const feeds = await db.feed.findMany({ where: { userId: user.id }, include: { category: true } });
      const labels = await db.label.findMany({ where: { userId: user.id } });
      const [totalUnread, starredUnread, feedCounts, labelCounts] = await Promise.all([
        db.article.count({ where: { userId: user.id, isRead: false } }),
        db.article.count({ where: { userId: user.id, isRead: false, isStarred: true } }),
        db.article.groupBy({ by: ["feedId"], where: { userId: user.id, isRead: false }, _count: { _all: true } }),
        Promise.all(labels.map(async (label) => ({
          label,
          count: await db.article.count({
            where: { userId: user.id, isRead: false, labels: { some: { labelId: label.id } } },
          }),
        }))),
      ]);
      const feedCountMap = new Map(feedCounts.map((item) => [item.feedId, item._count._all]));

      return NextResponse.json({
        max: 1000,
        unreadcounts: [
          { id: GREADER_READING_LIST, count: totalUnread, newestItemTimestampUsec: "0" },
          { id: GREADER_STARRED, count: starredUnread, newestItemTimestampUsec: "0" },
          ...feeds.map((feed) => ({ id: `feed/${feed.url}`, count: feedCountMap.get(feed.id) || 0, newestItemTimestampUsec: "0" })),
          ...labelCounts.map(({ label, count }) => ({ id: `${GREADER_LABEL_PREFIX}${label.name}`, count, newestItemTimestampUsec: "0" })),
        ],
      });
    }

    if (path.includes("stream/items/ids")) {
      const streamId = getStreamId(pathParts, url, "stream/items/ids");
      const { articles, continuation } = await getArticlesForStream(user.id, streamId, url);
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
        items: articles.map(toGReaderArticle),
      });
    }

    return NextResponse.json({ error: "Unsupported Google Reader endpoint", path }, { status: 404 });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const user = await requireUser(request);
    const path = (await params).path.join("/");
    const form = await request.formData();

    if (path.endsWith("subscription/quickadd")) {
      return handleSubscriptionQuickAdd(user.id, form);
    }

    if (path.endsWith("subscription/edit")) {
      return handleSubscriptionEdit(user.id, form);
    }

    if (path.endsWith("mark-all-as-read")) {
      return handleMarkAllAsRead(user.id, form);
    }

    if (path.endsWith("edit-tag")) {
      const ids = form.getAll("i").map((id) => parseGReaderItemId(String(id)));
      const add = form.getAll("a").map(String);
      const remove = form.getAll("r").map(String);
      for (const articleId of ids) {
        await applyTagEdit(user.id, articleId, add, remove);
      }
      return okResponse();
    }

    return NextResponse.json({ error: "Unsupported Google Reader endpoint", path }, { status: 404 });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
