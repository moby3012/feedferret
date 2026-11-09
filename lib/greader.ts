import { Prisma } from "@prisma/client";
import crypto from "crypto";
import { checkRateLimit, peekRateLimit, getClientIdentifier, RATE_LIMITS } from "@/lib/rate-limit";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { renderMarkdownToHtml } from "@/lib/markdown-render";

export const GREADER_READING_LIST = "user/-/state/com.google/reading-list";
export const GREADER_UNREAD = "user/-/state/com.google/unread";
export const GREADER_MAIN = "user/-/state/org.freshrss/main";
export const GREADER_IMPORTANT = "user/-/state/org.freshrss/important";
export const GREADER_READ = "user/-/state/com.google/read";
export const GREADER_STARRED = "user/-/state/com.google/starred";
export const GREADER_KEEP_UNREAD = "user/-/state/com.google/kept-unread";
export const GREADER_BROADCAST = "user/-/state/com.google/broadcast";
export const GREADER_LIKE = "user/-/state/com.google/like";
export const GREADER_LABEL_PREFIX = "user/-/label/";

function secret() {
  const value = process.env.AUTH_SECRET;
  if (value) return value;
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return "build-time-secret-only";
  }
  throw new Error("AUTH_SECRET must be set for Google Reader API tokens.");
}

export function createGReaderToken(userId: string) {
  const sig = crypto.createHmac("sha256", secret()).update(userId).digest("hex");
  return `${userId}.${sig}`;
}

export function verifyGReaderToken(token: string) {
  const [userId, sig] = token.split(".");
  if (!userId || !sig) return null;
  const expected = crypto.createHmac("sha256", secret()).update(userId).digest("hex");
  if (sig.length !== expected.length) return null;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? userId : null;
}

/** Shared password path: throttle both identity and source before bcrypt. */
export async function authenticateGReaderPassword(request: Request, email: string, password: string) {
  const ip = getClientIdentifier(request);
  const identity = email.trim().toLowerCase();
  const ipConfig = { ...RATE_LIMITS.authSignIn, prefix: "greader-ip" };
  const emailConfig = { ...RATE_LIMITS.authSignIn, prefix: "greader-email" };
  const ipLimit = peekRateLimit(ip, ipConfig);
  const accountLimit = peekRateLimit(identity, emailConfig);
  let user: Awaited<ReturnType<typeof db.user.findUnique>> = null;
  let failReason: string | undefined;
  if (!ipLimit.success || !accountLimit.success) failReason = "rate_limit";
  else {
    user = email ? await db.user.findUnique({ where: { email } }) : null;
    if (!user?.password) failReason = "no_account";
    else if (!user.isActive) failReason = "inactive";
    else if (user.twoFactorEnabled) failReason = "otp";
    else if (!(await bcrypt.compare(password, user.password))) failReason = "password";
  }
  if (!failReason) return user;
  if (failReason !== "rate_limit") {
    checkRateLimit(ip, ipConfig);
    checkRateLimit(identity, emailConfig);
  }
  try {
    await db.loginAttempt.create({ data: {
      email, userId: user?.id, success: !failReason, failReason,
      ip: ip.replace(/^ip:/, ""), userAgent: request.headers.get("user-agent"),
    } });
  } catch { /* Audit failures must not crash authentication. */ }
  return failReason ? null : user;
}

export async function authenticateGReaderRequest(request: Request) {
  const header = request.headers.get("authorization") || "";
  const googleLogin = header.match(/GoogleLogin\s+auth=(.+)$/i);
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  const token = googleLogin?.[1] || bearer?.[1];
  if (token) {
    const userId = verifyGReaderToken(token.trim());
    if (userId) {
      const user = await db.user.findUnique({ where: { id: userId } });
      if (user?.isActive) return user;
    }
  }

  if (header.startsWith("Basic ")) {
    const raw = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = raw.indexOf(":");
    if (separator > 0) return authenticateGReaderPassword(request, raw.slice(0, separator), raw.slice(separator + 1));
  }

  return null;
}

export function greaderItemId(articleId: string) {
  return `tag:feedferret,2026:article/${articleId}`;
}

export function parseGReaderItemId(id: string) {
  // Keep identity conversion isolated for the forthcoming persistent numeric adapter.
  if (id.startsWith("tag:google.com,2005:reader/item/") || (/^[0-9a-f]{16}$/i.test(id) && (id.startsWith("0") || /[a-f]/i.test(id)))) {
    const hex = id.slice(id.lastIndexOf("/") + 1);
    if (/^[0-9a-f]+$/i.test(hex)) return BigInt(`0x${hex}`).toString();
  }
  return id.split("/").pop() || id;
}

export function getGReaderStreamTitle(streamId?: string | null) {
  if (!streamId || streamId === GREADER_READING_LIST) return "Reading List";
  if (streamId === GREADER_STARRED) return "Starred";
  if (streamId === GREADER_READ) return "Read";
  if (streamId.startsWith("feed/")) return streamId.slice(5);
  if (streamId.startsWith(GREADER_LABEL_PREFIX)) return streamId.slice(GREADER_LABEL_PREFIX.length);
  return streamId;
}

export function parseGReaderStreamId(streamId?: string | null) {
  if (!streamId || streamId === GREADER_READING_LIST) return { type: "reading-list" as const };
  if (streamId === GREADER_STARRED) return { type: "starred" as const };
  if (streamId === GREADER_READ) return { type: "read" as const };
  if (streamId.startsWith("feed/")) return { type: "feed" as const, value: streamId.slice(5) };
  if (streamId.startsWith(GREADER_LABEL_PREFIX)) return { type: "label" as const, value: streamId.slice(GREADER_LABEL_PREFIX.length) };
  return { type: "unknown" as const, value: streamId };
}

export type GReaderContinuation = { createdAt: Date; id: string; ceiling?: { createdAt: string; id: string } } | null;

export function parseContinuationToken(token?: string | null): GReaderContinuation {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    const createdAt = new Date(parsed.createdAt);
    if (typeof parsed.id !== "string" || !Number.isFinite(createdAt.getTime())) return null;
    if (parsed.ceiling && (typeof parsed.ceiling.id !== "string" || !Number.isFinite(new Date(parsed.ceiling.createdAt).getTime()))) return null;
    return { createdAt, id: parsed.id, ceiling: parsed.ceiling };
  } catch { return null; }
}

export function createContinuationToken(article: { createdAt: Date; id: string }, ceiling?: { createdAt: string; id: string }) {
  return Buffer.from(JSON.stringify({ createdAt: article.createdAt.toISOString(), id: article.id, ceiling })).toString("base64url");
}

// ID sync supports large/unlimited pages; full contents have a separate bound.
export function greaderLimit(value: string | null) {
  const n = value?.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : 20;
}

export function normalizeCategoryNameFromTag(tag: string) {
  if (!tag.startsWith(GREADER_LABEL_PREFIX)) return null;
  const name = decodeURIComponent(tag.slice(GREADER_LABEL_PREFIX.length)).trim();
  return name || null;
}

export function isKnownGReaderStream(streamId: string) {
  return [GREADER_UNREAD, GREADER_MAIN, GREADER_IMPORTANT].includes(streamId) || parseGReaderStreamId(streamId).type !== "unknown";
}

export function normalizeGReaderReadStream(streamId: string) {
  return isKnownGReaderStream(streamId) ? streamId : GREADER_READING_LIST;
}

function streamPredicate(userId: string, streamId?: string | null): any {
  const stream = parseGReaderStreamId(streamId);
  if (streamId === GREADER_UNREAD) return { isRead: false };
  if (streamId === GREADER_MAIN) return { feed: { priority: { in: ["main", "important"] } } };
  if (streamId === GREADER_IMPORTANT) return { feed: { priority: "important" } };
  if (stream.type === "reading-list") return { feed: { priority: { in: ["category", "main", "important"] } } };
  if (stream.type === "starred") return { isStarred: true };
  if (stream.type === "read") return { isRead: true };
  if (stream.type === "feed") return { feed: { url: stream.value } };
  if (stream.type === "label") return { OR: [
    { labels: { some: { label: { userId, name: stream.value } } } },
    { feed: { priority: { in: ["category", "main", "important"] }, category: { userId, name: stream.value } } },
  ] };
  // Mutations remain fail-closed; read callers normalize unknown primary streams.
  return { id: { in: [] } };
}

export function buildStreamWhere(userId: string, streamId?: string | null, includeStates: string[] = [], excludeStates: string[] = [], oldestSec?: number | null, newestSec?: number | null) {
  const AND: any[] = [streamPredicate(userId, streamId),
    ...([GREADER_READ, GREADER_UNREAD].includes(streamId || "") ? [{ feed: { priority: { in: ["category", "main", "important"] } } }] : []),
    ...(streamId === GREADER_STARRED ? [{ feed: { priority: { not: "hidden" } } }] : []),
    ...includeStates.filter(isKnownGReaderStream).map((state) => streamPredicate(userId, state)),
    ...excludeStates.filter(isKnownGReaderStream).map((state) => ({ NOT: streamPredicate(userId, state) })),
  ];
  // FreshRSS EntryDAO compares discovery ID and lastModified, never publication.
  // updatedAt is FeedFerret's combined content/state modification clock.
  if (oldestSec && Number.isFinite(oldestSec)) {
    const gte = new Date(Math.trunc(oldestSec) * 1000);
    AND.push({ OR: [{ createdAt: { gte } }, { updatedAt: { gte } }] });
  }
  if (newestSec && Number.isFinite(newestSec)) {
    const lte = new Date(Math.trunc(newestSec) * 1000);
    AND.push({ createdAt: { lte }, updatedAt: { lt: new Date((Math.trunc(newestSec) + 1) * 1000) } });
  }
  return { userId, AND };
}

export function buildCursorWhere(continuation: GReaderContinuation, ascending = false) {
  if (!continuation) return {};
  const op = ascending ? "gt" : "lt";
  return { OR: [
    { createdAt: { [op]: continuation.createdAt } },
    { createdAt: continuation.createdAt, id: { [op]: continuation.id } },
  ] };
}

export async function listGReaderStreamPrefs(userId: string) {
  const prefs = await db.gReaderPreference.findMany({
    where: { userId },
    orderBy: [{ streamId: "asc" }, { key: "asc" }],
  });

  const grouped = new Map<string, Array<{ id: string; value: string }>>();
  for (const pref of prefs) {
    const values = grouped.get(pref.streamId) || [];
    values.push({ id: pref.key, value: pref.value });
    grouped.set(pref.streamId, values);
  }

  return Array.from(grouped.entries()).map(([id, value]) => ({ id, value }));
}

export async function upsertGReaderStreamPref(userId: string, streamId: string, key: string, value: string) {
  return db.gReaderPreference.upsert({
    where: {
      userId_streamId_key: {
        userId,
        streamId,
        key,
      },
    },
    update: { value },
    create: {
      userId,
      streamId,
      key,
      value,
    },
  });
}

export async function deleteGReaderStreamPref(userId: string, streamId: string, key: string) {
  return db.gReaderPreference.deleteMany({
    where: {
      userId,
      streamId,
      key,
    },
  });
}

export async function listGReaderTags(userId: string) {
  const [labels, categories] = await Promise.all([
    db.label.findMany({ where: { userId }, orderBy: { name: "asc" } }),
    db.category.findMany({ where: { userId }, orderBy: { name: "asc" } }),
  ]);

  const systemTags = [
    GREADER_READING_LIST,
    GREADER_READ,
    GREADER_UNREAD,
    GREADER_MAIN,
    GREADER_IMPORTANT,
    GREADER_STARRED,
    GREADER_BROADCAST,
    GREADER_KEEP_UNREAD,
    GREADER_LIKE,
  ].map((id) => ({ id, type: "state", sortid: id }));

  const seen = new Set<string>();
  const customTags = [...categories, ...labels].flatMap((item) => {
    const name = item.name.trim();
    if (!name || seen.has(name)) return [];
    seen.add(name);
    return [{ id: `${GREADER_LABEL_PREFIX}${name}`, type: "label", sortid: name }];
  });

  return [...systemTags, ...customTags];
}

export async function countGReaderUnread(userId: string, streamId: string) {
  const scope = buildStreamWhere(userId, streamId);
  const [count, newest] = await Promise.all([
    db.article.count({ where: { AND: [scope, { isRead: false }] } }),
    db.article.findFirst({ where: scope, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { createdAt: true } }),
  ]);
  return { id: streamId, count, newestItemTimestampUsec: newest ? String(newest.createdAt.getTime() * 1000) : "0" };
}

/** Constant query count regardless of subscription/tag count. */
export async function countGReaderFeedsAndTags(userId: string) {
  const [feeds, categories, labels, unread, tagged] = await Promise.all([
    db.feed.findMany({ where: { userId }, select: { id: true, url: true, priority: true, categoryId: true } }),
    db.category.findMany({ where: { userId }, select: { id: true, name: true } }),
    db.label.findMany({ where: { userId }, select: { name: true } }),
    db.article.groupBy({ by: ["feedId"], where: { userId, isRead: false }, _count: true, _max: { createdAt: true } }),
    // Exclude folder matches from label totals to count the folder/label union once.
    // COUNT and timestamps are normalized below for SQLite and PostgreSQL adapters.
    db.$queryRaw<Array<{ name: string; count: bigint | number; newest: Date | string | number | null }>>(Prisma.sql`
      SELECT l."name", COUNT(*) AS "count", MAX(a."createdAt") AS "newest"
      FROM "ArticleLabel" al
      JOIN "Label" l ON l."id" = al."labelId"
      JOIN "Article" a ON a."id" = al."articleId"
      JOIN "Feed" f ON f."id" = a."feedId"
      LEFT JOIN "Category" c ON c."id" = f."categoryId"
      WHERE al."userId" = ${userId} AND l."userId" = ${userId}
        AND a."userId" = ${userId} AND a."isRead" = false
        AND NOT (f."priority" IN ('category', 'main', 'important')
          AND COALESCE(c."userId", '') = ${userId} AND COALESCE(c."name", '') = l."name"
          AND c."id" IS NOT NULL)
      GROUP BY l."name"
    `),
  ]);
  const byFeed = new Map(unread.map((row) => [row.feedId, row]));
  const categoryNames = new Map(categories.map((row) => [row.id, row.name]));
  const tags = new Map([...categories, ...labels].map((row) => [row.name, { count: 0, newest: 0 }]));
  const result = (id: string, count: number, newest: number) => ({ id, count, newestItemTimestampUsec: String(newest * 1000) });
  const feedCounts = feeds.flatMap((feed) => {
    const row = byFeed.get(feed.id);
    const count = row?._count ?? 0;
    const newest = row?._max.createdAt?.getTime() ?? 0;
    const name = feed.categoryId ? categoryNames.get(feed.categoryId) : undefined;
    if (name && ["category", "main", "important"].includes(feed.priority)) {
      const tag = tags.get(name)!;
      tag.count += count; tag.newest = Math.max(tag.newest, newest);
    }
    return feed.priority === "hidden" ? [] : [result(`feed/${feed.url}`, count, newest)];
  });
  for (const row of tagged) {
    const tag = tags.get(row.name)!;
    tag.count += Number(row.count);
    tag.newest = Math.max(tag.newest, row.newest === null ? 0 : new Date(row.newest).getTime());
  }
  return [...feedCounts, ...Array.from(tags, ([name, tag]) => result(`${GREADER_LABEL_PREFIX}${name}`, tag.count, tag.newest))];
}

export async function toGReaderArticle(article: any) {
  const timestampUsec = new Date(article.createdAt).getTime() * 1000;
  const content =
    article.contentFormat === "markdown" && article.content
      ? await renderMarkdownToHtml(article.content)
      : article.content;
  let enclosures;
  try {
    const parsed = article.enclosures ? JSON.parse(article.enclosures) : null;
    if (Array.isArray(parsed)) enclosures = parsed;
  } catch { /* Corrupt feed metadata must not break a sync page. */ }
  return {
    id: greaderItemId(article.id),
    crawlTimeMsec: String(new Date(article.createdAt).getTime()),
    timestampUsec: String(timestampUsec),
    published: Math.floor(new Date(article.publishedAt).getTime() / 1000),
    updated: Math.floor(new Date(article.updatedAt ?? article.publishedAt).getTime() / 1000),
    title: article.title,
    canonical: article.link ? [{ href: article.link }] : [],
    alternate: article.link ? [{ href: article.link }] : [],
    categories: [...new Set([
      GREADER_READING_LIST,
      ...(article.isRead ? [GREADER_READ] : []),
      ...(["main", "important"].includes(article.feed?.priority) ? [GREADER_MAIN] : []),
      ...(article.feed?.priority === "important" ? [GREADER_IMPORTANT] : []),
      ...(article.feed?.priority === "hidden" ? ["user/-/state/org.freshrss/hidden"] : []),
      ...(article.isStarred ? [GREADER_STARRED] : []),
      ...(article.feed?.category?.name ? [`${GREADER_LABEL_PREFIX}${article.feed.category.name}`] : []),
      ...(article.labels || []).map((item: any) => `${GREADER_LABEL_PREFIX}${item.label.name}`),
    ])],
    origin: {
      streamId: `feed/${article.feed.url}`,
      title: article.feed.name,
      htmlUrl: article.feed.htmlUrl || article.feed.url,
    },
    ...(article.author?.trim() ? { author: article.author } : {}),
    summary: { content: content || article.excerpt || "" },
    ...(enclosures ? { enclosure: enclosures } : {}),
    content: { content: content || article.excerpt || "" },
  };
}

export function toGReaderItemRef(article: any) {
  return {
    id: greaderItemId(article.id),
    directStreamIds: [
      `feed/${article.feed.url}`,
      ...(article.feed?.category?.name ? [`${GREADER_LABEL_PREFIX}${article.feed.category.name}`] : []),
    ],
    timestampUsec: String(new Date(article.createdAt).getTime() * 1000),
  };
}
