import type { Article } from "@/lib/rss-data";
import { isNewsletterFeed } from "@/lib/newsletter-constants";
import type { ArticleDetail, ArticleKind, ArticleListItem, ArticleMedia } from "./types";

// Thin adapter between the slim list rows and the existing (pre-shell) list and
// reader components, which expect the old `Article` shape (feed name/icon
// inline, `labels: [{label}]`). No body parsing: everything is a field copy,
// memoized per row object so cache writes for one article re-map only that one.

type FeedLike = { id: string; name: string; icon?: string | null; url?: string | null; sourceType?: string | null };
type LabelLike = { id: string; name: string; color: string };

export type LegacyArticle = Article & {
  createdAtRaw: number;
  labelIds: string[];
  /** Row v2 (content kind × density) — straight copies of the list row. */
  kind: ArticleKind;
  media: ArticleMedia | null;
  isSponsored: boolean;
  /** Neutral title (user enabled clean titles and the headline is clickbait); `title` stays the original. */
  displayTitle: string | null;
  clusterId: string | null;
  clusterSize: number;
  clusterLeadId: string | null;
};

export interface LegacyContext {
  feedsById: ReadonlyMap<string, FeedLike>;
  labelsById: ReadonlyMap<string, LabelLike>;
  /**
   * Labels query has data. Until then a row's labels render as same-height
   * placeholder chips, so the row does not grow when the names arrive (CLS).
   */
  labelsReady: boolean;
}

const PENDING_LABEL_NAME = "\u00a0";

const memo = new WeakMap<ArticleListItem, { ctx: LegacyContext; out: LegacyArticle }>();

export function toLegacyArticle(item: ArticleListItem, ctx: LegacyContext): LegacyArticle {
  const hit = memo.get(item);
  if (hit && hit.ctx === ctx) return hit.out;
  const feed = ctx.feedsById.get(item.feedId);
  const out: LegacyArticle = {
    id: item.id,
    feedId: item.feedId,
    feedName: feed?.name ?? "",
    feedIcon: feed?.icon || "",
    feedIsNewsletter: isNewsletterFeed(feed),
    title: item.title,
    link: item.link,
    excerpt: item.excerpt,
    content: "",
    author: item.author ?? "",
    publishedAt: item.publishedAt,
    publishedAtRaw: Date.parse(item.publishedAt),
    createdAtRaw: Date.parse(item.createdAt),
    readTime: item.readMinutes,
    isRead: item.isRead,
    isStarred: item.isStarred,
    isReadLater: item.isReadLater,
    isSpoiler: item.isSpoiler,
    imageUrl: item.imageUrl ?? undefined,
    isDuplicate: item.isDuplicate,
    duplicateCount: item.duplicateCount,
    canonicalFeedName: item.canonicalFeedName,
    labelIds: item.labelIds,
    kind: item.kind ?? "article",
    media: item.media ?? null,
    isSponsored: item.isSponsored === true,
    displayTitle: item.displayTitle || null,
    clusterId: item.clusterId ?? null,
    clusterSize: item.clusterSize ?? 0,
    clusterLeadId: item.clusterLeadId ?? null,
    labels: item.labelIds.flatMap((id) => {
      const label = ctx.labelsById.get(id);
      if (label) return [{ label: { id: label.id, name: label.name, color: label.color } }];
      return ctx.labelsReady ? [] : [{ label: { id, name: PENDING_LABEL_NAME, color: "transparent" } }];
    }),
  };
  memo.set(item, { ctx, out });
  return out;
}

/** Reader view of an article: list fields + the server-rendered body once the detail has arrived. */
export function withDetail<T extends Article>(article: T, detail: ArticleDetail | undefined): T {
  if (!detail || detail.id !== article.id) return article;
  return {
    ...article,
    content: detail.html,
    // `content` is already render-ready HTML (Markdown is rendered + sanitized on the server).
    contentFormat: "html",
    htmlFallback: detail.htmlFallback === true,
    aiSummary: detail.aiSummary,
    aiSummarizedAt: detail.aiSummarizedAt,
    readAt: detail.readAt,
    newsletter: detail.newsletter ?? null,
  };
}
