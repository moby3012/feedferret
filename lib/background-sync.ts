import { syncAllFeeds } from "./rss-sync";
import { runDigestScheduler } from "./digest-scheduler";
import { flushDueNotifications } from "./notifications";
import { logger } from "./logger";

type SchedulerState = {
    timer: ReturnType<typeof setTimeout> | null;
    running: boolean;
    lastRun: number;
    lastError: string | null;
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
        } satisfies SchedulerState;
    }
    return g[GLOBAL_KEY] as SchedulerState;
}

async function tick() {
    const state = getState();
    if (state.running) return;
    state.running = true;
    try {
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
