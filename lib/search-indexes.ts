import { db, getDatabaseProvider } from "./db";
import { ensureArticleSearchStorage } from "./article-search-storage";

// Audit finding P-11: free-text search (lib/search.ts) uses leading-wildcard
// `contains` (LIKE '%term%') matching, which can't use a normal B-tree index.
// This module idempotently provisions index-backed acceleration for whichever
// provider we're running against, at server startup (see instrumentation.ts).
//
// Postgres: pg_trgm GIN trigram indexes. These accelerate the EXISTING
// ILIKE '%term%' queries with *zero* change to query logic — pure win.
//
// SQLite: an FTS5 virtual table using the `trigram` tokenizer (SQLite >= 3.34),
// kept in sync via triggers. The trigram tokenizer (unlike the default
// unicode61/porter tokenizers) matches arbitrary substrings the same way
// LIKE '%term%' does, so it preserves the current matching semantics instead
// of switching to word/token based matching. lib/search.ts routes free-text
// terms of length >= 3 through this index; shorter terms and any failure
// fall back to the original LIKE-based query, so results can only get faster,
// never wrong or less complete.
//
// Everything here MUST be safe to run on every startup (idempotent DDL) and
// must never throw past ensureSearchIndexes() — a broken index setup should
// degrade to "search still works, just unaccelerated," not crash the server
// or block feed sync.

// `entities` (K3, JSON string[] stored as text) is hit by the `entity:` operator's
// `contains` (ILIKE '%"X"%'), so it gets a trigram index on Postgres. On SQLite
// that operator stays a plain LIKE on purpose: article_fts only serves the
// free-text path (lib/search.ts ftsMatchIds), and entities are short, so adding
// the column to the FTS table would just bloat the index and force a rebuild.
export const ARTICLE_TEXT_COLUMNS = ["title", "content", "excerpt", "author", "entities"] as const;

export type EnsureSearchIndexesOptions = {
    /**
     * SQLite only. "background" (default): create the schema, then fill the FTS index in
     * small chunks without blocking (search uses the LIKE path until it is complete).
     * "await": resolve only when the index is fully built (tests, CLI tools).
     * "none": schema + triggers only, caller drives runSqliteFtsBackfill() (tests).
     */
    backfill?: "background" | "await" | "none";
};

export async function ensureSearchIndexes(options: EnsureSearchIndexesOptions = {}): Promise<void> {
    try {
        await ensureArticleSearchStorage();
        if (getDatabaseProvider() === "postgresql") {
            await ensurePostgresTrigramIndexes();
        } else {
            await ensureSqliteFts(options.backfill ?? "background");
        }
    } catch (err) {
        console.warn(
            "[search-indexes] Failed to set up full-text search acceleration; search will keep working, just without the index speedup.",
            err
        );
    }
}

async function ensurePostgresTrigramIndexes() {
    // Requires the pg_trgm extension to be installable by the connecting role
    // (superuser, or a role granted CREATE on the extension). If it can't be
    // created, the whole thing is caught by ensureSearchIndexes()'s try/catch.
    await db.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

    for (const column of ARTICLE_TEXT_COLUMNS) {
        const indexName = `ArticleSearch_${column}_trgm_idx`;
        await db.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS "${indexName}" ON "ArticleSearch" USING GIN ("${column}" gin_trgm_ops)`
        );
    }
}


// ── SQLite FTS5 ───────────────────────────────────────────────────────────────
//
// The first-time backfill of article_fts is O(corpus) (11.4 s for 50 k articles and
// it grows the DB 2.4×). It used to be awaited in register(), so the server did not
// answer its first request until it finished (audit R3). It now runs in the
// background in small, time-boxed chunks:
//
//   * `article_fts_backfill` (single row) records the highest Article.rowid that
//     existed when the backfill started (`upper_rowid`) and how far we got
//     (`done_rowid`). It survives restarts, so an interrupted backfill resumes.
//   * While a row is still "pending" (done_rowid < rowid <= upper_rowid) the sync
//     triggers deliberately do nothing for it: the backfill will index its current
//     content later. Without that guard a trigger-time FTS5 'delete' of a row that
//     was never indexed would corrupt the index, and a re-used rowid would be
//     indexed twice.
//   * `article_fts_meta.backfilled_at` is the "index is complete" marker. Until it is
//     set, lib/search.ts keeps using the LIKE path (isSqliteFtsReady()), so results
//     stay complete — just unaccelerated — while the index is being built.
//
// better-sqlite3 is synchronous: every chunk blocks the event loop for as long as it
// runs, so chunks are sized adaptively to ~TARGET_CHUNK_MS and separated by a pause.

const FTS_READY_KEY = "__feedferret_fts_ready__";
const FTS_BACKFILL_KEY = "__feedferret_fts_backfill__";

const BACKFILL_TARGET_CHUNK_MS = 40;
const BACKFILL_YIELD_MS = 25;
const BACKFILL_MIN_ROWS = 25;
const BACKFILL_MAX_ROWS = 2000;
const BACKFILL_RETRY_MS = 30_000;
const BACKFILL_START_DELAY_MS = 10_000;

const NOT_PENDING = (rowidExpr: string) =>
    `NOT EXISTS (SELECT 1 FROM article_fts_backfill b WHERE b.id = 1 AND ${rowidExpr} > b.done_rowid AND ${rowidExpr} <= b.upper_rowid)`;

async function ensureSqliteFts(mode: "background" | "await" | "none") {
    // Upgrade the old Article-backed FTS atomically. It is disposable; the existing
    // resumable backfill repopulates it while search uses the projection's LIKE path.
    const oldFts = await db.$queryRawUnsafe<{ sql: string }[]>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'article_fts'"
    );
    if (oldFts.length && !oldFts[0].sql.includes("content='ArticleSearch'")) {
        await db.$transaction([
            db.$executeRawUnsafe("DROP TRIGGER IF EXISTS article_fts_ai"),
            db.$executeRawUnsafe("DROP TRIGGER IF EXISTS article_fts_ad"),
            db.$executeRawUnsafe("DROP TRIGGER IF EXISTS article_fts_au"),
            db.$executeRawUnsafe("DROP TABLE article_fts"),
            db.$executeRawUnsafe("DROP TABLE IF EXISTS article_fts_meta"),
            db.$executeRawUnsafe("DROP TABLE IF EXISTS article_fts_backfill"),
        ]);
        delete (globalThis as unknown as Record<string, unknown>)[FTS_READY_KEY];
    }
    const indexExisted =
        (await db.$queryRawUnsafe<{ n: number }[]>(`SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'article_fts'`)).length > 0;

    // External-content FTS5 table: the actual text stays in "ArticleSearch"; this
    // table only stores the trigram index plus the cuid `id` (unindexed) so
    // matches can be mapped back to Prisma rows.
    await db.$executeRawUnsafe(`
        CREATE VIRTUAL TABLE IF NOT EXISTS article_fts USING fts5(
            id UNINDEXED,
            title,
            content,
            excerpt,
            author,
            tokenize='trigram',
            content='ArticleSearch',
            content_rowid='rowid'
        )
    `);

    // NOTE: for an external-content FTS5 table, a plain (non-MATCH) `SELECT` or
    // `count(*)` against article_fts is proxied straight to the backing "ArticleSearch"
    // table by SQLite — it does NOT reflect whether the trigram shadow index has
    // actually been populated. So completeness is tracked in this tiny marker table.
    await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS article_fts_meta (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            backfilled_at DATETIME
        )
    `);
    await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS article_fts_backfill (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            upper_rowid INTEGER NOT NULL,
            done_rowid INTEGER NOT NULL DEFAULT 0
        )
    `);

    if (!indexExisted) {
        // The FTS table was just (re)created empty. `prisma db push` — which `pnpm start` and
        // start.sh run on every boot — drops tables it does not know, article_fts included, but
        // can leave this unmanaged marker behind. A stale "complete" marker would make search trust
        // an empty index and return nothing, so forget it and rebuild.
        await db.$executeRawUnsafe(`DELETE FROM article_fts_meta`);
        await db.$executeRawUnsafe(`DELETE FROM article_fts_backfill`);
        delete (globalThis as unknown as Record<string, unknown>)[FTS_READY_KEY];
    }

    const marker = await db.$queryRawUnsafe<{ id: number }[]>(
        `SELECT id FROM article_fts_meta WHERE id = 1 AND backfilled_at IS NOT NULL`
    );
    const complete = marker.length > 0;
    const progress = complete
        ? []
        : await db.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM article_fts_backfill WHERE id = 1`);

    // (Re)create the sync triggers; drop + create in ONE transaction so a concurrent
    // write can never land in a window with no trigger (which would leave FTS stale).
    // The statements are rebuilt on every start because existing installs carry older
    // definitions (any-UPDATE trigger, no pending-row guard) that IF NOT EXISTS would keep.
    // When a first-time backfill starts, its progress row is created in the same
    // transaction, so every row is either covered by the backfill or by a trigger.
    const startBackfill: ReturnType<typeof db.$executeRawUnsafe>[] = [];
    if (!complete && progress.length === 0) {
        startBackfill.push(
            // Resets a possibly half-filled index (only reachable after an old, crashed boot).
            db.$executeRawUnsafe(`INSERT INTO article_fts(article_fts) VALUES ('delete-all')`),
            db.$executeRawUnsafe(
                `INSERT INTO article_fts_backfill (id, upper_rowid, done_rowid)
                 SELECT 1, COALESCE(MAX(rowid), 0), 0 FROM "ArticleSearch"`
            )
        );
    }
    await db.$transaction([
        ...startBackfill,
        db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS article_fts_ai`),
        db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS article_fts_ad`),
        db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS article_fts_au`),
        db.$executeRawUnsafe(`
            CREATE TRIGGER article_fts_ai AFTER INSERT ON "ArticleSearch"
            WHEN ${NOT_PENDING("new.rowid")} BEGIN
                INSERT INTO article_fts(rowid, id, title, content, excerpt, author)
                VALUES (new.rowid, new.id, new.title, new.content, new.excerpt, new.author);
            END
        `),
        db.$executeRawUnsafe(`
            CREATE TRIGGER article_fts_ad AFTER DELETE ON "ArticleSearch"
            WHEN ${NOT_PENDING("old.rowid")} BEGIN
                INSERT INTO article_fts(article_fts, rowid, id, title, content, excerpt, author)
                VALUES ('delete', old.rowid, old.id, old.title, old.content, old.excerpt, old.author);
            END
        `),
        // Only re-index when an indexed column changes (mark-read, star, aiSummary,
        // updatedAt... must not rewrite the whole trigram row).
        db.$executeRawUnsafe(`
            CREATE TRIGGER article_fts_au AFTER UPDATE OF title, content, excerpt, author ON "ArticleSearch"
            WHEN ${NOT_PENDING("old.rowid")} BEGIN
                INSERT INTO article_fts(article_fts, rowid, id, title, content, excerpt, author)
                VALUES ('delete', old.rowid, old.id, old.title, old.content, old.excerpt, old.author);
                INSERT INTO article_fts(rowid, id, title, content, excerpt, author)
                VALUES (new.rowid, new.id, new.title, new.content, new.excerpt, new.author);
            END
        `),
    ]);

    if (mode === "none") return;
    if (complete) {
        // The index claims to be complete: check that cheaply once per boot and rebuild in the
        // background if it is not (e.g. a crash mid-write, a restored backup, a manual edit).
        if (mode === "await") {
            await checkSqliteFtsAndRepair({ backfill: "await" });
        } else {
            const timer = setTimeout(() => {
                void checkSqliteFtsAndRepair({ backfill: "background" }).catch((err) => {
                    console.warn("[search-indexes] FTS consistency check failed; search keeps working.", err);
                });
            }, BACKFILL_START_DELAY_MS);
            timer.unref?.();
        }
        return;
    }
    if (mode === "await") {
        await runSqliteFtsBackfill({ yieldMs: 0 });
    } else {
        // Starts after a short grace period so the first page load after a restart is not competing
        // with the (chunked, but CPU-bound) backfill on the single event loop.
        const timer = setTimeout(() => {
            void runSqliteFtsBackfill().catch((err) => {
                console.warn("[search-indexes] FTS backfill failed; search stays on the LIKE path and the backfill resumes on next start.", err);
            });
        }, BACKFILL_START_DELAY_MS);
        timer.unref?.();
    }
}

// ── Boot-time consistency check ──────────────────────────────────────────────
//
// FTS5's own `INSERT INTO article_fts(article_fts) VALUES('integrity-check')` reads the
// whole index and compares it with "ArticleSearch": ~6 s for 50 k articles, synchronously on the
// single better-sqlite3 connection (event loop blocked, write lock held). Not acceptable on
// every boot. Instead two cheap probes that catch the realistic failure modes (rows missing
// from or left over in the index, an index that no longer matches the content):
//   1. the number of indexed documents (article_fts_docsize, one row per indexed rowid)
//      equals the number of articles — both counted in one read transaction;
//   2. the newest article with a title of >= 3 characters is found by an FTS MATCH on
//      (a prefix of) its title.
// On a mismatch the index is reset and rebuilt by the normal chunked background backfill;
// search uses the LIKE path meanwhile. Only FTS tables are written, never "ArticleSearch", so
// Article.updatedAt is untouched.

export type SqliteFtsCheckResult = { ok: true } | { ok: false; reason: string };

const FTS_PROBE_TITLE_CHARS = 48;

export async function checkSqliteFtsConsistency(): Promise<SqliteFtsCheckResult> {
    const [indexed, articles] = await db.$transaction([
        db.$queryRawUnsafe<{ n: number | bigint }[]>(`SELECT COUNT(*) AS n FROM article_fts_docsize`),
        db.$queryRawUnsafe<{ n: number | bigint }[]>(`SELECT COUNT(*) AS n FROM "ArticleSearch"`),
    ]);
    const indexedCount = Number(indexed[0]?.n ?? 0);
    const articleCount = Number(articles[0]?.n ?? 0);
    if (indexedCount !== articleCount) {
        return { ok: false, reason: `indexed ${indexedCount} of ${articleCount} articles` };
    }

    // One statement, so a concurrent delete of that article cannot produce a false alarm.
    const probe = await db.$queryRawUnsafe<{ rowid: number | bigint; found: number | bigint }[]>(
        `SELECT a.rowid AS rowid,
                EXISTS (
                    SELECT 1 FROM article_fts
                    WHERE article_fts MATCH ('"' || replace(substr(a.title, 1, ?), '"', '""') || '"')
                      AND article_fts.rowid = a.rowid
                ) AS found
         FROM "ArticleSearch" a WHERE length(a.title) >= 3 ORDER BY a.rowid DESC LIMIT 1`,
        FTS_PROBE_TITLE_CHARS
    );
    if (probe.length > 0 && !Number(probe[0].found)) {
        return { ok: false, reason: `newest article (rowid ${probe[0].rowid}) not found in the index` };
    }
    return { ok: true };
}

/**
 * Runs checkSqliteFtsConsistency() and, on failure, resets the index and starts the chunked
 * backfill again. Never throws for check failures; returns what it found. Exposed for tests.
 */
export async function checkSqliteFtsAndRepair(
    options: { backfill: "background" | "await" | "none" }
): Promise<SqliteFtsCheckResult> {
    // A backfill (first build or an earlier repair) is running or pending: nothing to verify yet.
    const pending = await db.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM article_fts_backfill WHERE id = 1`);
    if (pending.length > 0) return { ok: true };

    let result: SqliteFtsCheckResult;
    try {
        result = await checkSqliteFtsConsistency();
    } catch (err) {
        result = { ok: false, reason: `check failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (result.ok) return result;

    console.warn(`[search-indexes] FTS index inconsistent (${result.reason}); rebuilding it in the background. Search uses the unaccelerated path meanwhile.`);
    delete (globalThis as unknown as Record<string, unknown>)[FTS_READY_KEY];
    // Same reset as a first-time build, in one transaction with the "not complete" marker, so
    // search stops trusting the index and the triggers skip pending rows from here on.
    await db.$transaction([
        db.$executeRawUnsafe(`DELETE FROM article_fts_meta`),
        db.$executeRawUnsafe(`INSERT INTO article_fts(article_fts) VALUES ('delete-all')`),
        db.$executeRawUnsafe(
            `INSERT OR REPLACE INTO article_fts_backfill (id, upper_rowid, done_rowid)
             SELECT 1, COALESCE(MAX(rowid), 0), 0 FROM "ArticleSearch"`
        ),
    ]);
    // Clear again after the commit: a search that ran during the reset may have re-cached
    // "ready" from the old meta row.
    delete (globalThis as unknown as Record<string, unknown>)[FTS_READY_KEY];
    if (options.backfill === "await") {
        await runSqliteFtsBackfill({ yieldMs: 0 });
    } else if (options.backfill === "background") {
        void runSqliteFtsBackfill().catch((err) => {
            console.warn("[search-indexes] FTS rebuild failed; search stays on the LIKE path and the rebuild resumes on next start.", err);
        });
    }
    return result;
}

const sleep = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
});

/**
 * Runs (or joins) the chunked FTS backfill. Resolves when the index is complete.
 * Single-flight per process; resumable across restarts. Exposed for tests.
 */
export function runSqliteFtsBackfill(options: { yieldMs?: number; targetChunkMs?: number } = {}): Promise<void> {
    const g = globalThis as unknown as Record<string, Promise<void> | undefined>;
    const running = g[FTS_BACKFILL_KEY];
    if (running) return running;
    const promise = backfillLoop(options).finally(() => {
        g[FTS_BACKFILL_KEY] = undefined;
    });
    g[FTS_BACKFILL_KEY] = promise;
    return promise;
}

async function backfillLoop(options: { yieldMs?: number; targetChunkMs?: number }) {
    const yieldMs = options.yieldMs ?? BACKFILL_YIELD_MS;
    const targetMs = options.targetChunkMs ?? BACKFILL_TARGET_CHUNK_MS;
    let rows = 200;
    let failures = 0;

    for (;;) {
        try {
            const progress = await db.$queryRawUnsafe<{ upper_rowid: number | bigint; done_rowid: number | bigint }[]>(
                `SELECT upper_rowid, done_rowid FROM article_fts_backfill WHERE id = 1`
            );
            if (progress.length === 0) return; // finished (or never needed)
            const upper = Number(progress[0].upper_rowid);
            const done = Number(progress[0].done_rowid);

            const next = await db.$queryRawUnsafe<{ bound: number | bigint | null }[]>(
                `SELECT MAX(rowid) AS bound FROM (
                     SELECT rowid FROM "ArticleSearch" WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?
                 )`,
                done,
                upper,
                rows
            );
            const bound = next[0]?.bound == null ? null : Number(next[0].bound);

            if (bound === null) {
                await db.$transaction([
                    db.$executeRawUnsafe(
                        `INSERT OR REPLACE INTO article_fts_meta (id, backfilled_at) VALUES (1, CURRENT_TIMESTAMP)`
                    ),
                    db.$executeRawUnsafe(`DELETE FROM article_fts_backfill WHERE id = 1`),
                ]);
                (globalThis as unknown as Record<string, boolean>)[FTS_READY_KEY] = true;
                return;
            }

            const started = performance.now();
            await db.$transaction([
                db.$executeRawUnsafe(
                    `INSERT INTO article_fts(rowid, id, title, content, excerpt, author)
                     SELECT rowid, id, title, content, excerpt, author FROM "ArticleSearch"
                     WHERE rowid > ? AND rowid <= ?`,
                    done,
                    bound
                ),
                db.$executeRawUnsafe(`UPDATE article_fts_backfill SET done_rowid = ? WHERE id = 1`, bound),
            ]);
            const elapsed = Math.max(1, performance.now() - started);
            rows = Math.min(BACKFILL_MAX_ROWS, Math.max(BACKFILL_MIN_ROWS, Math.round(rows * (targetMs / elapsed))));
            failures = 0;
        } catch (err) {
            // Busy DB etc.: progress is persisted per chunk, so just retry later.
            if (++failures >= 5) throw err;
            await sleep(BACKFILL_RETRY_MS);
            continue;
        }
        await sleep(yieldMs);
    }
}

/**
 * True once the SQLite FTS index is complete (the backfill marker exists). Search
 * must not trust article_fts before that, or terms would miss not-yet-indexed rows.
 * A positive answer is cached for the process; a negative one is a single-row lookup.
 */
export async function isSqliteFtsReady(): Promise<boolean> {
    const g = globalThis as unknown as Record<string, boolean | undefined>;
    if (g[FTS_READY_KEY]) return true;
    try {
        const rows = await db.$queryRawUnsafe<{ id: number }[]>(
            `SELECT id FROM article_fts_meta WHERE id = 1 AND backfilled_at IS NOT NULL`
        );
        if (rows.length > 0) {
            g[FTS_READY_KEY] = true;
            return true;
        }
    } catch {
        // table missing — not ready
    }
    return false;
}
