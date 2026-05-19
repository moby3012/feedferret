export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyMarkReadUrl } from "@/lib/telegram-callback";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const uid = url.searchParams.get("uid");
  const exp = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");

  if (!id || !uid || !exp || !sig) {
    return new NextResponse(html("Invalid link", "This link is missing required parameters."), {
      status: 400,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (!verifyMarkReadUrl(id, uid, exp, sig)) {
    return new NextResponse(html("Link expired", "This link has expired or is invalid. Open FeedFerret to mark articles as read."), {
      status: 403,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  const article = await db.article.findFirst({ where: { id, userId: uid }, select: { id: true, isRead: true, title: true } });
  if (!article) {
    return new NextResponse(html("Article not found", "This article no longer exists."), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (!article.isRead) {
    await db.article.update({ where: { id }, data: { isRead: true, readAt: new Date() } });
  }

  return new NextResponse(html("Marked as read", `&ldquo;${escapeHtml(article.title)}&rdquo; has been marked as read.`), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function html(title: string, body: string) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — FeedFerret</title><style>body{font-family:system-ui,sans-serif;max-width:400px;margin:60px auto;padding:0 16px;text-align:center;color:#1a1a1a}h1{font-size:1.4rem;font-weight:600;margin-bottom:.5rem}p{color:#555;line-height:1.5}a{color:#5ba4cf;text-decoration:none}@media(prefers-color-scheme:dark){body{background:#111;color:#e5e5e5}p{color:#aaa}}</style></head><body><h1>${title}</h1><p>${body}</p><p style="margin-top:2rem"><a href="/">Open FeedFerret</a></p></body></html>`;
}
