import { db } from "./db";
import { backfillExternalIds } from "./external-id-store";
import { syncAllFeeds } from "./rss-sync";
import { runDigestScheduler } from "./digest-scheduler";
import { flushDueNotifications } from "./notifications";
import { applyRetentionPoliciesForAllUsers } from "./retention";
import { logger } from "./logger";
import { optimizeSqlitePlannerStatsIfDue } from "./db-maintenance";
import { cleanupStoryClusters, drainStoryClustering, runStoryClustering } from "./story-clustering/job";

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000; // run at most once/day
const STORY_CLUSTERING_BUDGET_MS = 400;

type SchedulerState = {
    timer: ReturnType<typeof setTimeout> | null;
    running: boolean;
    lastRun: number;
    lastError: string | null;
    lastRetentionRun: number;
};

const GLOBAL_KEY = "__feedferret_background_sync__";

function getState(): SchedulerState {
    const g = globalThis as any;
    if (!g[GLOBAL_KEY]) {
        g[GLOBAL_KEY] = {
            timer: null,
            running: false,
            lastRun: 0,
            lastError: null,
            lastRetentionRun: 0,
        } satisfies SchedulerState;
    }
    return g[GLOBAL_KEY] as SchedulerState;
}

/**
 * Everything that follows a sync pass, run one job after the other (they used to be fired
 * concurrently right after the sync and competed with each other and with requests for the
 * event loop) with a macrotask yield in between, and awaited so the tick -- and therefore
 * the "no overlapping ticks" guard -- covers them. Each job is isolated: a failure is logged and
 * the next one still runs. Clustering's leftover drain loop self-schedules bounded passes and is
 * single-flight on its own.
 */
async function runPostTickJobs(state: SchedulerState) {
    const jobs: Array<[string, () => Promise<unknown>]> = [
        // Story clustering (K1): bounded (<= 400 ms) pass over freshly synced articles. Never
        // blocks or fails the tick; leftovers (first-run 48h backfill, big bursts) are drained by a
        // background loop of further bounded passes. Off via DISABLE_STORY_CLUSTERING=true.
        ["story-clustering", async () => {
            const r = await runStoryClustering({ budgetMs: STORY_CLUSTERING_BUDGET_MS });
            if (r.processed > 0) {
                logger.log(
                    `[story-clustering] ${r.processed} processed (${r.created} new, ${r.joined} joined, ${r.singles} single) in ${Math.round(r.ms)}ms`,
                );
            }
            if (r.morePending) drainStoryClustering(STORY_CLUSTERING_BUDGET_MS);
        }],
        // SQLite planner statistics (audit R1): cheap `PRAGMA optimize` after every tick (it only
        // re-analyses what changed a lot, e.g. the first sync of a fresh install), the full
        // all-tables pass at most once a day. No-op on Postgres.
        ["db-maintenance", () => optimizeSqlitePlannerStatsIfDue()],
        // Digest scheduler (internally rate-limits per user; may wait on an AI provider, hence after
        // the bounded jobs) and due push notifications.
        ["digest-scheduler", () => runDigestScheduler()],
        ["push-notifications", () => flushDueNotifications()],
    ];
    // Retention cleanup is expensive relative to a sync tick, so only run it once/day rather than
    // on every ~5-min tick -- and last, after the cheap jobs.
    if (Date.now() - state.lastRetentionRun >= RETENTION_INTERVAL_MS) {
        state.lastRetentionRun = Date.now();
        jobs.push(["retention", async () => {
            await applyRetentionPoliciesForAllUsers()
                .then((r) => logger.log(`[retention] processed ${r.usersProcessed} users, deleted ${r.deleted} articles`))
                .catch((e) => logger.error("[retention] run failed:", e));
            await yieldToLoop();
            await cleanupStoryClusters().catch((e) => logger.error("[story-clustering] cleanup failed:", e));
            await yieldToLoop();
            // K2: briefings > 14 d, AI usage rows > 90 d.
            await import("./briefing/generate").then((m) => m.cleanupBriefingData()).catch((e) => logger.error("[briefing] cleanup failed:", e));
        }]);
    }
    for (const [name, job] of jobs) {
        await yieldToLoop();
        try {
            await job();
        } catch (e) {
            logger.error(`[background-sync] ${name} failed:`, e);
        }
    }
}

/** One scheduler tick; exported for tests. Re-entrant calls while a tick is running are ignored. */
export async function runBackgroundSyncTick() {
    return tick();
}

async function tick() {
    const state = getState();
    if (state.running) return;
    state.running = true;
    try {
        await backfillExternalIds(db as unknown as import("@prisma/client").PrismaClient)
            .catch((error) => logger.error("[external-ids] backfill failed:", error));
        const results = await syncAllFeeds();
        const synced = results.filter((r: any) => r.success && !r.skipped).length;
        const failed = results.filter((r: any) => !r.success).length;
        state.lastRun = Date.now();
        state.lastError = null;
        logger.log(
            `[background-sync] tick: ${synced} synced, ${failed} failed, ${results.length} total`,
        );
        await runPostTickJobs(state);
    } catch (error) {
        state.lastError = String(error);
        logger.error("[background-sync] tick failed:", error);
    } finally {
        state.running = false;
    }
}

export function startBackgroundSync() {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;
    if (process.env.DISABLE_BACKGROUND_SYNC === "true") {
        logger.log("[background-sync] disabled via DISABLE_BACKGROUND_SYNC");
        return;
    }
    if (process.env.NEXT_PHASE === "phase-production-build") return;

    const state = getState();
    if (state.timer) return;

    const intervalMinutes = Number(process.env.BACKGROUND_SYNC_INTERVAL_MINUTES) || 5;
    const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;
    const initialDelayMs = 30_000;

    logger.log(
        `[background-sync] scheduling every ${intervalMinutes}m (initial delay ${initialDelayMs / 1000}s)`,
    );

    state.timer = setTimeout(function loop() {
        void tick().finally(() => {
            const s = getState();
            s.timer = setTimeout(loop, intervalMs);
            s.timer.unref?.();
        });
    }, initialDelayMs);
    state.timer.unref?.();
}

export function getBackgroundSyncStatus() {
    const state = getState();
    return {
        scheduled: state.timer !== null,
        running: state.running,
        lastRun: state.lastRun ? new Date(state.lastRun).toISOString() : null,
        lastError: state.lastError,
    };
}
