import crypto from "crypto";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";

export const GREADER_READING_LIST = "user/-/state/com.google/reading-list";
export const GREADER_READ = "user/-/state/com.google/read";
export const GREADER_STARRED = "user/-/state/com.google/starred";
export const GREADER_KEEP_UNREAD = "user/-/state/com.google/kept-unread";
export const GREADER_BROADCAST = "user/-/state/com.google/broadcast";
export const GREADER_LIKE = "user/-/state/com.google/like";
export const GREADER_LABEL_PREFIX = "user/-/label/";

function secret() {
  return process.env.NEXTAUTH_SECRET || "feedferret-dev-secret";
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

export async function authenticateGReaderRequest(request: Request) {
  const header = request.headers.get("authorization") || "";
  const googleLogin = header.match(/GoogleLogin\s+auth=(.+)$/i);
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  const token = googleLogin?.[1] || bearer?.[1];
  if (token) {
    const userId = verifyGReaderToken(token.trim());
    if (userId) {
      const user = await db.user.findUnique({ where: { id: userId } });
      if (user) return user;
    }
  }

  if (header.startsWith("Basic ")) {
    const raw = Buffer.from(header.slice(6), "base64").toString("utf8");
    const [email, password] = raw.split(":");
    if (email && password) {
      const user = await db.user.findUnique({ where: { email } });
      if (user?.twoFactorEnabled) return null;
      if (user?.password && await bcrypt.compare(password, user.password)) return user;
    }
  }

  return null;
}

export function greaderItemId(articleId: string) {
  return `tag:feedferret,2026:article/${articleId}`;
}

export function parseGReaderItemId(id: string) {
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

export function parseContinuationToken(token?: string | null) {
  if (!token) return 0;
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const value = Number(decoded);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function createContinuationToken(offset: number) {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

export function normalizeCategoryNameFromTag(tag: string) {
  if (!tag.startsWith(GREADER_LABEL_PREFIX)) return null;
  const name = decodeURIComponent(tag.slice(GREADER_LABEL_PREFIX.length)).trim();
  return name || null;
}

export function buildStreamWhere(userId: string, streamId?: string | null, includeStates: string[] = [], excludeStates: string[] = []) {
  const where: any = { userId };
  const stream = parseGReaderStreamId(streamId);

  if (stream.type === "starred") where.isStarred = true;
  else if (stream.type === "read") where.isRead = true;
  else if (stream.type === "feed") where.feed = { url: stream.value };
  else if (stream.type === "label") {
    where.labels = {
      some: {
        label: {
          userId,
          name: stream.value,
        },
      },
    };
  }

  for (const state of includeStates) {
    if (state === GREADER_STARRED) where.isStarred = true;
    if (state === GREADER_READ) where.isRead = true;
  }

  for (const state of excludeStates) {
    if (state === GREADER_STARRED) where.isStarred = false;
    if (state === GREADER_READ) where.isRead = false;
    const labelName = normalizeCategoryNameFromTag(state);
    if (labelName) {
      where.NOT = [
        ...(Array.isArray(where.NOT) ? where.NOT : where.NOT ? [where.NOT] : []),
        {
          labels: {
            some: {
              label: {
                userId,
                name: labelName,
              },
            },
          },
        },
      ];
    }
  }

  return where;
}

export function toGReaderArticle(article: any) {
  const timestampUsec = new Date(article.publishedAt).getTime() * 1000;
  return {
    id: greaderItemId(article.id),
    crawlTimeMsec: String(new Date(article.createdAt).getTime()),
    timestampUsec: String(timestampUsec),
    published: Math.floor(new Date(article.publishedAt).getTime() / 1000),
    updated: Math.floor(new Date(article.updatedAt ?? article.publishedAt).getTime() / 1000),
    title: article.title,
    canonical: article.link ? [{ href: article.link }] : [],
    alternate: article.link ? [{ href: article.link, type: "text/html" }] : [],
    categories: [
      GREADER_READING_LIST,
      ...(article.isRead ? [GREADER_READ] : []),
      ...(article.isStarred ? [GREADER_STARRED] : []),
      ...(article.labels || []).map((item: any) => `${GREADER_LABEL_PREFIX}${item.label.name}`),
    ],
    origin: {
      streamId: `feed/${article.feed.url}`,
      title: article.feed.name,
      htmlUrl: article.feed.url,
    },
    author: article.author || "",
    summary: { content: article.excerpt || "" },
    content: { content: article.content || article.excerpt || "" },
  };
}

export function toGReaderItemRef(article: any) {
  return {
    id: greaderItemId(article.id),
    directStreamIds: [`feed/${article.feed.url}`],
    timestampUsec: String(new Date(article.publishedAt).getTime() * 1000),
  };
}
