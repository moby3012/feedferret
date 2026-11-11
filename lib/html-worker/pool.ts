// Worker-thread pool for parsing untrusted HTML off the main event loop.
//
// FeedFerret is one Node process: a synchronous jsdom parse of a hostile page
// (1 MiB of nested `<div>`s → 7 s and a stack overflow; 50 000 elements under
// 200 open tags → 3.7 s) used to freeze every request and the background sync
// for everyone. All heavy parsing + extraction (Readability ensemble, page →
// feed suggestions and XPath scraping, selector extraction, page digests,
// newsletter / feed-item sanitizing) therefore runs in a small pool of worker
// threads (lib/html-worker/tasks.ts) with
//   - a hard per-task timeout: the worker is TERMINATED (a sync parse cannot
//     be interrupted any other way) and replaced on the next task,
//   - V8 resource limits per worker (old-generation heap, default 384 MiB —
//     enough for a 2 MiB article through the full-text ensemble, peak ~370 MB
//     used — and stack): a worker that reaches its heap limit dies alone and
//     the task fails with `memory`; the main process is unaffected,
//   - two priority lanes: interactive work (a user waiting on a manual
//     full-text fetch, an add-feed / page-feed preview) goes first and at
//     least one worker is reserved for it; background work (scheduled sync,
//     imports — marked with `runAsBackgroundHtmlWork`) is promoted once it has
//     waited `backgroundAgingMs` (no starvation under sustained interactive
//     load) and gives up after a bounded queue wait (`busy`, retried next sync),
//   - bounded queues: when one is full, callers get a `busy` error at once
//     instead of piling up work.
// Callers bound their input first (lib/html-guard.ts) so legitimate huge
// pages degrade to "parse a prefix" rather than "time out".
//
// The worker script is a separate esbuild bundle (scripts/build-html-worker.mjs
// → build/html-worker/worker.mjs, run by `pnpm run build`, `pnpm dev` and the
// vitest global setup; the Docker image copies it next to server.js).
// The pool FAILS CLOSED: a missing bundle makes every task reject with
// `unavailable` (full text keeps the feed content, page feeds report an
// error) and is surfaced at boot (log + system log) and in /api/health; it
// never falls back to parsing on the main thread. In-process execution exists
// only for unit tests that mock modules: FEEDFERRET_HTML_WORKER_INLINE=1, which
// is refused when NODE_ENV=production.

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { logger } from "@/lib/logger";
import type { HtmlTaskInput, HtmlTaskName, HtmlTaskOutput } from "./tasks";

export type HtmlWorkerAbortReason = "timeout" | "memory" | "busy" | "crashed" | "unavailable";

/** Interactive: a user is waiting. Background: scheduled sync, imports. */
export type HtmlTaskPriority = "interactive" | "background";

/**
 * A task did not complete: the page was too complex (`timeout` / `memory` /
 * `crashed`), the pool is saturated (`busy`, retry later) or the worker cannot
 * run at all (`unavailable`: bundle missing — never parsed on the main thread).
 */
export class HtmlWorkerError extends Error {
  constructor(
    readonly reason: HtmlWorkerAbortReason,
    message: string,
  ) {
    super(message);
    this.name = "HtmlWorkerError";
  }
}

export function isHtmlWorkerError(error: unknown): error is HtmlWorkerError {
  return error instanceof HtmlWorkerError || (error instanceof Error && error.name === "HtmlWorkerError");
}

/** The page / expression itself could not be processed in budget (as opposed to a saturated or missing pool). */
export function isTooComplexError(error: unknown): error is HtmlWorkerError {
  return isHtmlWorkerError(error) && (error.reason === "timeout" || error.reason === "memory" || error.reason === "crashed");
}

/** Error thrown INSIDE a task (a bug or a library error), re-raised on the caller's side. */
export class HtmlTaskFailedError extends Error {
  constructor(message: string, readonly originalName: string) {
    super(message);
    this.name = "HtmlTaskFailedError";
  }
}

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= min && raw <= max ? Math.floor(raw) : fallback;
}

export type HtmlWorkerPoolOptions = {
  /** Path of the bundled worker script. */
  workerPath: string;
  size: number;
  /** Queued tasks per priority lane at most. */
  maxQueue: number;
  /** Background tasks give up (`busy`) after waiting this long in the queue (ms). */
  backgroundQueueWaitMs: number;
  /**
   * Aging: a background task that has waited this long (ms) is dispatched
   * before queued interactive tasks (still never on the reserved worker), so
   * sustained interactive load cannot starve background work. Must be well
   * below `backgroundQueueWaitMs`: an aged task waits at most this plus one
   * task timeout for the next non-reserved worker.
   */
  backgroundAgingMs: number;
  /** Default per-task timeout (ms), counted from the moment a worker picks the task up. */
  timeoutMs: number;
  /**
   * V8 old-generation heap limit of a worker (MiB). Reaching it terminates
   * only that worker (ERR_WORKER_OUT_OF_MEMORY → `memory`). The process can
   * use up to `size` × this (+ ~16 MiB young generation and ~60 MiB baseline
   * each) for HTML work at peak.
   */
  maxOldGenerationSizeMb: number;
  /** A worker is recycled after this many tasks (bounds slow leaks in the parsers). */
  maxTasksPerWorker: number;
  /** Idle workers are terminated after this long (ms). */
  idleMs: number;
};

export function defaultPoolOptions(): HtmlWorkerPoolOptions {
  return {
    workerPath:
      process.env.FEEDFERRET_HTML_WORKER_PATH ||
      path.join(/*turbopackIgnore: true*/ process.cwd(), "build", "html-worker", "worker.mjs"),
    // Two by default even on small machines: one worker stays reserved for
    // interactive work while background sync uses the other.
    size: intFromEnv("FEEDFERRET_HTML_WORKER_POOL_SIZE", 2, 1, 8),
    maxQueue: intFromEnv("FEEDFERRET_HTML_WORKER_QUEUE", 64, 1, 1000),
    backgroundQueueWaitMs: intFromEnv("FEEDFERRET_HTML_WORKER_BACKGROUND_WAIT_MS", 60_000, 100, 3_600_000),
    backgroundAgingMs: intFromEnv("FEEDFERRET_HTML_WORKER_BACKGROUND_AGING_MS", 15_000, 0, 3_600_000),
    timeoutMs: intFromEnv("FEEDFERRET_HTML_WORKER_TIMEOUT_MS", 8_000, 100, 120_000),
    // Small-VPS default: 2 × 384 MiB. Measured peaks (used heap, worker limited
    // to 384 MiB): 357 KiB news page 203 MB, 660 KiB homepage 314 MB, 2 MiB
    // article 372 MB; at 256 MiB the 660 KiB page already fails. Raise it for
    // very large pages; hostile input is stopped by the guard and the timeout.
    maxOldGenerationSizeMb: intFromEnv("FEEDFERRET_HTML_WORKER_HEAP_MB", 384, 128, 8192),
    maxTasksPerWorker: 200,
    idleMs: 5 * 60_000,
  };
}

// The only environment the parsing code reads.
const WORKER_ENV_KEYS = ["NODE_ENV", "TZ", "FEEDFERRET_DISABLE_FTR"];

function workerEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of WORKER_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

type Job = {
  id: number;
  task: HtmlTaskName;
  input: unknown;
  timeoutMs: number;
  priority: HtmlTaskPriority;
  /** performance.now() when queued (aging). */
  enqueuedAt: number;
  /** Background only: rejects the job if it is still queued when this fires. */
  waitTimer: NodeJS.Timeout | null;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

type Reply =
  | { ready: true }
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { name: string; message: string } };

// Upper bound for a worker to load its bundle (jsdom, parsers) before it counts as crashed.
const WORKER_BOOT_TIMEOUT_MS = 30_000;

class Slot {
  worker: Worker | null = null;
  /** The current worker has loaded its parsers and accepts tasks. */
  private ready = false;
  job: Job | null = null;
  tasksDone = 0;
  private timer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pool: HtmlWorkerPool,
    private readonly options: HtmlWorkerPoolOptions,
  ) {}

  get busy() {
    return this.job !== null;
  }

  private spawn(): Worker {
    const worker = new Worker(/*turbopackIgnore: true*/ this.options.workerPath, {
      resourceLimits: {
        maxOldGenerationSizeMb: this.options.maxOldGenerationSizeMb,
        // Small semi-spaces: less garbage per worker and smaller promotion bursts near the limit.
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
      // No inherited node flags (loaders, inspector, test-runner hooks): the
      // worker is a plain parser.
      execArgv: [],
      // Workers never see the parent's env-backed secrets (DB URL, auth / API keys).
      env: workerEnv(),
      stdout: false,
      stderr: false,
    });
    // An idle pool must not keep the process (CLI scripts, tests) alive; a
    // running task keeps it alive through its timeout timer.
    worker.unref();
    worker.on("message", (reply: Reply) => this.onReply(worker, reply));
    worker.on("error", (error: unknown) => this.onFailure(worker, error instanceof Error ? error : new Error(String(error))));
    worker.on("exit", (code) => this.onFailure(worker, new Error(`HTML worker exited with code ${code}`)));
    this.pool.stats.spawned++;
    return worker;
  }

  run(job: Job) {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.job = job;
    if (!this.worker) {
      this.worker = this.spawn();
      this.ready = false;
    }
    const worker = this.worker;
    if (this.ready) this.start(worker, job);
    else {
      // Started by onReply() once the worker reports ready.
      this.timer = setTimeout(() => {
        this.discard(worker);
        this.pool.stats.crashes++;
        reportWorkerBoot(false);
        this.finish(worker, null, new HtmlWorkerError("unavailable", `HTML worker did not start within ${WORKER_BOOT_TIMEOUT_MS} ms`));
      }, WORKER_BOOT_TIMEOUT_MS);
    }
  }

  private start(worker: Worker, job: Job) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.pool.stats.timeouts++;
      // Terminate first: finish() may hand this slot the next queued job.
      this.discard(worker);
      this.finish(
        worker,
        null,
        new HtmlWorkerError("timeout", `HTML task "${job.task}" exceeded ${job.timeoutMs} ms; worker terminated`),
      );
    }, job.timeoutMs);
    worker.postMessage({ id: job.id, task: job.task, input: job.input });
  }

  private onReply(worker: Worker, reply: Reply) {
    if (worker !== this.worker) return;
    if ("ready" in reply) {
      this.ready = true;
      reportWorkerBoot(true);
      if (this.job) this.start(worker, this.job);
      return;
    }
    if (!this.job || reply.id !== this.job.id) return;
    // Recycle before finish(): finish() may hand this slot the next queued job.
    if (++this.tasksDone >= this.options.maxTasksPerWorker) this.discard(worker);
    if (reply.ok) this.finish(worker, { value: reply.result }, null);
    else this.finish(worker, null, new HtmlTaskFailedError(reply.error.message, reply.error.name));
  }

  private onFailure(worker: Worker, error: Error) {
    if (worker !== this.worker) return; // already discarded (timeout / recycle)
    // Died before loading its bundle (missing jsdom, broken build): nothing can be parsed.
    const booted = this.ready;
    if (!booted) reportWorkerBoot(false);
    this.worker = null;
    if (this.job) {
      this.pool.stats.crashes++;
      const code = (error as { code?: string }).code;
      this.finish(
        worker,
        null,
        !booted
          ? new HtmlWorkerError("unavailable", `HTML worker failed to start${code ? ` (${code})` : ""}: ${error.message}`)
          : code === "ERR_WORKER_OUT_OF_MEMORY"
            ? new HtmlWorkerError("memory", `HTML task "${this.job.task}" exceeded the worker heap limit (${this.options.maxOldGenerationSizeMb} MiB); worker terminated`)
            : new HtmlWorkerError("crashed", `HTML task "${this.job.task}" crashed the worker${code ? ` (${code})` : ""}: ${error.message}`),
      );
    }
  }

  private finish(worker: Worker, ok: { value: unknown } | null, error: Error | null) {
    const job = this.job;
    if (!job) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.job = null;
    if (ok) job.resolve(ok.value);
    else job.reject(error);
    if (this.worker === worker && worker) this.armIdle(worker);
    this.pool.dispatch();
  }

  private armIdle(worker: Worker) {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.job && this.worker === worker) this.discard(worker);
    }, this.options.idleMs);
    this.idleTimer.unref();
  }

  discard(worker: Worker) {
    if (this.worker === worker) {
      this.worker = null;
      this.tasksDone = 0;
    }
    void worker.terminate().catch(() => {});
  }

  shutdown() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.worker) this.discard(this.worker);
  }
}

export type RunOptions = {
  timeoutMs?: number;
  priority?: HtmlTaskPriority;
  /** Background only: queue-wait deadline (ms); default `backgroundQueueWaitMs`. */
  queueWaitMs?: number;
};

export class HtmlWorkerPool {
  private readonly slots: Slot[];
  private readonly queues: Record<HtmlTaskPriority, Job[]> = { interactive: [], background: [] };
  private nextId = 1;
  readonly stats = { spawned: 0, timeouts: 0, crashes: 0, rejectedBusy: 0, backgroundExpired: 0, backgroundAged: 0, completed: 0 };

  constructor(readonly options: HtmlWorkerPoolOptions) {
    this.slots = Array.from({ length: options.size }, () => new Slot(this, options));
  }

  run<K extends HtmlTaskName>(task: K, input: HtmlTaskInput<K>, opts: number | RunOptions = {}): Promise<HtmlTaskOutput<K>> {
    const o: RunOptions = typeof opts === "number" ? { timeoutMs: opts } : opts;
    const priority = o.priority ?? "interactive";
    const queue = this.queues[priority];
    if (queue.length >= this.options.maxQueue) {
      this.stats.rejectedBusy++;
      return Promise.reject(new HtmlWorkerError("busy", `HTML worker ${priority} queue is full (${this.options.maxQueue} waiting)`));
    }
    return new Promise<HtmlTaskOutput<K>>((resolve, reject) => {
      const job: Job = {
        id: this.nextId++,
        task,
        input,
        timeoutMs: o.timeoutMs ?? this.options.timeoutMs,
        priority,
        enqueuedAt: performance.now(),
        waitTimer: null,
        resolve: (value) => {
          this.stats.completed++;
          resolve(value as HtmlTaskOutput<K>);
        },
        reject,
      };
      if (priority === "background") {
        const waitMs = o.queueWaitMs ?? this.options.backgroundQueueWaitMs;
        job.waitTimer = setTimeout(() => {
          const at = queue.indexOf(job);
          if (at < 0) return; // already running
          queue.splice(at, 1);
          this.stats.backgroundExpired++;
          reject(new HtmlWorkerError("busy", `HTML task "${task}" waited ${waitMs} ms in the background queue; deferred`));
        }, waitMs);
        job.waitTimer.unref();
      }
      queue.push(job);
      this.dispatch();
    });
  }

  /** Background tasks may occupy all but one worker (the reserved interactive slot) when there are two or more. */
  private get backgroundCapacity(): number {
    return this.slots.length >= 2 ? this.slots.length - 1 : this.slots.length;
  }

  dispatch() {
    let backgroundRunning = this.slots.filter((slot) => slot.job?.priority === "background").length;
    for (const slot of this.slots) {
      if (slot.busy) continue;
      const backgroundAllowed = backgroundRunning < this.backgroundCapacity;
      const head = this.queues.background[0];
      const aged = head !== undefined && performance.now() - head.enqueuedAt >= this.options.backgroundAgingMs;
      let job: Job | undefined;
      if (aged && backgroundAllowed) {
        job = this.queues.background.shift();
        this.stats.backgroundAged++;
      } else {
        job = this.queues.interactive.shift();
        if (!job && backgroundAllowed) job = this.queues.background.shift();
      }
      if (!job) return;
      if (job.priority === "background") backgroundRunning++;
      if (job.waitTimer) clearTimeout(job.waitTimer);
      slot.run(job);
    }
  }

  /** Workers currently alive (tests / diagnostics). */
  get liveWorkers(): number {
    return this.slots.filter((s) => s.worker !== null).length;
  }

  get queued(): number {
    return this.queues.interactive.length + this.queues.background.length;
  }

  shutdown() {
    for (const job of [...this.queues.interactive.splice(0), ...this.queues.background.splice(0)]) {
      if (job.waitTimer) clearTimeout(job.waitTimer);
      job.reject(new HtmlWorkerError("busy", "HTML worker pool shut down"));
    }
    for (const slot of this.slots) slot.shutdown();
  }
}

/* -------------------------------------------------------------------------- */
/* Process-wide pool                                                           */
/* -------------------------------------------------------------------------- */

export type HtmlWorkerStatus = "ok" | "unavailable" | "unknown";

type ProcessState = {
  pool: HtmlWorkerPool | null;
  status: HtmlWorkerStatus;
  unavailableLogged: boolean;
  inlineRefusedLogged: boolean;
  priority: AsyncLocalStorage<HtmlTaskPriority>;
};

// ONE pool per process. Next.js bundles instrumentation.ts (boot warm-up,
// background sync) and the route handlers separately, so module-level state
// would exist twice: two pools (twice the workers, the interactive
// reservation per copy) and a health route that never sees the warm-up.
const STATE_KEY = Symbol.for("feedferret.htmlWorker");
function state(): ProcessState {
  const g = globalThis as unknown as Record<symbol, ProcessState | undefined>;
  return (g[STATE_KEY] ??= {
    pool: null,
    status: "unknown",
    unavailableLogged: false,
    inlineRefusedLogged: false,
    priority: new AsyncLocalStorage<HtmlTaskPriority>(),
  });
}

/** Health signal (/api/health, boot): can untrusted HTML be parsed at all right now? */
export function htmlWorkerStatus(): HtmlWorkerStatus {
  return state().status;
}

/** Test-only in-process execution: FEEDFERRET_HTML_WORKER_INLINE=1, never in production. */
function inlineAllowed(): boolean {
  if (process.env.FEEDFERRET_HTML_WORKER_INLINE !== "1") return false;
  if (process.env.NODE_ENV === "production") {
    if (!state().inlineRefusedLogged) {
      state().inlineRefusedLogged = true;
      logger.error("[html-worker] FEEDFERRET_HTML_WORKER_INLINE=1 is ignored in production: untrusted HTML is only parsed in workers.");
    }
    return false;
  }
  return true;
}

function getPool(): HtmlWorkerPool | null {
  const st = state();
  if (st.pool) return st.pool;
  const options = defaultPoolOptions();
  if (!existsSync(/*turbopackIgnore: true*/ options.workerPath)) {
    st.status = "unavailable";
    if (!st.unavailableLogged) {
      st.unavailableLogged = true;
      logger.error(
        `[html-worker] worker bundle missing (${options.workerPath}): full-text extraction, page feeds, newsletter and ` +
          "feed-item sanitizing are DISABLED (fail closed, nothing is parsed on the main thread). " +
          "Run `pnpm run build:html-worker` (part of `pnpm run build`) / check the Docker image.",
      );
    }
    return null;
  }
  st.pool = new HtmlWorkerPool(options);
  return st.pool;
}

/** Called by the pool: a worker started (`ok`) or died before it could load its bundle (`unavailable`). */
export function reportWorkerBoot(ok: boolean) {
  state().status = ok ? "ok" : "unavailable";
}

/**
 * Runs `fn` with every HTML task it starts (however deep) queued as
 * background work: scheduled sync, imports. Interactive is the default.
 */
export function runAsBackgroundHtmlWork<T>(fn: () => Promise<T>): Promise<T> {
  return state().priority.run("background", fn);
}

/** The priority HTML tasks started from the current async context get. */
export function currentHtmlTaskPriority(): HtmlTaskPriority {
  return state().priority.getStore() ?? "interactive";
}

async function runInline<K extends HtmlTaskName>(task: K, input: HtmlTaskInput<K>): Promise<HtmlTaskOutput<K>> {
  const { runHtmlTaskInProcess } = await import("./tasks");
  return runHtmlTaskInProcess(task, input);
}

/**
 * Runs one HTML task in the worker pool. Rejects with `HtmlWorkerError`
 * (`timeout` / `memory` / `crashed`: the page is too complex; `busy`: the pool
 * is saturated or a background task waited too long, retry later;
 * `unavailable`: no worker bundle, fail closed) or `HtmlTaskFailedError` (the
 * task itself threw). Priority defaults to the async context's
 * (`runAsBackgroundHtmlWork`), else interactive.
 */
export function runHtmlTask<K extends HtmlTaskName>(task: K, input: HtmlTaskInput<K>, options: RunOptions = {}): Promise<HtmlTaskOutput<K>> {
  if (inlineAllowed()) return runInline(task, input);
  const pool = getPool();
  if (!pool) {
    return Promise.reject(new HtmlWorkerError("unavailable", "HTML worker bundle missing; untrusted HTML is not parsed (fail closed)"));
  }
  return pool.run(task, input, { ...options, priority: options.priority ?? currentHtmlTaskPriority() });
}

/**
 * Spawns one worker and loads the parsers ahead of the first sync tick (boot).
 * Never throws; returns the resulting status for the boot log / system log.
 */
export async function warmHtmlWorker(): Promise<HtmlWorkerStatus> {
  const st = state();
  if (inlineAllowed()) return (st.status = "ok");
  try {
    await runHtmlTask("warm", null, { timeoutMs: 30_000 });
    st.status = "ok";
  } catch (error) {
    if (isHtmlWorkerError(error) && error.reason === "unavailable") return (st.status = "unavailable");
    logger.error("[html-worker] warm-up failed:", error);
    st.status = "unavailable";
  }
  return st.status;
}

/** Test helper: drops the shared pool (terminating its workers). */
export function resetHtmlWorkerPool() {
  const st = state();
  st.pool?.shutdown();
  st.pool = null;
  st.unavailableLogged = false;
  st.status = "unknown";
}
