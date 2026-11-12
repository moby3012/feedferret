import { db, getDatabaseProvider } from "./db";

// Kept identical to the additive migration (tested). migrate deploy installs these;
// explicit db-push/dev databases need the same triggers before ingestion starts.
export const SQLITE_SEARCH_TRIGGERS = [
    `CREATE TRIGGER IF NOT EXISTS article_search_ai AFTER INSERT ON "Article"
BEGIN
    INSERT INTO "ArticleSearch" (rowid, "id", "title", "content", "excerpt", "author", "entities") VALUES (NEW.rowid, NEW."id", NEW."title", NEW."content", NEW."excerpt", NEW."author", NEW."entities");
END`,
    `CREATE TRIGGER IF NOT EXISTS article_search_au AFTER UPDATE OF "id", "title", "content", "excerpt", "author", "entities" ON "Article"
WHEN OLD."id" IS NOT NEW."id" OR OLD."title" IS NOT NEW."title" OR OLD."content" IS NOT NEW."content" OR OLD."excerpt" IS NOT NEW."excerpt" OR OLD."author" IS NOT NEW."author" OR OLD."entities" IS NOT NEW."entities"
BEGIN
    INSERT INTO "ArticleSearch" (rowid, "id", "title", "content", "excerpt", "author", "entities") VALUES (NEW.rowid, NEW."id", NEW."title", NEW."content", NEW."excerpt", NEW."author", NEW."entities") ON CONFLICT(id)
    DO UPDATE SET "title" = excluded."title", "content" = excluded."content", "excerpt" = excluded."excerpt", "author" = excluded."author", "entities" = excluded."entities";
END`,
];

// Idempotent (guarded) like the migration, so re-running never takes an Article lock once installed.
export const POSTGRES_SEARCH_TRIGGERS = [
    `CREATE OR REPLACE FUNCTION article_search_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO "ArticleSearch" ("id", "title", "content", "excerpt", "author", "entities") VALUES (NEW."id", NEW."title", NEW."content", NEW."excerpt", NEW."author", NEW."entities") ON CONFLICT ("id")
    DO UPDATE SET "title" = excluded."title", "content" = excluded."content", "excerpt" = excluded."excerpt", "author" = excluded."author", "entities" = excluded."entities";
    RETURN NEW;
END $$`,
    `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'article_search_ai' AND tgrelid = '"Article"'::regclass) THEN
    CREATE TRIGGER article_search_ai AFTER INSERT ON "Article" FOR EACH ROW EXECUTE FUNCTION article_search_sync();
  END IF;
END $$`,
    `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'article_search_au' AND tgrelid = '"Article"'::regclass) THEN
    CREATE TRIGGER article_search_au AFTER UPDATE OF "id", "title", "content", "excerpt", "author", "entities" ON "Article"
    FOR EACH ROW WHEN (ROW(OLD."id", OLD."title", OLD."content", OLD."excerpt", OLD."author", OLD."entities") IS DISTINCT FROM ROW(NEW."id", NEW."title", NEW."content", NEW."excerpt", NEW."author", NEW."entities")) EXECUTE FUNCTION article_search_sync();
  END IF;
END $$`,
];

export type ArticleSearchProjectionState = "unknown" | "complete" | "backfilling" | "error";
export type ArticleSearchProjectionStatus = {
    state: ArticleSearchProjectionState;
    /** Articles without a projection row at the last check (0 when complete). */
    missing?: number;
    detail?: string;
};

const STATUS_KEY = "__feedferret_article_search_projection__";
const store = globalThis as unknown as Record<string, ArticleSearchProjectionStatus | undefined>;
function setStatus(status: ArticleSearchProjectionStatus) { store[STATUS_KEY] = status; }
export function articleSearchProjectionStatus(): ArticleSearchProjectionStatus {
    return store[STATUS_KEY] ?? { state: "unknown" };
}
/**
 * True only after this process verified the projection complete (startup self-check, or the
 * periodic re-check). Until then lib/search.ts runs the same predicates on Article columns.
 */
export function isArticleSearchReady(): boolean {
    return articleSearchProjectionStatus().state === "complete";
}
/** Tests only: a freshly pushed, empty database with the triggers installed is complete by definition. */
export function markArticleSearchVerifiedForTests() {
    setStatus({ state: "complete", missing: 0 });
}

const PG_BATCH = 5000;
const SQLITE_BATCH = 1000;
const BATCH_YIELD_MS = 10;

/** Articles that have no projection row. The FK makes ArticleSearch a subset of Article,
 *  so equal counts mean complete; two index-only counts are cheap even at 100k+ rows. */
async function missingProjectionRows(): Promise<number> {
    const [row] = await db.$queryRawUnsafe<{ articles: bigint | number; search: bigint | number }[]>(
        'SELECT (SELECT count(*) FROM "Article") AS articles, (SELECT count(*) FROM "ArticleSearch") AS search'
    );
    return Number(row.articles) - Number(row.search);
}

const isLockConflict = (err: unknown) => /lock timeout|deadlock|55P03|40P01/i.test(String((err as { message?: string })?.message ?? err));

/**
 * Fills missing projection rows in small key-ordered batches (never one long statement).
 * Postgres: each batch briefly holds an EXCLUSIVE lock on Article (a few ms). Plain reads continue;
 * writers AND row-locking readers (SELECT … FOR UPDATE in bulk mark-read) wait. The lock is only
 * granted once every transaction that wrote or row-locked Article has finished, so the copy's
 * FK checks never wait on another transaction's row lock and no cycle (deadlock) is possible.
 * lock_timeout: a long-running transaction delays the batch (retried) instead of stalling writers.
 * ON CONFLICT DO NOTHING keeps newer rows written by the triggers. Safe to interrupt at any point;
 * a later start resumes via the count check.
 */
export async function backfillArticleSearch(options: { yieldMs?: number } = {}): Promise<number> {
    const pg = getDatabaseProvider() === "postgresql";
    const yieldMs = options.yieldMs ?? BATCH_YIELD_MS;
    const pause = (ms: number) => (ms ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
    let inserted = 0;
    if (pg) {
        let after = "";
        for (;;) {
            const [bound] = await db.$queryRawUnsafe<{ upper: string | null }[]>(
                'SELECT max("id") AS upper FROM (SELECT "id" FROM "Article" WHERE "id" > $1 ORDER BY "id" LIMIT $2) b', after, PG_BATCH
            );
            if (!bound?.upper) break;
            for (let attempt = 1; ; attempt++) {
                try {
                    const [, , count] = await db.$transaction([
                        db.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'"),
                        db.$executeRawUnsafe('LOCK TABLE "Article" IN EXCLUSIVE MODE'),
                        db.$executeRawUnsafe(
                            `INSERT INTO "ArticleSearch" ("id", "title", "content", "excerpt", "author", "entities")
                             SELECT a."id", a."title", a."content", a."excerpt", a."author", a."entities" FROM "Article" a
                             WHERE a."id" > $1 AND a."id" <= $2 AND NOT EXISTS (SELECT 1 FROM "ArticleSearch" s WHERE s."id" = a."id")
                             ON CONFLICT ("id") DO NOTHING`, after, bound.upper
                        ),
                    ]);
                    inserted += count;
                    break;
                } catch (err) {
                    if (attempt >= 5 || !isLockConflict(err)) throw err;
                    await pause(1000 * attempt);
                }
            }
            after = bound.upper;
            await pause(yieldMs);
        }
    } else {
        // Projection rowids mirror Article rowids (compatibility with the FTS external content).
        let after = 0;
        for (;;) {
            const [bound] = await db.$queryRawUnsafe<{ upper: number | bigint | null }[]>(
                'SELECT max(rowid) AS upper FROM (SELECT rowid FROM "Article" WHERE rowid > ? ORDER BY rowid LIMIT ?)', after, SQLITE_BATCH
            );
            if (bound?.upper === null || bound?.upper === undefined) break;
            const upper = Number(bound.upper);
            inserted += await db.$executeRawUnsafe(
                `INSERT INTO "ArticleSearch" (rowid, "id", "title", "content", "excerpt", "author", "entities")
                 SELECT a.rowid, a."id", a."title", a."content", a."excerpt", a."author", a."entities" FROM "Article" a
                 WHERE a.rowid > ? AND a.rowid <= ? AND NOT EXISTS (SELECT 1 FROM "ArticleSearch" s WHERE s."id" = a."id")
                 ON CONFLICT ("id") DO NOTHING`, after, upper
            );
            after = upper;
            await pause(yieldMs);
        }
    }
    return inserted;
}

/**
 * Startup self-check (both providers). Installs the sync triggers if missing (db-push/dev
 * databases; a no-op catalog probe on migrated ones), then compares Article and ArticleSearch
 * row counts. An incomplete projection (migration copy deferred by a lock timeout, a restored
 * dump, an interrupted deploy) is filled in batches. Until the projection is verified complete,
 * search runs on the Article columns (isArticleSearchReady), so a gap never hides articles; the
 * state is logged and reported in /api/health.
 */
export async function ensureArticleSearchStorage(options: { yieldMs?: number } = {}): Promise<ArticleSearchProjectionStatus> {
    const pg = getDatabaseProvider() === "postgresql";
    try {
        const installed = await db.$queryRawUnsafe<unknown[]>(pg
            ? "SELECT 1 FROM pg_trigger WHERE tgname IN ('article_search_ai', 'article_search_au') AND tgrelid = '\"Article\"'::regclass"
            : "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name IN ('article_search_ai', 'article_search_au')");
        if (installed.length < 2) {
            // Triggers first: every later write is mirrored, the backfill covers everything before.
            await db.$transaction((pg ? POSTGRES_SEARCH_TRIGGERS : SQLITE_SEARCH_TRIGGERS).map(sql => db.$executeRawUnsafe(sql)));
            console.info("[search-projection] Installed ArticleSearch sync triggers.");
        }
        const missing = await missingProjectionRows();
        if (missing <= 0) {
            setStatus({ state: "complete", missing: 0 });
            return articleSearchProjectionStatus();
        }
        console.warn(`[search-projection] ArticleSearch is missing ${missing} article(s). Search uses the Article columns until the background backfill completes.`);
        setStatus({ state: "backfilling", missing });
        const inserted = await backfillArticleSearch(options);
        const left = await missingProjectionRows();
        if (left > 0) {
            // Rows deleted/inserted concurrently can only shrink the gap; anything left is unexpected.
            setStatus({ state: "error", missing: left, detail: `backfill inserted ${inserted}, ${left} still missing` });
            console.error(`[search-projection] ArticleSearch still misses ${left} article(s) after backfill (${inserted} inserted); search stays on the Article columns, retrying.`);
        } else {
            setStatus({ state: "complete", missing: 0, detail: `backfilled ${inserted}` });
            console.info(`[search-projection] ArticleSearch backfill complete (${inserted} row(s)); search uses the projection.`);
        }
    } catch (err) {
        setStatus({ state: "error", detail: err instanceof Error ? err.message : String(err) });
        throw err;
    }
    return articleSearchProjectionStatus();
}

// ── Background maintenance (server process only) ─────────────────────────────
// A failed or incomplete check is retried with exponential backoff (30 s … 15 min), not only on
// the next restart. A verified projection is re-checked hourly (two counts); a gap found then
// switches search back to the Article columns and repairs it.
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;
const RECHECK_MS = 60 * 60_000;
const TIMER_KEY = "__feedferret_article_search_timer__";
const timers = globalThis as unknown as Record<string, ReturnType<typeof setTimeout> | undefined>;

/** `onReady` runs whenever a check turns an incomplete projection complete (e.g. finish the index swap). */
export function scheduleArticleSearchMaintenance(onReady?: () => void, attempt = 0) {
    if (timers[TIMER_KEY]) clearTimeout(timers[TIMER_KEY]);
    const wasReady = isArticleSearchReady();
    const delay = wasReady ? RECHECK_MS : Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
    const timer = setTimeout(() => {
        timers[TIMER_KEY] = undefined;
        void ensureArticleSearchStorage()
            .catch((err) => console.warn("[search-projection] check failed; search stays on the Article columns, retrying.", err instanceof Error ? err.message : err))
            .finally(() => {
                const ready = isArticleSearchReady();
                if (ready && !wasReady) onReady?.();
                scheduleArticleSearchMaintenance(onReady, ready ? 0 : attempt + 1);
            });
    }, delay);
    timer.unref?.();
    timers[TIMER_KEY] = timer;
}
