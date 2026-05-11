import nodemailer from "nodemailer";
import { db } from "@/lib/db";

export interface DigestArticle {
    id: string;
    title: string;
    link: string;
    excerpt: string | null;
    author: string | null;
    publishedAt: Date;
    feedName: string;
    feedIcon: string | null;
}

export interface DigestEmailOptions {
    to: string;
    userName: string | null;
    articles: DigestArticle[];
    unsubscribeToken: string;
    baseUrl: string;
}

function buildHtml(opts: DigestEmailOptions): string {
    const { to, userName, articles, unsubscribeToken, baseUrl } = opts;
    const unsubUrl = `${baseUrl}/api/digest/unsubscribe?token=${unsubscribeToken}`;
    const greeting = userName ? `Hi ${userName}` : "Hi there";

    const articleRows = articles
        .map(
            (a) => `
      <tr>
        <td style="padding:16px 0;border-bottom:1px solid #e5e7eb;">
          <div style="font-size:11px;color:#9ca3af;margin-bottom:4px;font-family:sans-serif;">
            ${a.feedIcon ?? "📰"} ${a.feedName} &nbsp;·&nbsp; ${new Date(a.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </div>
          <a href="${a.link}" style="font-size:16px;font-weight:600;color:#111827;text-decoration:none;line-height:1.4;font-family:sans-serif;">
            ${a.title}
          </a>
          ${
              a.excerpt
                  ? `<p style="margin:6px 0 0;font-size:14px;color:#6b7280;line-height:1.6;font-family:sans-serif;">${a.excerpt.slice(0, 200)}${a.excerpt.length > 200 ? "…" : ""}</p>`
                  : ""
          }
          ${a.author ? `<div style="margin-top:6px;font-size:12px;color:#9ca3af;font-family:sans-serif;">By ${a.author}</div>` : ""}
        </td>
      </tr>`,
        )
        .join("");

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
        <!-- Header -->
        <tr>
          <td style="background:#111827;padding:24px 32px;">
            <span style="font-size:20px;font-weight:700;color:#ffffff;font-family:sans-serif;">🦦 FeedFerret</span>
            <span style="font-size:13px;color:#9ca3af;margin-left:12px;font-family:sans-serif;">Your reading digest</span>
          </td>
        </tr>
        <!-- Greeting -->
        <tr>
          <td style="padding:24px 32px 8px;font-family:sans-serif;">
            <p style="margin:0;font-size:15px;color:#374151;">${greeting},</p>
            <p style="margin:8px 0 0;font-size:15px;color:#374151;">Here are <strong>${articles.length}</strong> article${articles.length !== 1 ? "s" : ""} from your feeds.</p>
          </td>
        </tr>
        <!-- Articles -->
        <tr>
          <td style="padding:8px 32px 24px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              ${articleRows}
            </table>
          </td>
        </tr>
        <!-- CTA -->
        <tr>
          <td style="padding:0 32px 32px;">
            <a href="${baseUrl}" style="display:inline-block;background:#111827;color:#ffffff;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;text-decoration:none;font-family:sans-serif;">
              Open FeedFerret →
            </a>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:20px 32px;background:#f9fafb;border-top:1px solid #e5e7eb;">
            <p style="margin:0;font-size:12px;color:#9ca3af;font-family:sans-serif;">
              You're receiving this because you enabled email digests in FeedFerret.
              &nbsp;·&nbsp;
              <a href="${unsubUrl}" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildText(opts: DigestEmailOptions): string {
    const { articles, unsubscribeToken, baseUrl } = opts;
    const unsubUrl = `${baseUrl}/api/digest/unsubscribe?token=${unsubscribeToken}`;
    const lines = [
        "🦦 FeedFerret — Your reading digest",
        `${articles.length} article${articles.length !== 1 ? "s" : ""} from your feeds`,
        "",
    ];
    for (const a of articles) {
        lines.push(`${a.title}`);
        lines.push(`${a.feedName} · ${new Date(a.publishedAt).toLocaleDateString()}`);
        lines.push(a.link);
        if (a.excerpt) lines.push(a.excerpt.slice(0, 150) + (a.excerpt.length > 150 ? "…" : ""));
        lines.push("");
    }
    lines.push(`Open FeedFerret: ${baseUrl}`);
    lines.push(`Unsubscribe: ${unsubUrl}`);
    return lines.join("\n");
}

export async function sendDigestEmail(opts: DigestEmailOptions): Promise<void> {
    const settings = await db.globalSettings.findUnique({ where: { id: "global" } });

    if (
        !settings?.mailServiceEnabled ||
        !settings.smtpHost ||
        !settings.smtpPort ||
        !settings.smtpFrom
    ) {
        throw new Error("SMTP not configured");
    }

    const transporter = nodemailer.createTransport({
        host: settings.smtpHost,
        port: settings.smtpPort,
        secure: settings.smtpPort === 465,
        auth:
            settings.smtpUser && settings.smtpPassword
                ? { user: settings.smtpUser, pass: settings.smtpPassword }
                : undefined,
    });

    const articleCount = opts.articles.length;
    const subject =
        articleCount === 0
            ? "FeedFerret digest — nothing new"
            : `FeedFerret digest — ${articleCount} new article${articleCount !== 1 ? "s" : ""}`;

    await transporter.sendMail({
        from: settings.smtpFrom,
        to: opts.to,
        subject,
        html: buildHtml(opts),
        text: buildText(opts),
    });
}

export async function getDigestArticles(
    userId: string,
    scope: string,
    feedIds: string[] | null,
    since: Date,
): Promise<DigestArticle[]> {
    const scopeFilter: Record<string, unknown> =
        scope === "unread"
            ? { isRead: false }
            : scope === "starred"
              ? { isStarred: true }
              : scope === "readlater"
                ? { isReadLater: true }
                : {};

    const articles = await db.article.findMany({
        where: {
            userId,
            publishedAt: { gte: since },
            ...(feedIds && feedIds.length > 0 ? { feedId: { in: feedIds } } : {}),
            ...scopeFilter,
        },
        orderBy: { publishedAt: "desc" },
        take: 20,
        select: {
            id: true,
            title: true,
            link: true,
            excerpt: true,
            author: true,
            publishedAt: true,
            feed: { select: { name: true, icon: true } },
        },
    });

    return articles.map((a) => ({
        id: a.id,
        title: a.title,
        link: a.link,
        excerpt: a.excerpt,
        author: a.author,
        publishedAt: a.publishedAt,
        feedName: a.feed.name,
        feedIcon: a.feed.icon,
    }));
}
