import { sendSystemEmail } from "@/lib/mail";
import { db } from "@/lib/db";
import { createEmailTranslator } from "@/lib/email-i18n";

export interface DigestArticle {
  id: string;
  title: string;
  link: string;
  excerpt: string | null;
  author: string | null;
  publishedAt: Date;
  feedId: string;
  feedName: string;
  feedIcon: string | null;
  aiSummary: string | null;
}

export interface DigestEmailOptions {
  to: string;
  userName: string | null;
  articles: DigestArticle[];
  unsubscribeToken: string;
  baseUrl: string;
  locale?: string;
  groupByFeed?: boolean;
  overallSummary?: string | null;
  feedSummaries?: Record<string, string>;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderArticleRow(a: DigestArticle, t: (k: string, v?: Record<string, string | number>) => string, locale: string | undefined): string {
  const blurb = a.aiSummary
    ? `<p style="margin:6px 0 0;font-size:14px;color:#374151;line-height:1.6;font-family:sans-serif;white-space:pre-wrap;">${escapeHtml(a.aiSummary)}</p><div style="margin-top:4px;font-size:11px;color:#9ca3af;font-family:sans-serif;">${escapeHtml(t("emailDigest.aiSummary"))}</div>`
    : a.excerpt
      ? `<p style="margin:6px 0 0;font-size:14px;color:#6b7280;line-height:1.6;font-family:sans-serif;">${escapeHtml(a.excerpt.slice(0, 200))}${a.excerpt.length > 200 ? "…" : ""}</p>`
      : "";
  return `
      <tr>
        <td style="padding:16px 0;border-bottom:1px solid #e5e7eb;">
          <div style="font-size:11px;color:#9ca3af;margin-bottom:4px;font-family:sans-serif;">
            ${escapeHtml(a.feedIcon ?? "📰")} ${escapeHtml(a.feedName)} &nbsp;·&nbsp; ${new Intl.DateTimeFormat(locale ?? "en", { month: "short", day: "numeric" }).format(new Date(a.publishedAt))}
          </div>
          <a href="${escapeHtml(a.link)}" style="font-size:16px;font-weight:600;color:#111827;text-decoration:none;line-height:1.4;font-family:sans-serif;">
            ${escapeHtml(a.title)}
          </a>
          ${blurb}
          ${a.author ? `<div style="margin-top:6px;font-size:12px;color:#9ca3af;font-family:sans-serif;">By ${escapeHtml(a.author)}</div>` : ""}
        </td>
      </tr>`;
}

function renderOverallSummary(text: string, t: (k: string, v?: Record<string, string | number>) => string): string {
  return `
        <tr>
          <td style="padding:0 32px 16px;">
            <div style="background:linear-gradient(135deg,#eef2ff 0%,#f5f3ff 100%);border:1px solid #e0e7ff;border-radius:12px;padding:16px 18px;font-family:sans-serif;">
              <div style="font-size:11px;font-weight:600;color:#6366f1;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">
                ${escapeHtml(t("emailDigest.overallSummary"))}
              </div>
              <p style="margin:0;font-size:14px;color:#1f2937;line-height:1.65;white-space:pre-wrap;">
                ${escapeHtml(text)}
              </p>
            </div>
          </td>
        </tr>`;
}

function renderFeedHeader(feedName: string, feedIcon: string | null, summary: string | undefined, t: (k: string, v?: Record<string, string | number>) => string): string {
  const summaryBlock = summary
    ? `<div style="margin-top:8px;padding:10px 12px;background:#f5f3ff;border-left:3px solid #8b5cf6;border-radius:6px;">
         <div style="font-size:10px;font-weight:600;color:#7c3aed;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;">${escapeHtml(t("emailDigest.feedSummary"))}</div>
         <p style="margin:0;font-size:13px;color:#374151;line-height:1.6;white-space:pre-wrap;">${escapeHtml(summary)}</p>
       </div>`
    : "";
  return `
      <tr>
        <td style="padding:18px 0 6px;border-bottom:2px solid #d1d5db;">
          <div style="font-size:14px;font-weight:700;color:#111827;font-family:sans-serif;">
            ${escapeHtml(feedIcon ?? "📰")} ${escapeHtml(feedName)}
          </div>
          ${summaryBlock}
        </td>
      </tr>`;
}

function buildHtml(opts: DigestEmailOptions): string {
  const { userName, articles, unsubscribeToken, baseUrl, locale, groupByFeed, overallSummary, feedSummaries } = opts;
  const t = createEmailTranslator(locale ?? "en");
  const unsubUrl = `${baseUrl}/api/digest/unsubscribe?token=${unsubscribeToken}`;
  const greeting = userName ? t("emailDigest.greeting", { name: userName }) : t("emailDigest.greetingGeneric");

  let articleSection = "";
  if (groupByFeed) {
    const groups = new Map<string, DigestArticle[]>();
    for (const a of articles) {
      const key = a.feedId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(a);
    }
    const rows: string[] = [];
    for (const [feedId, group] of groups) {
      const first = group[0];
      rows.push(renderFeedHeader(first.feedName, first.feedIcon, feedSummaries?.[feedId], t));
      for (const a of group) rows.push(renderArticleRow(a, t, locale));
    }
    articleSection = rows.join("");
  } else {
    articleSection = articles.map((a) => renderArticleRow(a, t, locale)).join("");
  }

  const overallSummaryBlock = overallSummary ? renderOverallSummary(overallSummary, t) : "";

  return `<!DOCTYPE html>
<html lang="${locale ?? "en"}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
        <tr>
          <td style="background:#111827;padding:24px 32px;">
            <span style="font-size:20px;font-weight:700;color:#ffffff;font-family:sans-serif;">🦦 FeedFerret</span>
            <span style="font-size:13px;color:#9ca3af;margin-left:12px;font-family:sans-serif;">${escapeHtml(t("emailDigest.tagline"))}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 32px 8px;font-family:sans-serif;">
            <p style="margin:0;font-size:15px;color:#374151;">${escapeHtml(greeting)},</p>
            <p style="margin:8px 0 0;font-size:15px;color:#374151;">${escapeHtml(t("emailDigest.articleCount", { count: articles.length }))}</p>
          </td>
        </tr>
        ${overallSummaryBlock}
        <tr>
          <td style="padding:8px 32px 24px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              ${articleSection}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 32px;">
            <a href="${escapeHtml(baseUrl)}" style="display:inline-block;background:#111827;color:#ffffff;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;text-decoration:none;font-family:sans-serif;">
              ${escapeHtml(t("emailDigest.openApp"))}
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px;background:#f9fafb;border-top:1px solid #e5e7eb;">
            <p style="margin:0;font-size:12px;color:#9ca3af;font-family:sans-serif;">
              ${escapeHtml(t("emailDigest.footer"))}
              &nbsp;·&nbsp;
              <a href="${escapeHtml(unsubUrl)}" style="color:#6b7280;text-decoration:underline;">${escapeHtml(t("emailDigest.unsubscribe"))}</a>
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
  const { articles, unsubscribeToken, baseUrl, locale, groupByFeed, overallSummary, feedSummaries } = opts;
  const t = createEmailTranslator(locale ?? "en");
  const unsubUrl = `${baseUrl}/api/digest/unsubscribe?token=${unsubscribeToken}`;
  const lines = [
    `🦦 FeedFerret — ${t("emailDigest.tagline")}`,
    t("emailDigest.articleCount", { count: articles.length }),
    "",
  ];

  if (overallSummary) {
    lines.push(`== ${t("emailDigest.overallSummary")} ==`);
    lines.push(overallSummary);
    lines.push("");
  }

  if (groupByFeed) {
    const groups = new Map<string, DigestArticle[]>();
    for (const a of articles) {
      const key = a.feedId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(a);
    }
    for (const [feedId, group] of groups) {
      const first = group[0];
      lines.push(`-- ${first.feedName} --`);
      if (feedSummaries?.[feedId]) {
        lines.push(`[${t("emailDigest.feedSummary")}] ${feedSummaries[feedId]}`);
        lines.push("");
      }
      for (const a of group) appendArticleLines(lines, a, t, locale);
    }
  } else {
    for (const a of articles) appendArticleLines(lines, a, t, locale);
  }

  lines.push(`${t("emailDigest.openApp")} ${baseUrl}`);
  lines.push(`${t("emailDigest.unsubscribe")}: ${unsubUrl}`);
  return lines.join("\n");
}

function appendArticleLines(lines: string[], a: DigestArticle, _t: (k: string, v?: Record<string, string | number>) => string, locale: string | undefined): void {
  lines.push(a.title);
  lines.push(`${a.feedName} · ${new Intl.DateTimeFormat(locale ?? "en", { dateStyle: "medium" }).format(new Date(a.publishedAt))}`);
  lines.push(a.link);
  if (a.aiSummary) {
    lines.push(`[AI] ${a.aiSummary}`);
  } else if (a.excerpt) {
    lines.push(a.excerpt.slice(0, 150) + (a.excerpt.length > 150 ? "…" : ""));
  }
  lines.push("");
}

export async function sendDigestEmail(opts: DigestEmailOptions): Promise<void> {
  const t = createEmailTranslator(opts.locale ?? "en");
  const count = opts.articles.length;
  const subject = count === 0
    ? t("emailDigest.subjectNothingNew")
    : t("emailDigest.subject", { count });

  await sendSystemEmail({
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
  limit: number = 20,
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
    take: Math.max(1, Math.min(200, limit)),
    select: {
      id: true,
      title: true,
      link: true,
      excerpt: true,
      author: true,
      publishedAt: true,
      aiSummary: true,
      feedId: true,
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
    aiSummary: a.aiSummary,
    feedId: a.feedId,
    feedName: a.feed.name,
    feedIcon: a.feed.icon,
  }));
}
