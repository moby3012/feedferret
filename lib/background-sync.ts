import { redact } from "./redact";
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
const DEFAULT_JOB_TIMEOUT_MS = 90_000; // override: FEEDFERRET_BACKGROUND_JOB_TIMEOUT_MS

type SchedulerState = {
    timer: ReturnType<typeof setTimeout> | null;
    running: boolean;
    lastRun: number;
    lastError: string | null;
    lastRetentionRun: number;
    /** Names of background jobs that are running right now (single-flight guard). */
    inFlight: Set<string>;
    /** The off-tick lane (digest, notifications, retention) while it is running. */
    lane: Promise<void> | null;
    /** N1: newsletter IMAP poll timer (own cadence, independent of the feed tick). */
    newsletterTimer?: ReturnType<typeof setTimeout> | null;
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
            inFlight: new Set<string>(),
            lane: null,
        } satisfies SchedulerState;
    }
    return g[GLOBAL_KEY] as SchedulerState;
}

/** How long the scheduler waits for one background job before it moves on (the job keeps running). */
function jobTimeoutMs() {
    const n = Number(process.env.FEEDFERRET_BACKGROUND_JOB_TIMEOUT_MS);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_JOB_TIMEOUT_MS;
}

/**
 * Runs one named background job with two guarantees:
 *  - single-flight: while a previous run of `name` is still going (e.g. it hung past its timeout),
 *    the job is skipped instead of piling up a second concurrent instance;
 *  - bounded wait: after the timeout the scheduler logs and carries on. The job is not (cannot be)
 *    cancelled -- it keeps running detached, its flag clears when it actually settles.
 * Never rejects. Returns whether the job was started.
 */
async function runJob(state: SchedulerState, name: string, job: () => Promise<unknown>): Promise<boolean> {
    if (state.inFlight.has(name)) {
        logger.warn(`[background-sync] ${name} skipped: previous run is still going`);
        return false;
    }
    state.inFlight.add(name);
    const run = Promise.resolve()
        .then(job)
        .then(
            () => undefined,
            (e) => void logger.error(`[background-sync] ${name} failed:`, e),
        )
        .finally(() => state.inFlight.delete(name));
    const timeoutMs = jobTimeoutMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        timer.unref?.();
    });
    try {
        if ((await Promise.race([run, timedOut])) === "timeout") {
            logger.error(`[background-sync] ${name} exceeded ${Math.round(timeoutMs / 1000)}s; continuing without it (it keeps running in the background)`);
        }
    } finally {
        if (timer) clearTimeout(timer);
    }
    return true;
}

/**
 * The bounded jobs that follow a sync pass inside the tick, one after the other with a macrotask
 * yield in between (they used to be fired concurrently and competed with each other and with
 * requests for the event loop). Each is isolated and time-boxed (see runJob), so a hanging job can
 * neither block the following ones nor keep `state.running` -- and with it all feed sync -- set.
 * Clustering's leftover drain loop self-schedules bounded passes and is single-flight on its own.
 */
async function runPostTickJobs(state: SchedulerState) {
    const jobs: Array<[string, () => Promise<unknown>]> = [
        // Story clustering (K1): bounded (<= 400 ms) pass over freshly synced articles. Leftovers
        // (first-run 48h backfill, big bursts) are drained by a background loop of further bounded
        // passes. Off via DISABLE_STORY_CLUSTERING=true.
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
    ];
    for (const [name, job] of jobs) {
        await yieldToLoop();
        await runJob(state, name, job);
    }
    startOffTickLane(state);
}

/**
 * Digest mails, push notifications and the daily retention run talk to external services (SMTP, push
 * endpoints, an AI provider) or touch the whole library, so they run OUTSIDE the tick: the next feed
 * sync never waits for them. They run one after the other in a single lane (single-flight: a new
 * lane is not started while the previous one is still running), each job time-boxed and
 * single-flight by name, fire-and-forget with its own error handling.
 */
function startOffTickLane(state: SchedulerState) {
    if (state.lane) return;
    const lane = (async () => {
        await runJob(state, "digest-scheduler", () => runDigestScheduler());
        await yieldToLoop();
        await runJob(state, "push-notifications", () => flushDueNotifications());
        // Retention cleanup is expensive relative to a sync tick, so only run it once/day rather than
        // on every ~5-min tick -- and last, after the cheaper jobs.
        if (Date.now() - state.lastRetentionRun >= RETENTION_INTERVAL_MS) {
            await yieldToLoop();
            await runJob(state, "retention", async () => {
                state.lastRetentionRun = Date.now();
                await applyRetentionPoliciesForAllUsers()
                    .then((r) => logger.log(`[retention] processed ${r.usersProcessed} users, deleted ${r.deleted} articles`))
                    .catch((e) => logger.error("[retention] run failed:", e));
                await yieldToLoop();
                await cleanupStoryClusters().catch((e) => logger.error("[story-clustering] cleanup failed:", e));
                await yieldToLoop();
                // K2: briefings > 14 d, AI usage rows > 90 d.
                await import("./briefing/generate").then((m) => m.cleanupBriefingData()).catch((e) => logger.error("[briefing] cleanup failed:", e));
            });
        }
    })()
        .catch((e) => logger.error("[background-sync] off-tick lane failed:", e))
        .finally(() => {
            state.lane = null;
        });
    state.lane = lane;
}

/** Resolves when the off-tick lane (digest, notifications, retention) is idle; for tests. */
export async function settleBackgroundLane() {
    await getState().lane;
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
        state.lastError = redact(String(error));
        logger.error("[background-sync] tick failed:", error);
    } finally {
        state.running = false;
    }
}

const DEFAULT_NEWSLETTER_POLL_SECONDS = 120;

/** Interval of the newsletter IMAP poll; override: NEWSLETTER_POLL_INTERVAL_SECONDS (min 30). */
function newsletterPollIntervalMs() {
    const n = Number(process.env.NEWSLETTER_POLL_INTERVAL_SECONDS);
    return Math.max(30, Number.isFinite(n) && n > 0 ? n : DEFAULT_NEWSLETTER_POLL_SECONDS) * 1000;
}

/**
 * N1: polls the admin's newsletter IMAP mailbox on its own timer, so mail
 * arrives within ~2 min instead of waiting for the feed tick. Single-flight in
 * this process (runJob); lib/inbound-email-poller.ts additionally claims each
 * source with a conditional UPDATE so a second instance cannot poll it at the
 * same time. The module is imported lazily: imapflow/postal-mime stay out of
 * the startup graph, and an instance without an IMAP source only runs one
 * cheap query per interval.
 */
function startNewsletterPoller(state: SchedulerState) {
    if (state.newsletterTimer || process.env.DISABLE_NEWSLETTER_POLL === "true") return;
    const intervalMs = newsletterPollIntervalMs();
    state.newsletterTimer = setTimeout(function loop() {
        void runJob(state, "newsletter-imap", async () => {
            const { pollInboundSources } = await import("./inbound-email-poller");
            await pollInboundSources();
        }).finally(() => {
            const s = getState();
            s.newsletterTimer = setTimeout(loop, intervalMs);
            s.newsletterTimer.unref?.();
        });
    }, 45_000);
    state.newsletterTimer.unref?.();
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
    startNewsletterPoller(state);
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
