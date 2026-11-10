import { db } from "@/lib/db";
import { deriveKind, isArticleKind, pickMedia } from "@/lib/article-kind";
import type { Scope, Show, Sort } from "@/features/articles/scope";
import { showApplies } from "@/features/articles/scope";
import type { ArticleListItem, ArticlePage } from "@/features/articles/types";
import { buildViewScope, type KeysetField } from "./view-scope";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

/**
 * Columns a list row needs — never `content`. `enclosures` and `feed.url` are
 * only read to derive `kind`/`media` on the fly for rows synced before those
 * columns existed (not part of the response); `readAt` feeds the
 * "Recently read" keyset.
 */
export const LIST_SELECT = {
  id: true,
  feedId: true,
  title: true,
  link: true,
  excerpt: true,
  author: true,
  publishedAt: true,
  createdAt: true,
  readAt: true,
  imageUrl: true,
  enclosures: true,
  kind: true,
  mediaUrl: true,
  mediaType: true,
  mediaDurationSecs: true,
  readMinutes: true,
  isRead: true,
  isStarred: true,
  isReadLater: true,
  isSpoiler: true,
  isDuplicate: true,
  feed: { select: { url: true } },
  labels: { select: { labelId: true } },
  _count: { select: { duplicates: true } },
  canonical: { select: { feed: { select: { name: true } } } },
} as const;

export type ListRow = {
  id: string;
  feedId: string;
  title: string;
  link: string;
  excerpt: string | null;
  author: string | null;
  publishedAt: Date;
  createdAt: Date;
  readAt: Date | null;
  imageUrl: string | null;
  enclosures: string | null;
  kind: string | null;
  mediaUrl: string | null;
  mediaType: string | null;
  mediaDurationSecs: number | null;
  readMinutes: number | null;
  isRead: boolean;
  isStarred: boolean;
  isReadLater: boolean;
  isSpoiler: boolean;
  isDuplicate: boolean;
  feed: { url: string } | null;
  labels: { labelId: string }[];
  _count: { duplicates: number };
  canonical: { feed: { name: string } | null } | null;
};

// The sync-time excerpt is the first 200 chars of the body's plain text.
const EXCERPT_LENGTH = 200;

/** DB row → wire row. Tolerates every nullable metadata column (pre-backfill rows). */
export function toListItem(row: ListRow): ArticleListItem {
  const excerpt = row.excerpt ?? "";
  let kind = isArticleKind(row.kind) ? row.kind : null;
  let media =
    row.mediaUrl || row.mediaType || row.mediaDurationSecs != null
      ? { url: row.mediaUrl, type: row.mediaType, durationSecs: row.mediaDurationSecs }
      : null;
  if (!kind) {
    // Not backfilled yet: same pure derivation as at sync, from the list
    // columns (the excerpt stands in for the body; a full-length excerpt means
    // "at least that long").
    media = media ?? pickMedia({ enclosures: row.enclosures });
    kind = deriveKind({
      enclosureType: media?.type ?? null,
      durationSecs: media?.durationSecs ?? null,
      link: row.link,
      feedUrl: row.feed?.url ?? null,
      title: row.title,
      textLength: excerpt.length < EXCERPT_LENGTH ? excerpt.length : null,
      text: excerpt,
      imageUrl: row.imageUrl,
    });
  }
  return {
    id: row.id,
    feedId: row.feedId,
    title: row.title,
    link: row.link,
    excerpt,
    author: row.author || null,
    publishedAt: row.publishedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    imageUrl: row.imageUrl || null,
    kind,
    media,
    readMinutes: row.readMinutes ?? null,
    isRead: row.isRead,
    isStarred: row.isStarred,
    isReadLater: row.isReadLater,
    isSpoiler: row.isSpoiler,
    isDuplicate: row.isDuplicate,
    duplicateCount: row._count?.duplicates ?? 0,
    canonicalFeedName: row.canonical?.feed?.name ?? null,
    labelIds: row.labels.map((l) => l.labelId),
  };
}

// ---------------------------------------------------------------- cursor
export class InvalidCursorError extends Error {}

type CursorValue = number | string;

function keysetValue(row: ListRow, field: KeysetField): CursorValue {
  if (field === "id") return row.id;
  const value = row[field];
  if (!(value instanceof Date)) throw new Error(`keyset column ${field} is null`);
  return value.getTime();
}

/** Opaque cursor = base64url(JSON [keyset values…]) of the last row of a page. */
export function encodeCursor(row: ListRow, keyset: KeysetField[]): string {
  return Buffer.from(JSON.stringify(keyset.map((f) => keysetValue(row, f))), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string, keyset: KeysetField[]): CursorValue[] {
  let values: unknown;
  try {
    values = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError("Invalid cursor");
  }
  if (!Array.isArray(values) || values.length !== keyset.length) throw new InvalidCursorError("Invalid cursor");
  keyset.forEach((field, i) => {
    const v = values[i];
    const ok = field === "id" ? typeof v === "string" && v.length > 0 && v.length <= 128 : typeof v === "number" && Number.isFinite(v);
    if (!ok) throw new InvalidCursorError("Invalid cursor");
  });
  return values as CursorValue[];
}

/**
 * `(f1, f2, …) < (v1, v2, …)` (or `>` ascending) as a Prisma OR-of-ANDs,
 * AND-ed with the redundant `f1 <= v1` (`>=`). The OR alone has no sargable
 * bound, so Postgres walks the `(userId, publishedAt, …)` index from the top
 * and filters every row before the cursor; the extra range turns that into an
 * Index Cond and deep pages start at the cursor.
 */
export function keysetWhere(keyset: KeysetField[], values: CursorValue[], direction: "desc" | "asc") {
  const op = direction === "desc" ? "lt" : "gt";
  const val = (i: number) => (keyset[i] === "id" ? values[i] : new Date(values[i] as number));
  return {
    AND: [
      { [keyset[0]]: { [direction === "desc" ? "lte" : "gte"]: val(0) } },
      {
        OR: keyset.map((field, i) => {
          const clause: Record<string, unknown> = {};
          for (let j = 0; j < i; j++) clause[keyset[j]] = val(j);
          clause[field] = { [op]: val(i) };
          return clause;
        }),
      },
    ],
  };
}

// ------------------------------------------------------------------ list
export interface ListArticlesParams {
  scope: Scope;
  show: Show;
  sort: Sort;
  cursor?: string | null;
  limit?: number;
}

/**
 * One page of a list. `show: "unread"` is filtered on the server (not for
 * smart views or search, where `show` does not apply). Keyset paging on the
 * view's order columns, so marking rows read while scrolling never shifts the
 * next page.
 */
export async function listArticles(userId: string, params: ListArticlesParams): Promise<ArticlePage> {
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(params.limit ?? DEFAULT_PAGE_SIZE)));
  const { where, keyset } = await buildViewScope(userId, params.scope);
  if (params.show === "unread" && showApplies(params.scope)) where.isRead = false;

  const direction = params.sort === "old" ? "asc" : "desc";
  if (params.cursor) {
    const values = decodeCursor(params.cursor, keyset);
    where.AND = [...(where.AND || []), keysetWhere(keyset, values, direction)];
  }

  const rows = (await db.article.findMany({
    where,
    select: LIST_SELECT,
    orderBy: keyset.map((field) => ({ [field]: direction })),
    take: limit + 1,
  })) as ListRow[];

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: pageRows.map(toListItem),
    nextCursor: hasMore ? encodeCursor(pageRows[pageRows.length - 1], keyset) : null,
  };
}
