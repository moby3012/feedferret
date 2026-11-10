// K3: persists the enrichment returned by the (single) AI tagging call.
//
// Invariants:
//  - Does NOT change Article.updatedAt for computed metadata (flags, entities,
//    cleanTitle, aiTaggedAt): it is the GReader `ot`/`nt` modification clock and
//    those are not content changes. The one exception is `bumpUpdatedAt`, which
//    the caller sets when enrichment created NEW label assignments: tags are
//    exposed to GReader clients as categories, so incremental clients must see
//    the article again to pick them up. The write uses the same
//    guard as lib/article-meta-backfill.ts: filter on the updatedAt we read and
//    write that exact value back, so a concurrent real change (sync, read/star
//    toggle, full-text fetch) is never overwritten with a stale clock.
//  - Model output is data: only the whitelisted, already validated and
//    length-capped fields of `Enrichment` are stored.
//  - Heuristic findings are never weakened by the model:
//    sponsored = heuristic || ai, clickbait = ai ?? heuristic.
import { db } from "./db";
import type { Enrichment } from "./ai-tagging";

export interface ExistingFlags {
  isSponsored: boolean | null;
  isClickbait: boolean | null;
  enrichSource: string | null;
}

export interface EnrichmentColumns {
  entities?: string;
  isSponsored?: boolean;
  isClickbait?: boolean;
  cleanTitle?: string | null;
  enrichSource?: "ai";
}

/** Columns to write for `ai` on top of what the row already has. Pure. */
export function mergeEnrichment(existing: ExistingFlags, ai: Enrichment | null): EnrichmentColumns {
  // Legacy tag-only answers carry no flags; leave every enrichment column as it is.
  if (!ai || !ai.structured) return {};

  const columns: EnrichmentColumns = { enrichSource: "ai", entities: JSON.stringify(ai.entities) };

  const sponsored = existing.isSponsored === true ? true : ai.sponsored;
  if (sponsored !== null) columns.isSponsored = sponsored;

  const clickbait = ai.clickbait ?? existing.isClickbait;
  if (clickbait !== null) columns.isClickbait = clickbait;

  // cleanTitle only exists for clickbait; a model that now says "not clickbait" clears a stale one.
  if (clickbait === true) {
    if (ai.cleanTitle) columns.cleanTitle = ai.cleanTitle;
  } else if (clickbait === false) {
    columns.cleanTitle = null;
  }
  return columns;
}

/**
 * Marks the article as tagged (`aiTaggedAt`) and stores the merged enrichment in
 * ONE write that leaves `updatedAt` untouched — unless `bumpUpdatedAt` (new label
 * assignments were created), which stamps the current time. Returns whether the
 * row was written; a lost race is retried once against the fresh clock.
 */
export async function persistEnrichment(
  articleId: string,
  userId: string,
  ai: Enrichment | null,
  options: { bumpUpdatedAt?: boolean; taggedAt?: Date } = {},
): Promise<{ written: boolean }> {
  const taggedAt = options.taggedAt ?? new Date();
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await db.article.findFirst({
      where: { id: articleId, userId },
      select: { updatedAt: true, isSponsored: true, isClickbait: true, enrichSource: true },
    });
    if (!row) return { written: false };

    const columns = mergeEnrichment(row, ai);
    const result = await db.article.updateMany({
      where: { id: articleId, userId, updatedAt: row.updatedAt },
      data: { ...columns, aiTaggedAt: taggedAt, updatedAt: options.bumpUpdatedAt ? new Date() : row.updatedAt },
    });
    if (result.count > 0) return { written: true };
  }
  return { written: false };
}

/** Parses the stored `entities` JSON column defensively (always a bounded string[]). */
export function parseStoredEntities(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is string => typeof e === "string" && e.length > 0 && e.length <= 48).slice(0, 8);
  } catch {
    return [];
  }
}
