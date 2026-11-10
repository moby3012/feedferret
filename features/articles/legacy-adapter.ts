import type { Article } from "@/lib/rss-data";
import type { ArticleDetail, ArticleListItem } from "./types";
import type { Scope } from "./scope";

// Thin adapter between the slim list rows and the existing (pre-shell) list and
// reader components, which expect the old `Article` shape (feed name/icon
// inline, `labels: [{label}]`). No body parsing: everything is a field copy,
// memoized per row object so cache writes for one article re-map only that one.

type FeedLike = { id: string; name: string; icon?: string | null };
type LabelLike = { id: string; name: string; color: string };

export type LegacyArticle = Article & { createdAtRaw: number; labelIds: string[] };

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
    aiSummary: detail.aiSummary,
    aiSummarizedAt: detail.aiSummarizedAt,
    readAt: detail.readAt,
  };
}

/**
 * Maps the page's legacy view state (sidebar sentinel strings, category by
 * NAME) onto a `Scope`. Returns `null` while a category name cannot be
 * resolved yet (categories still loading).
 */
export function legacyScope(
  feedId: string | null,
  category: string,
  search: string,
  categories: ReadonlyArray<{ id: string; name: string }>,
): Scope | null {
  const q = search.trim();
  if (q) return { kind: "query", q };
  if (feedId) return { kind: "feed", id: feedId };
  switch (category) {
    case "All":
    case "All Articles":
    case "New Articles":
      return { kind: "all" };
    case "Starred":
      return { kind: "starred" };
    case "Read Later":
      return { kind: "later" };
    case "Spoiler":
      return { kind: "spoiler" };
    case "Recently Read":
      return { kind: "recent" };
  }
  if (category.startsWith("Label:")) return { kind: "label", id: category.slice("Label:".length) };
  if (category.startsWith("Search:")) return { kind: "saved-search", id: category.slice("Search:".length) };
  const match = categories.find((c) => c.name === category);
  return match ? { kind: "category", id: match.id } : null;
}
