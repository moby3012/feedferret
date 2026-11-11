import { db } from "@/lib/db";
import { renderMarkdownForDisplay } from "@/lib/markdown-render";
import type { ArticleDetail } from "@/features/articles/types";
import { parseStoredEntities } from "@/lib/article-enrichment";
import { NEWSLETTER_ARTICLE_SELECT, newsletterMetaFor, type NewsletterArticleRow } from "@/lib/newsletter-reader";
import { LIST_SELECT, getCleanTitlesSetting, toListItem, type ListRow } from "./list";

/**
 * Render-ready body HTML, identical to what REST v1 / GReader / Fever serve:
 * stored HTML as is (it was sanitized with lib/sanitize-html at sync / full-text
 * fetch time) and Markdown through `renderMarkdownToHtml`, i.e. markdown-it +
 * the shared, hook-configured DOMPurify. The client injects this unchanged.
 */
export async function renderArticleHtml(content: string | null | undefined, contentFormat: string | null | undefined): Promise<string> {
  return (await renderArticleBody(content, contentFormat)).html;
}

/**
 * Like `renderArticleHtml`, plus whether Markdown fell back to escaped plain
 * text (HTML worker busy / unavailable): the reader then still shows the
 * article instead of an error. Never throws for a rendering problem.
 */
export async function renderArticleBody(
  content: string | null | undefined,
  contentFormat: string | null | undefined,
): Promise<{ html: string; fallback: boolean }> {
  if (!content) return { html: "", fallback: false };
  if (contentFormat !== "markdown") return { html: content, fallback: false };
  const rendered = await renderMarkdownForDisplay(content);
  return { html: rendered.html, fallback: rendered.fallback !== null };
}

/** One article of `userId` with its body, or `null` (unknown id or someone else's article). */
export async function getArticleDetail(userId: string, id: string): Promise<ArticleDetail | null> {
  const row = await db.article.findFirst({
    where: { id, userId },
    select: {
      ...LIST_SELECT,
      ...NEWSLETTER_ARTICLE_SELECT,
      feed: { select: { url: true, sourceType: true } },
      content: true,
      contentFormat: true,
      aiSummary: true,
      aiSummarizedAt: true,
      entities: true,
    },
  });
  if (!row) return null;
  const item = toListItem(row as unknown as ListRow, { cleanTitles: await getCleanTitlesSetting(userId) });
  const body = await renderArticleBody(row.content, row.contentFormat);
  return {
    ...item,
    html: body.html,
    ...(body.fallback ? { htmlFallback: true } : {}),
    contentFormat: row.contentFormat === "markdown" ? "markdown" : "html",
    aiSummary: row.aiSummary ?? null,
    aiSummarizedAt: row.aiSummarizedAt?.toISOString() ?? null,
    readAt: row.readAt?.toISOString() ?? null,
    entities: parseStoredEntities(row.entities),
    originalTitle: item.displayTitle ? row.title : null,
    newsletter: await newsletterMetaFor(userId, row as unknown as NewsletterArticleRow),
  };
}
