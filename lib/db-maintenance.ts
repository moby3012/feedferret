import { db, getDatabaseProvider } from "./db";

// SQLite planner statistics (audit finding R1).
//
// Prisma never runs ANALYZE, so a default install has no `sqlite_stat1` and the
// planner guesses. On a 50 k-article DB it then picks e.g.
// `Article_userId_isSpoiler_publishedAt_idx` for the read-later / starred counts
// and walks the user's whole table (50 ms) instead of the tiny partial-selective
// index (0.3 ms); the per-feed unread list walks the user index in order (56 ms
// instead of 4 ms). `PRAGMA optimize` (cheap, after every sync tick) and a full per-index
// ANALYZE (at boot and once a day) fix that. With `analysis_limit` the scan is
// approximate and bounded, so a pass takes tens of milliseconds even on a large DB.
//
// Postgres is a no-op: autovacuum keeps planner statistics fresh by itself.

// Bounded ANALYZE sampling (rows examined per index). The SQLite docs suggest 100–1000, but on
// this schema that is too coarse: with 1000 the per-feed unread list (50 k articles) still picked
// the `userId` index and took ~65 ms, with >= 5000 it picks `feedId` and takes ~1 ms. 20 000 costs
// ~35 ms for a 50 k-article / 380 MB DB and is bounded for bigger ones.
const ANALYSIS_LIMIT = 20_000;

// better-sqlite3 is synchronous: one `ANALYZE` over a big, cold database blocks the event loop for
// all of it (≈0.8 s on a 380 MB DB straight after boot). The "full" pass therefore analyses one
// explicit index at a time and yields to the event loop in between, so no single stall exceeds
// the cost of one index sample.
// Heavy one-off boot work (first-time statistics, FTS backfill) waits this long so the first page
// load after a restart is not competing with it on the single event loop.
export const STARTUP_GRACE_MS = 10_000;

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

async function analyzeIndexByIndex() {
    const indexes = await db.$queryRawUnsafe<{ name: string }[]>(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND tbl_name NOT LIKE 'article_fts%'
         ORDER BY tbl_name, name`
    );
    for (const { name } of indexes) {
        await db.$executeRawUnsafe(`ANALYZE main."${name.replace(/"/g, '""')}"`);
        await yieldToLoop();
    }
}

const GLOBAL_KEY = "__feedferret_sqlite_optimize__";
type OptimizeState = { running: boolean; lastFullRun: number };

function getState(): OptimizeState {
    const g = globalThis as unknown as Record<string, OptimizeState | undefined>;
    return (g[GLOBAL_KEY] ??= { running: false, lastFullRun: 0 });
}

export const SQLITE_FULL_OPTIMIZE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type OptimizeResult = { ran: boolean; ms: number; full: boolean };

/**
 * Refreshes SQLite planner statistics. Never throws and never runs concurrently
 * with itself. `full` forces the "all tables" pass; otherwise the cheap default
 * `PRAGMA optimize` runs (which is a near no-op when nothing changed much).
 */
export async function optimizeSqlitePlannerStats(options: { full?: boolean } = {}): Promise<OptimizeResult> {
    if (getDatabaseProvider() !== "sqlite") return { ran: false, ms: 0, full: false };
    const state = getState();
    if (state.running) return { ran: false, ms: 0, full: false };
    state.running = true;
    const started = performance.now();
    const full = options.full === true;
    try {
        // analysis_limit is per connection and returns a row, so use queryRaw.
        await db.$queryRawUnsafe(`PRAGMA analysis_limit = ${ANALYSIS_LIMIT}`);
        if (full) await analyzeIndexByIndex();
        else await db.$executeRawUnsafe(`PRAGMA optimize`);
        if (full) state.lastFullRun = Date.now();
        return { ran: true, ms: performance.now() - started, full };
    } catch (error) {
        console.warn("[db-maintenance] PRAGMA optimize failed; query plans may be suboptimal until the next attempt", error);
        return { ran: false, ms: performance.now() - started, full };
    } finally {
        state.running = false;
    }
}

/** Full pass at most once per interval, the cheap default pass otherwise. */
export async function optimizeSqlitePlannerStatsIfDue(now = Date.now()): Promise<OptimizeResult> {
    const full = now - getState().lastFullRun >= SQLITE_FULL_OPTIMIZE_INTERVAL_MS;
    return optimizeSqlitePlannerStats({ full });
}

/**
 * Boot hook: schedules the first pass shortly after startup, off the critical path, so the first
 * HTTP response never waits for it. A DB that has no statistics yet (fresh install, upgrade) gets
 * the full per-index pass; one that already has them keeps its persisted statistics (the cheap
 * `PRAGMA optimize` after sync ticks and the daily full pass keep them fresh), so a restart does
 * not re-read a large database just to re-derive them.
 */
export function scheduleStartupSqliteOptimize(delayMs = STARTUP_GRACE_MS) {
    if (getDatabaseProvider() !== "sqlite") return;
    const timer = setTimeout(() => {
        void (async () => {
            let hasStats = false;
            try {
                // sqlite_stat1 only exists once ANALYZE has run; probe sqlite_master so a missing table
                // does not surface as a Prisma "raw query failed" error log.
                const table = await db.$queryRawUnsafe<{ n: number | bigint }[]>(`SELECT 1 AS n FROM sqlite_master WHERE name = 'sqlite_stat1'`);
                hasStats = table.length > 0 && (await db.$queryRawUnsafe<{ n: number | bigint }[]>(`SELECT 1 AS n FROM sqlite_stat1 LIMIT 1`)).length > 0;
            } catch {
                // treat as "no statistics yet"
            }
            if (hasStats) {
                getState().lastFullRun = Date.now();
                await optimizeSqlitePlannerStats();
                return;
            }
            const r = await optimizeSqlitePlannerStats({ full: true });
            if (r.ran) console.info(`[db-maintenance] planner statistics created in ${Math.round(r.ms)} ms`);
        })();
    }, delayMs);
    timer.unref?.();
}
