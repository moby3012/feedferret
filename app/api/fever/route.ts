export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { decimalExternalId, storedExternalId } from "@/lib/external-ids";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isLegacyFeverKey } from "@/lib/fever-keys";
import { hashApiToken } from "@/lib/token";
import { touchApiPassword } from "@/lib/greader";
import { logger } from "@/lib/logger";
import { checkRateLimit, peekRateLimit, getClientIdentifier, RATE_LIMITS, rateLimitResponse } from "@/lib/rate-limit";
import { renderMarkdownToHtml } from "@/lib/markdown-render";

function numericIds(value: string): string[] {
  return value.split(",").flatMap((part) => {
    try { return [storedExternalId(part.trim())]; } catch { return []; }
  });
}

type FeverUser = { id: string; email: string | null; tokenScope: string };

async function authenticateFever(
  params: URLSearchParams,
  body: Record<string, string>,
): Promise<FeverUser | null> {
  const apiKey = body.api_key || params.get("api_key");
  if (!apiKey) return null;

  const keyHash = hashApiToken(apiKey);
  let passwordUser = await db.user.findUnique({ where: { apiFeverKey: keyHash } });
  if (!passwordUser && isLegacyFeverKey(apiKey)) {
    const legacy = await db.user.findUnique({ where: { apiFeverKey: apiKey } });
    if (legacy) {
      await db.user.updateMany({ where: { id: legacy.id, apiFeverKey: apiKey }, data: { apiFeverKey: keyHash } });
      // Reload after the CAS: concurrent backfill is fine; rotation/revocation is not.
      passwordUser = await db.user.findUnique({ where: { apiFeverKey: keyHash } });
    }
  }
  if (passwordUser?.isActive && passwordUser.apiPasswordHash) {
    await touchApiPassword(passwordUser.id, passwordUser.apiPasswordLastUsedAt);
    return { id: passwordUser.id, email: passwordUser.email, tokenScope: "write" };
  }
  let token = await db.apiToken.findFirst({
    where: { feverKey: hashApiToken(apiKey) },
    include: { user: { select: { id: true, email: true, isActive: true } } },
  });
  if (!token && isLegacyFeverKey(apiKey)) {
    const legacy = await db.apiToken.findFirst({ where: { feverKey: apiKey } });
    if (legacy) {
      await db.apiToken.updateMany({ where: { id: legacy.id, feverKey: apiKey }, data: { feverKey: keyHash } });
      token = await db.apiToken.findFirst({ where: { feverKey: keyHash }, include: { user: { select: { id: true, email: true, isActive: true } } } });
    }
  }
  if (token?.user?.isActive && (!token.expiresAt || token.expiresAt > new Date())) return { ...token.user, tokenScope: token.scope };
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
    select: { extId: true, name: true },
  });
  return categories.filter((c) => c.extId).map((c) => ({ id: decimalExternalId(c.extId), title: c.name }));
}

async function getFeedsAndGroups(userId: string) {
  const feeds = await db.feed.findMany({
    where: { userId },
    include: { category: true },
    orderBy: { name: "asc" },
  });

  const feverFeeds = feeds.filter((f) => f.extId).map((f) => ({
    id: decimalExternalId(f.extId), favicon_id: decimalExternalId(f.extId),
    title: f.name, url: f.url, site_url: f.htmlUrl || f.url, is_spark: 0,
    last_updated_on_time: f.lastFetchedAt ? Math.floor(f.lastFetchedAt.getTime() / 1000) : 0,
  }));
  const groupMap = new Map<string, string[]>();
  for (const f of feeds.filter((f) => f.extId)) {
    const gid = f.category?.extId ? decimalExternalId(f.category.extId) : "0";
    if (!groupMap.has(gid)) groupMap.set(gid, []);
    groupMap.get(gid)!.push(decimalExternalId(f.extId));
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

  const where: Record<string, unknown> = { userId, extId: { not: null }, feed: { extId: { not: null } } };

  // Invalid since_id/max_id values are ignored entirely (filter AND sort order).
  const since = sinceId ? numericIds(sinceId)[0] : undefined;
  const max = maxId && maxId.trim() !== "0" ? numericIds(maxId)[0] : undefined;
  if (withIds?.length) where.extId = { in: numericIds(withIds.join(",")) };
  else where.extId = { not: null, ...(since ? { gt: since } : {}), ...(max ? { lt: max } : {}) };
  const feedIds = params.get("feed_ids")?.split(",").filter(Boolean);
  const groupIds = params.get("group_ids")?.split(",").filter(Boolean);
  if (feedIds?.length) where.feed = { extId: { in: numericIds(feedIds.join(",")) }, userId };
  if (groupIds?.length) where.AND = [{ feed: { userId, category: { userId, extId: { in: numericIds(groupIds.join(",")) } } } }];

  const articles = await db.article.findMany({
    where: { AND: [where, { feed: { extId: { not: null } } }] },
    orderBy: { extId: since ? "asc" : "desc" },
    take: 50,
    select: {
      id: true,
      extId: true,
      feed: { select: { extId: true } },
      title: true,
      author: true,
      content: true,
      contentFormat: true,
      link: true,
      isStarred: true,
      isRead: true,
      publishedAt: true,
      createdAt: true,
    },
  });

  return Promise.all(
    articles.filter((a) => a.extId && a.feed.extId).map(async (a) => ({
      id: decimalExternalId(a.extId),
      feed_id: decimalExternalId(a.feed.extId),
      title: a.title,
      author: a.author || "",
      html: a.contentFormat === "markdown" && a.content ? await renderMarkdownToHtml(a.content) : a.content,
      url: a.link,
      is_saved: a.isStarred ? 1 : 0,
      is_read: a.isRead ? 1 : 0,
      created_on_time: Math.floor(a.publishedAt.getTime() / 1000),
    })),
  );
}

async function getUnreadIds(userId: string): Promise<string> {
  const articles = await db.article.findMany({
    where: { userId, isRead: false },
    select: { extId: true },
    orderBy: { publishedAt: "desc" },
  });
  return articles.filter((a) => a.extId).map((a) => decimalExternalId(a.extId)).join(",");
}

async function getSavedIds(userId: string): Promise<string> {
  const articles = await db.article.findMany({
    where: { userId, isStarred: true },
    select: { extId: true },
    orderBy: { publishedAt: "desc" },
  });
  return articles.filter((a) => a.extId).map((a) => decimalExternalId(a.extId)).join(",");
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

  const withIds = params.get("with_ids") || body.with_ids;
  if (!mark || !as_ || (!id && !withIds)) return;
  const beforeDate = before ? new Date(Number(before) * 1000) : new Date();
  if (!Number.isFinite(beforeDate.getTime())) return;

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
      await db.article.updateMany({ where: { extId: { in: numericIds(withIds || id!) }, userId, ...(before ? { createdAt: { lte: beforeDate } } : {}) }, data });
    }
  } else if (mark === "feed" && as_ === "read") {
    await db.article.updateMany({
      where: {
        feed: { userId, extId: { in: numericIds(id || "") } },
        userId,
        isRead: false,
        createdAt: { lte: beforeDate },
      },
      data: { isRead: true, readAt: new Date() },
    });
  } else if (mark === "group" && as_ === "read") {
    if (id?.trim() === "0") {
      // Special group ID 0 = all feeds
      await db.article.updateMany({
        where: { userId, isRead: false, createdAt: { lte: beforeDate } },
        data: { isRead: true, readAt: new Date() },
      });
    } else {
      await db.article.updateMany({
        where: {
          userId,
          isRead: false,
          createdAt: { lte: beforeDate },
          feed: { userId, category: { userId, extId: { in: numericIds(id || "") } } },
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
        if (ct.includes("multipart/form-data")) {
          const form = await request.formData();
          form.forEach((v, k) => { if (typeof v === "string") body[k] = v; });
        } else if (ct.includes("application/x-www-form-urlencoded")) {
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

    Object.entries(body).forEach(([k, v]) => params.set(k, v));

    if (!params.has("api")) {
      return NextResponse.json(
        { error: "Fever API endpoint. Append ?api to use." },
        { status: 400 },
      );
    }

    const ip = getClientIdentifier(request);
    const authLimit = { ...RATE_LIMITS.authSignIn, prefix: "greader-ip" };
    if (!peekRateLimit(ip, authLimit).success) return NextResponse.json(baseResponse(0));
    const user = await authenticateFever(params, body);
    if (!user) {
      checkRateLimit(ip, authLimit);
      return NextResponse.json(baseResponse(0));
    }

    const rl = checkRateLimit(getClientIdentifier(request, user.id), RATE_LIMITS.fever);
    if (!rl.success) return rateLimitResponse(rl);

    const result: Record<string, unknown> = { ...baseResponse(1) };

    // Handle mark (write) operations
    if (params.has("mark") || body.mark) {
      if (!["write", "admin"].includes(user.tokenScope)) return NextResponse.json({ api_version: 3, auth: 1, error: "Insufficient token scope" }, { status: 403 });
      await handleMark(user.id, params, body);
      result.unread_item_ids = await getUnreadIds(user.id);
      result.saved_item_ids = await getSavedIds(user.id);
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
      const feeds = await db.feed.findMany({ where: { userId: user.id }, select: { extId: true, icon: true } });
      result.favicons = feeds.filter((feed) => feed.extId).map((feed) => ({ id: decimalExternalId(feed.extId), data: feed.icon?.startsWith("data:") ? feed.icon : "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=" }));
    }

    if (params.has("unread_item_ids")) {
      result.unread_item_ids = await getUnreadIds(user.id);
    }

    if (params.has("saved_item_ids")) {
      result.saved_item_ids = await getSavedIds(user.id);
    }

    const refresh = await db.feed.aggregate({ where: { userId: user.id }, _max: { lastFetchedAt: true } });
    result.last_refreshed_on_time = refresh._max.lastFetchedAt ? Math.floor(refresh._max.lastFetchedAt.getTime() / 1000) : 0;
    // Emit JSON integer tokens without passing identities through Number.
    return new NextResponse(JSON.stringify(result).replace(/"(id|feed_id|favicon_id|group_id)":"(\d+)"/g, '"$1":$2'), { headers: { "content-type": "application/json" } });
  } catch (error) {
    logger.error("[api/fever]", error);
    return NextResponse.json({ ...baseResponse(1), error: "Internal server error" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
