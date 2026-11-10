// Wire types of the app data layer (.pm/spec-shell-design.md §2.2).
import type { ArticleKind } from "@/lib/article-kind";

export type { ArticleKind } from "@/lib/article-kind";
export type { ListKey, Scope, Show, Sort } from "./scope";

export interface ArticleMedia {
  url: string | null;
  type: string | null;
  durationSecs: number | null;
}

/** One list row. Deliberately has NO `content` — the body comes from `ArticleDetail`. */
export interface ArticleListItem {
  id: string;
  feedId: string;
  title: string;
  link: string;
  excerpt: string;
  author: string | null;
  publishedAt: string;
  createdAt: string;
  imageUrl: string | null;
  kind: ArticleKind;
  media: ArticleMedia | null;
  readMinutes: number | null;
  isRead: boolean;
  isStarred: boolean;
  isReadLater: boolean;
  isSpoiler: boolean;
  isDuplicate: boolean;
  duplicateCount: number;
  canonicalFeedName: string | null;
  labelIds: string[];
  /**
   * Story cluster (K1, lib/story-clustering). Present only on rows that belong
   * to a cluster of >= 2 sources; absent otherwise. Additive: no existing field
   * changes. `clusterLeadId` is the cluster's representative article.
   */
  clusterId?: string;
  clusterSize?: number;
  clusterLeadId?: string;
  /**
   * K3 enrichment (optional: absent on old servers/caches). `isSponsored` =
   * heuristic or AI said paid/affiliate content. `displayTitle` is the neutral
   * AI title, set only when the user enabled "Sachliche Titel bei Clickbait"
   * and the article is clickbait; `title` is always the original. Plain text.
   */
  isSponsored?: boolean;
  isClickbait?: boolean;
  displayTitle?: string | null;
}

/** GET /api/app/clusters/:id — all sources of one story (slim list rows, oldest first). */
export interface ClusterDetail {
  id: string;
  size: number;
  leadId: string;
  members: ArticleListItem[];
}

export interface ArticleDetail extends ArticleListItem {
  /**
   * Render-ready, sanitized HTML: stored HTML as is (sanitized at sync) or
   * `renderMarkdownToHtml(content)` for Markdown — the same server sanitizer
   * REST v1 / GReader / Fever use. Inject as is; never sanitize client-side.
   */
  html: string;
  /** Format the body is stored in (`html` is always HTML). */
  contentFormat: "html" | "markdown";
  aiSummary: string | null;
  aiSummarizedAt: string | null;
  readAt: string | null;
  /** K3: named entities from the tagging call (plain text, ≤8). */
  entities?: string[];
  /** K3: the original headline when `displayTitle` replaced it (else null). */
  originalTitle?: string | null;
}

/** `GET /api/app/articles/head` — rows of a list created after its snapshot (spec §2.1). */
export interface HeadProbe {
  /** Capped at 100 (the pill shows "99+" above 99). */
  count: number;
  /** createdAt (ms, string) of the newest of them; null when there are none. */
  newestCursor: string | null;
}

export interface ArticlePage {
  items: ArticleListItem[];
  nextCursor: string | null;
  /**
   * First page only: server time (ms) taken before the page was read — the
   * list's snapshot. "Alles bis hier" never reaches rows created after it.
   */
  snapshotAt?: number;
}
