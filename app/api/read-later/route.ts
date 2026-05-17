export const dynamic = "force-dynamic";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { hashApiToken } from "@/lib/token";

async function resolveUser(request: Request) {
    // Session auth (web app / same-origin)
    const session = await auth();
    if (session?.user?.id) return session.user.id;

    // Bearer token auth (browser extension / mobile app)
    const authHeader = request.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.slice(7).trim();
        const user = await db.user.findUnique({ where: { apiToken: hashApiToken(token) }, select: { id: true } });
        if (user) return user.id;
    }

    return null;
}

/**
 * GET /api/read-later
 * List all Read Later articles for the authenticated user.
 * Sorted by readLaterSavedAt descending (most recently saved first).
 *
 * Auth: session cookie OR Authorization: Bearer <apiToken>
 *
 * Response 200:
 * [{ id, title, link, excerpt, author, publishedAt, feedName, imageUrl, isRead, readLaterSavedAt }]
 */
export async function GET(request: Request) {
    const userId = await resolveUser(request);
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const articles = await db.article.findMany({
        where: { userId, isReadLater: true },
        orderBy: { readLaterSavedAt: "desc" },
        select: {
            id: true,
            title: true,
            link: true,
            excerpt: true,
            author: true,
            publishedAt: true,
            imageUrl: true,
            isRead: true,
            isStarred: true,
            isReadLater: true,
            readLaterSavedAt: true,
            feed: { select: { id: true, name: true, icon: true } },
        },
    });

    return NextResponse.json(articles);
}

/**
 * POST /api/read-later
 * Add an article to the Read Later list.
 *
 * Auth: session cookie OR Authorization: Bearer <apiToken>
 *
 * Body (JSON): { "articleId": "..." }
 *   OR         { "url": "https://..." }   — looks up article by link field
 *
 * Response 200: { id, isReadLater, readLaterSavedAt }
 * Response 404: { error: "Article not found" }
 */
export async function POST(request: Request) {
    const userId = await resolveUser(request);
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const { articleId, url } = body as { articleId?: string; url?: string };

    if (!articleId && !url) {
        return NextResponse.json({ error: "Provide articleId or url" }, { status: 400 });
    }

    const article = articleId
        ? await db.article.findFirst({ where: { id: articleId, userId }, select: { id: true } })
        : await db.article.findFirst({ where: { userId, link: url! }, select: { id: true } });
    if (!article) return NextResponse.json({ error: "Article not found" }, { status: 404 });

    const updated = await db.article.update({
        where: { id: article.id },
        data: { isReadLater: true, readLaterSavedAt: new Date() },
        select: { id: true, isReadLater: true, readLaterSavedAt: true },
    });

    return NextResponse.json(updated);
}

/**
 * DELETE /api/read-later
 * Remove an article from the Read Later list.
 *
 * Auth: session cookie OR Authorization: Bearer <apiToken>
 *
 * Body (JSON): { "articleId": "..." }
 *   OR         { "url": "https://..." }
 *
 * Response 200: { id, isReadLater }
 * Response 404: { error: "Article not found" }
 */
export async function DELETE(request: Request) {
    const userId = await resolveUser(request);
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const { articleId, url } = body as { articleId?: string; url?: string };

    if (!articleId && !url) {
        return NextResponse.json({ error: "Provide articleId or url" }, { status: 400 });
    }

    const article = articleId
        ? await db.article.findFirst({ where: { id: articleId, userId }, select: { id: true } })
        : await db.article.findFirst({ where: { userId, link: url! }, select: { id: true } });
    if (!article) return NextResponse.json({ error: "Article not found" }, { status: 404 });

    const updated = await db.article.update({
        where: { id: article.id },
        data: { isReadLater: false, readLaterSavedAt: null },
        select: { id: true, isReadLater: true },
    });

    return NextResponse.json(updated);
}
