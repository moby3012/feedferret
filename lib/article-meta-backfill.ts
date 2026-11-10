// Fills the nullable list-metadata columns (`kind`, `readMinutes`, `media*`)
// of articles synced before they existed. Runs in the background after boot:
// never awaited by startup, small batches with pauses in between, idempotent
// (only rows with `kind IS NULL` are touched and every processed row gets a
// non-null `kind`, so a restart simply continues). Read paths never depend on
// it — the list mapper derives `kind` on the fly while a row is still null.
//
// `updatedAt` is written back unchanged: it is the GReader `ot`/`updated`
// modification clock, and computed metadata is not a content change.
import { db } from "./db";
import { computeArticleMeta } from "./article-kind";
import { logger } from "./logger";

const BATCH_SIZE = 100;
const PAUSE_MS = 250;
const START_DELAY_MS = 5_000;
const GLOBAL_KEY = "__feedferret_article_meta_backfill__";

type BackfillState = { started: boolean; running: boolean; updated: number; done: boolean };

function state(): BackfillState {
  const g = globalThis as Record<string, unknown>;
  g[GLOBAL_KEY] ??= { started: false, running: false, updated: 0, done: false } satisfies BackfillState;
  return g[GLOBAL_KEY] as BackfillState;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One batch; returns rows seen and rows actually updated (`seen: 0` = nothing left). */
export async function backfillArticleMetaBatch(batchSize = BATCH_SIZE): Promise<{ seen: number; updated: number }> {
  const rows = await db.article.findMany({
    where: { kind: null },
    select: {
      id: true,
      title: true,
      link: true,
      content: true,
      contentFormat: true,
      imageUrl: true,
      enclosures: true,
      updatedAt: true,
      feed: { select: { url: true } },
    },
    orderBy: { id: "asc" },
    take: batchSize,
  });
  if (rows.length === 0) return { seen: 0, updated: 0 };

  const results = await db.$transaction(
    rows.map((row) => {
      const meta = computeArticleMeta({
        content: row.content,
        contentFormat: row.contentFormat,
        title: row.title,
        link: row.link,
        imageUrl: row.imageUrl,
        enclosures: row.enclosures,
        feedUrl: row.feed?.url ?? null,
      });
      // `kind: null` in the filter: a concurrent sync that already wrote fresh
      // metadata for this row wins.
      return db.article.updateMany({
        where: { id: row.id, kind: null },
        data: { ...meta, updatedAt: row.updatedAt },
      });
    }),
  );
  return { seen: rows.length, updated: results.reduce((sum, r) => sum + r.count, 0) };
}

/** Runs the backfill to completion in small batches. Safe to call repeatedly. */
export async function runArticleMetaBackfill(opts: { batchSize?: number; pauseMs?: number } = {}): Promise<number> {
  const s = state();
  if (s.running) return 0;
  s.running = true;
  let total = 0;
  try {
    const batchSize = opts.batchSize ?? BATCH_SIZE;
    for (;;) {
      const { seen, updated } = await backfillArticleMetaBatch(batchSize);
      total += updated;
      // A full batch that changed nothing would be re-read forever: stop.
      if (seen < batchSize || updated === 0) break;
      await sleep(opts.pauseMs ?? PAUSE_MS);
    }
    s.done = true;
    s.updated += total;
    if (total > 0) logger.log(`[article-meta-backfill] filled list metadata for ${total} articles`);
    return total;
  } finally {
    s.running = false;
  }
}

/** Fire-and-forget from instrumentation; never blocks or fails startup. */
export function startArticleMetaBackfill() {
  if (process.env.DISABLE_ARTICLE_META_BACKFILL === "true") return;
  const s = state();
  if (s.started) return;
  s.started = true;
  const timer = setTimeout(() => {
    runArticleMetaBackfill().catch((error) => logger.error("[article-meta-backfill] stopped:", error));
  }, START_DELAY_MS);
  timer.unref?.();
}
