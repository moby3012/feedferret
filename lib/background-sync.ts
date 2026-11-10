import { db } from "./db";
import { backfillExternalIds } from "./external-id-store";
import { syncAllFeeds } from "./rss-sync";
import { runDigestScheduler } from "./digest-scheduler";
import { flushDueNotifications } from "./notifications";
import { applyRetentionPoliciesForAllUsers } from "./retention";
import { logger } from "./logger";
import { optimizeSqlitePlannerStatsIfDue } from "./db-maintenance";
import { cleanupStoryClusters, drainStoryClustering, runStoryClustering } from "./story-clustering/job";

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
        // Run digest scheduler after each sync tick (internally rate-limits per user)
        void runDigestScheduler().catch((e) =>
            logger.error("[digest-scheduler] error:", e),
        );
        void flushDueNotifications().catch((e) =>
            logger.error("[push-notifications] flush failed:", e),
        );

        // Story clustering (K1): bounded (<= 400 ms) pass over freshly synced articles. Never
        // blocks or fails the tick; leftovers (first-run 48h backfill, big bursts) are drained
        // by a background loop of further bounded passes. Off via DISABLE_STORY_CLUSTERING=true.
        void runStoryClustering({ budgetMs: STORY_CLUSTERING_BUDGET_MS })
            .then((r) => {
                if (r.processed > 0) {
                    logger.log(
                        `[story-clustering] ${r.processed} processed (${r.created} new, ${r.joined} joined, ${r.singles} single) in ${Math.round(r.ms)}ms`,
                    );
                }
                if (r.morePending) drainStoryClustering(STORY_CLUSTERING_BUDGET_MS);
            })
            .catch((e) => logger.error("[story-clustering] tick failed:", e));

        // SQLite planner statistics (audit R1): cheap `PRAGMA optimize` after every tick (it
        // only re-analyses what changed a lot, e.g. the first sync of a fresh install), the
        // full all-tables pass at most once a day. No-op on Postgres.
        void optimizeSqlitePlannerStatsIfDue().catch((e) => logger.error("[db-maintenance] optimize failed:", e));

        // Retention cleanup is expensive relative to a sync tick, so only run it
        // once/day rather than on every ~5-min tick.
        if (Date.now() - state.lastRetentionRun >= RETENTION_INTERVAL_MS) {
            state.lastRetentionRun = Date.now();
            void applyRetentionPoliciesForAllUsers()
                .then((r) =>
                    logger.log(
                        `[retention] processed ${r.usersProcessed} users, deleted ${r.deleted} articles`,
                    ),
                )
                .catch((e) => logger.error("[retention] run failed:", e))
                .then(() => cleanupStoryClusters())
                .catch((e) => logger.error("[story-clustering] cleanup failed:", e))
                // K2: briefings > 14 d, AI usage rows > 90 d.
                .then(() => import("./briefing/generate").then((m) => m.cleanupBriefingData()))
                .catch((e) => logger.error("[briefing] cleanup failed:", e));
        }
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
