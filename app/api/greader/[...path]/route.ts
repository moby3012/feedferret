import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authenticateGReaderRequest, createGReaderToken, parseGReaderItemId, toGReaderArticle } from "@/lib/greader";

async function requireUser(request: Request) {
  const user = await authenticateGReaderRequest(request);
  if (!user) throw new Error("Unauthorized");
  return user;
}

export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const user = await requireUser(request);
    const path = (await params).path.join("/");
    const url = new URL(request.url);

    if (path.endsWith("token")) {
      return new NextResponse(createGReaderToken(user.id), { headers: { "content-type": "text/plain" } });
    }

    if (path.endsWith("user-info")) {
      return NextResponse.json({ userId: user.id, userName: user.email, userProfileId: user.id, isBloggerUser: false, signupTimeSec: 0 });
    }

    if (path.endsWith("subscription/list")) {
      const feeds = await db.feed.findMany({ where: { userId: user.id }, include: { category: true }, orderBy: { name: "asc" } });
      return NextResponse.json({ subscriptions: feeds.map((feed) => ({ id: `feed/${feed.url}`, title: feed.name, categories: feed.category ? [{ id: `user/-/label/${feed.category.name}`, label: feed.category.name }] : [], url: feed.url, htmlUrl: feed.url, firstitemmsec: "0" })) });
    }

    if (path.endsWith("tag/list")) {
      const labels = await db.label.findMany({ where: { userId: user.id }, orderBy: { name: "asc" } });
      return NextResponse.json({ tags: labels.map((label) => ({ id: `user/-/label/${label.name}`, type: "label" })) });
    }

    if (path.endsWith("unread-count")) {
      const feeds = await db.feed.findMany({ where: { userId: user.id } });
      const counts = await db.article.groupBy({ by: ["feedId"], where: { userId: user.id, isRead: false }, _count: { _all: true } });
      const byFeed = new Map(counts.map((item) => [item.feedId, item._count._all]));
      const total = counts.reduce((sum, item) => sum + item._count._all, 0);
      return NextResponse.json({ max: 1000, unreadcounts: [{ id: "user/-/state/com.google/reading-list", count: total, newestItemTimestampUsec: "0" }, ...feeds.map((feed) => ({ id: `feed/${feed.url}`, count: byFeed.get(feed.id) || 0, newestItemTimestampUsec: "0" }))] });
    }

    if (path.includes("stream/contents")) {
      const n = Math.min(Number(url.searchParams.get("n") || 50), 200);
      const articles = await db.article.findMany({ where: { userId: user.id }, include: { feed: true, labels: { include: { label: true } } }, orderBy: { publishedAt: "desc" }, take: n });
      return NextResponse.json({ id: "user/-/state/com.google/reading-list", title: "FeedFerret", updated: Math.floor(Date.now() / 1000), items: articles.map(toGReaderArticle) });
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

    if (path.endsWith("edit-tag")) {
      const ids = form.getAll("i").map((id) => parseGReaderItemId(String(id)));
      const add = String(form.get("a") || "");
      const remove = String(form.get("r") || "");
      for (const articleId of ids) {
        if (add.includes("/read")) await db.article.update({ where: { id: articleId, userId: user.id }, data: { isRead: true, readAt: new Date() } });
        if (remove.includes("/read")) await db.article.update({ where: { id: articleId, userId: user.id }, data: { isRead: false, readAt: null } });
        if (add.includes("/starred")) await db.article.update({ where: { id: articleId, userId: user.id }, data: { isStarred: true } });
        if (remove.includes("/starred")) await db.article.update({ where: { id: articleId, userId: user.id }, data: { isStarred: false } });
      }
      return new NextResponse("OK", { headers: { "content-type": "text/plain" } });
    }

    return NextResponse.json({ error: "Unsupported Google Reader endpoint", path }, { status: 404 });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
