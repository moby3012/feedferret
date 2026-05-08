import crypto from "crypto";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";

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

export function toGReaderArticle(article: any) {
  const timestampUsec = new Date(article.publishedAt).getTime() * 1000;
  return {
    id: greaderItemId(article.id),
    crawlTimeMsec: String(new Date(article.createdAt).getTime()),
    timestampUsec: String(timestampUsec),
    published: Math.floor(new Date(article.publishedAt).getTime() / 1000),
    title: article.title,
    canonical: [{ href: article.link }],
    alternate: [{ href: article.link, type: "text/html" }],
    categories: [
      article.isRead ? "user/-/state/com.google/read" : "user/-/state/com.google/reading-list",
      ...(article.isStarred ? ["user/-/state/com.google/starred"] : []),
      ...(article.labels || []).map((item: any) => `user/-/label/${item.label.name}`),
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
