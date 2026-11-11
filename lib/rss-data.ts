import type { NewsletterArticleMeta } from "@/features/articles/types"

export interface FeedSource {
  id: string
  name: string
  url: string
  icon: string
  category: string
  categoryId?: string | null
  unreadCount: number
  hideFromAllFeeds?: boolean
  categoryHideFromAllFeeds?: boolean
}

/**
 * Article shape the existing list/reader components consume. Built from the
 * slim list rows (features/articles/legacy-adapter.ts); `content` is the
 * server-rendered body HTML once the article detail has loaded, "" before.
 */
export interface Article {
  id: string
  feedId: string
  feedName: string
  feedIcon: string
  title: string
  link: string
  excerpt: string
  content: string
  contentFormat?: "html" | "markdown"
  author: string
  publishedAt: string
  publishedAtRaw?: number
  /** Estimated minutes; null/undefined when unknown (not computed yet). */
  readTime?: number | null
  isRead: boolean
  readAt?: string | Date | null
  isStarred: boolean
  isReadLater: boolean
  readLaterSavedAt?: string | Date | null
  isSpoiler?: boolean
  imageUrl?: string
  isDuplicate?: boolean
  duplicateOf?: string | null
  duplicateCount?: number
  canonicalFeedName?: string | null
  aiSummary?: string | null
  aiSummarizedAt?: string | Date | null
  /** N1 PR D: newsletter metadata from the article detail (absent until it loads; null for web articles). */
  newsletter?: NewsletterArticleMeta | null
  /** Feed is a newsletter (envelope icon in rows / reader). */
  feedIsNewsletter?: boolean
  labels?: Array<{
    label: {
      id: string
      name: string
      color: string
    }
  }>
}
