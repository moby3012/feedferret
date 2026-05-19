export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

type FeverUser = { id: string; email: string | null };

async function authenticateFever(
  params: URLSearchParams,
  body: Record<string, string>,
): Promise<FeverUser | null> {
  const apiKey = body.api_key || params.get("api_key");
  if (!apiKey) return null;

  try {
    const token = await db.apiToken.findFirst({
      where: { feverKey: apiKey },
      include: { user: { select: { id: true, email: true, isActive: true } } },
    });
    if (token?.user?.isActive) return token.user;
  } catch {
    // ApiToken model not yet available
  }
  return null;
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function baseResponse(auth: 0 | 1) {
  return { api_version: 3, auth, last_refreshed_on_time: unixNow() };
}

async function getGroups(userId: string) {
  const categories = await db.category.findMany({
    where: { userId },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
  return categories.map((c) => ({ id: c.id, title: c.name }));
}

async function getFeedsAndGroups(userId: string) {
  const feeds = await db.feed.findMany({
    where: { userId },
    include: { category: true },
    orderBy: { name: "asc" },
  });

  const feverFeeds = feeds.map((f) => ({
    id: f.id,
    favicon_id: f.id,
    title: f.name,
    url: f.url,
    site_url: f.htmlUrl || f.url,
    is_spark: 0,
    last_updated_on_time: f.lastFetchedAt
      ? Math.floor(f.lastFetchedAt.getTime() / 1000)
      : 0,
    group_id: f.categoryId || "",
  }));

  // Group by categoryId
  const groupMap = new Map<string, string[]>();
  for (const f of feeds) {
    const gid = f.categoryId || "0";
    if (!groupMap.has(gid)) groupMap.set(gid, []);
    groupMap.get(gid)!.push(f.id);
  }
  const feedsGroups = Array.from(groupMap.entries()).map(
    ([group_id, feed_ids]) => ({
      group_id,
      feed_ids: feed_ids.join(","),
    }),
  );

  return { feeds: feverFeeds, feeds_groups: feedsGroups };
}

async function getItems(
  userId: string,
  params: URLSearchParams,
  body: Record<string, string>,
) {
  const sinceId = params.get("since_id") || body.since_id;
  const maxId = params.get("max_id") || body.max_id;
  const withIds = (params.get("with_ids") || body.with_ids)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const where: Record<string, unknown> = { userId };

  if (withIds?.length) {
    where.id = { in: withIds };
  } else if (sinceId) {
    // Use createdAt cursor: since_id is an id string, compare by createdAt
    const pivot = await db.article.findFirst({
      where: { id: sinceId },
      select: { createdAt: true },
    });
    if (pivot) where.createdAt = { gt: pivot.createdAt };
  } else if (maxId) {
    const pivot = await db.article.findFirst({
      where: { id: maxId },
      select: { createdAt: true },
    });
    if (pivot) where.createdAt = { lt: pivot.createdAt };
  }

  const articles = await db.article.findMany({
    where,
    orderBy: { publishedAt: "desc" },
    take: withIds?.length ? undefined : 50,
    select: {
      id: true,
      feedId: true,
      title: true,
      author: true,
      content: true,
      link: true,
      isStarred: true,
      isRead: true,
      publishedAt: true,
      createdAt: true,
    },
  });

  return articles.map((a) => ({
    id: a.id,
    feed_id: a.feedId,
    title: a.title,
    author: a.author || "",
    html: a.content,
    url: a.link,
    is_saved: a.isStarred ? 1 : 0,
    is_read: a.isRead ? 1 : 0,
    created_on_time: Math.floor(a.publishedAt.getTime() / 1000),
  }));
}

async function getUnreadIds(userId: string): Promise<string> {
  const articles = await db.article.findMany({
    where: { userId, isRead: false },
    select: { id: true },
    orderBy: { publishedAt: "desc" },
    take: 10_000,
  });
  return articles.map((a) => a.id).join(",");
}

async function getSavedIds(userId: string): Promise<string> {
  const articles = await db.article.findMany({
    where: { userId, isStarred: true },
    select: { id: true },
    orderBy: { publishedAt: "desc" },
    take: 10_000,
  });
  return articles.map((a) => a.id).join(",");
}

async function handleMark(
  userId: string,
  params: URLSearchParams,
  body: Record<string, string>,
) {
  const mark = params.get("mark") || body.mark;
  const as_ = params.get("as") || body.as;
  const id = params.get("id") || body.id;
  const before = params.get("before") || body.before;

  if (!mark || !as_ || !id) return;

  if (mark === "item") {
    const data: Record<string, unknown> = {};
    if (as_ === "read") {
      data.isRead = true;
      data.readAt = new Date();
    } else if (as_ === "unread") {
      data.isRead = false;
      data.readAt = null;
    } else if (as_ === "saved") {
      data.isStarred = true;
    } else if (as_ === "unsaved") {
      data.isStarred = false;
    }
    if (Object.keys(data).length) {
      await db.article.updateMany({ where: { id, userId }, data });
    }
  } else if (mark === "feed" && as_ === "read") {
    const beforeDate = before ? new Date(Number(before) * 1000) : new Date();
    await db.article.updateMany({
      where: {
        feedId: id,
        userId,
        isRead: false,
        publishedAt: { lte: beforeDate },
      },
      data: { isRead: true, readAt: new Date() },
    });
  } else if (mark === "group" && as_ === "read") {
    const beforeDate = before ? new Date(Number(before) * 1000) : new Date();
    if (id === "0") {
      // Special group ID 0 = all feeds
      await db.article.updateMany({
        where: { userId, isRead: false, publishedAt: { lte: beforeDate } },
        data: { isRead: true, readAt: new Date() },
      });
    } else {
      await db.article.updateMany({
        where: {
          userId,
          isRead: false,
          publishedAt: { lte: beforeDate },
          feed: { categoryId: id },
        },
        data: { isRead: true, readAt: new Date() },
      });
    }
  }
}

async function handle(request: Request) {
  try {
    const url = new URL(request.url);
    const params = url.searchParams;

    // Parse body for POST requests
    let body: Record<string, string> = {};
    if (request.method === "POST") {
      try {
        const ct = request.headers.get("content-type") || "";
        if (ct.includes("application/x-www-form-urlencoded")) {
          const text = await request.text();
          new URLSearchParams(text).forEach((v, k) => {
            body[k] = v;
          });
        } else if (ct.includes("application/json")) {
          body = await request.json();
        }
      } catch {
        /* ignore parse errors */
      }
    }

    if (!params.has("api")) {
      return NextResponse.json(
        { error: "Fever API endpoint. Append ?api to use." },
        { status: 400 },
      );
    }

    const user = await authenticateFever(params, body);
    if (!user) {
      return NextResponse.json(baseResponse(0));
    }

    const result: Record<string, unknown> = { ...baseResponse(1) };

    // Handle mark (write) operations
    if (params.has("mark") || body.mark) {
      await handleMark(user.id, params, body);
    }

    if (params.has("feeds") || params.has("groups")) {
      const groups = await getGroups(user.id);
      result.groups = groups;
      if (params.has("feeds")) {
        const { feeds, feeds_groups } = await getFeedsAndGroups(user.id);
        result.feeds = feeds;
        result.feeds_groups = feeds_groups;
      } else {
        const { feeds_groups } = await getFeedsAndGroups(user.id);
        result.feeds_groups = feeds_groups;
      }
    }

    if (params.has("items")) {
      result.items = await getItems(user.id, params, body);
      result.total_items = await db.article.count({ where: { userId: user.id } });
    }

    if (params.has("links")) {
      result.links = [];
    }

    if (params.has("favicons")) {
      result.favicons = [];
    }

    if (params.has("unread_item_ids")) {
      result.unread_item_ids = await getUnreadIds(user.id);
    }

    if (params.has("saved_item_ids")) {
      result.saved_item_ids = await getSavedIds(user.id);
    }

    return NextResponse.json(result);
  } catch (error) {
    logger.error("[api/fever]", error);
    return NextResponse.json(baseResponse(0), { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
