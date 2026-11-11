// The HTML worker pool (lib/html-worker) against the real bundled worker
// (build/html-worker/worker.mjs, built by the vitest global setup): the main
// event loop must stay responsive while a worker chews on hostile HTML, a task
// over budget must terminate its worker, and extraction results must be
// identical to in-process extraction.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HtmlWorkerError,
  HtmlWorkerPool,
  defaultPoolOptions,
  currentHtmlTaskPriority,
  htmlWorkerStatus,
  resetHtmlWorkerPool,
  runAsBackgroundHtmlWork,
  runHtmlTask,
  warmHtmlWorker,
  type HtmlWorkerPoolOptions,
} from "@/lib/html-worker/pool";
import { runHtmlTaskInProcess } from "@/lib/html-worker/tasks";
import { extractReadableContent } from "@/lib/readability-extract";
import { runInHtmlWorker } from "@/lib/html-worker";

const MiB = 1024 * 1024;
const pools: HtmlWorkerPool[] = [];

function makePool(overrides: Partial<HtmlWorkerPoolOptions> = {}): HtmlWorkerPool {
  const pool = new HtmlWorkerPool({ ...defaultPoolOptions(), size: 1, maxQueue: 8, timeoutMs: 20_000, ...overrides });
  pools.push(pool);
  return pool;
}

afterEach(() => {
  for (const pool of pools.splice(0)) pool.shutdown();
  resetHtmlWorkerPool();
  delete process.env.FEEDFERRET_HTML_WORKER_TIMEOUT_MS;
  process.env.FEEDFERRET_HTML_WORKER_INLINE = "1";
});

/** Samples event-loop responsiveness while `work` runs: tick count and the longest gap between ticks. */
async function whileTicking<T>(work: () => Promise<T>): Promise<{ result: PromiseSettledResult<T>; ticks: number; maxGapMs: number; ms: number }> {
  let ticks = 0;
  let last = performance.now();
  let maxGapMs = 0;
  const interval = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
    ticks++;
  }, 10);
  const start = performance.now();
  const [result] = await Promise.allSettled([work()]);
  const ms = performance.now() - start;
  clearInterval(interval);
  return { result, ticks, maxGapMs, ms };
}

describe("HTML worker pool", () => {
  it("keeps the main thread responsive while a worker parses 1 MiB of hostile HTML (unguarded)", async () => {
    const pool = makePool({ timeoutMs: 3_000 });
    await pool.run("warm", null); // spawn + load parsers outside the measurement
    // 1 MiB of nested <div>s: on the main thread this blocked the loop for seconds and then overflowed the stack.
    const hostile = "<div>".repeat(MiB / 5);
    const { result, ticks, maxGapMs, ms } = await whileTicking(() => pool.run("extractReadable", { html: hostile, url: "https://evil.example/a" }));
    // Either outcome is fine for the pool (stack overflow → empty result, or timeout); the loop must never stall.
    if (result.status === "rejected") expect(result.reason).toBeInstanceOf(HtmlWorkerError);
    expect(ms).toBeGreaterThan(100);
    expect(ticks).toBeGreaterThan(ms / 10 / 3);
    expect(maxGapMs).toBeLessThan(250);
  }, 30_000);

  it("terminates a worker that exceeds its timeout, reports it, and serves the next task with a fresh worker", async () => {
    const pool = makePool({ timeoutMs: 300 });
    const { result, maxGapMs } = await whileTicking(() => pool.run("__testBusyLoop", { ms: 10_000 }));
    expect(result.status).toBe("rejected");
    const error = (result as PromiseRejectedResult).reason as HtmlWorkerError;
    expect(error).toBeInstanceOf(HtmlWorkerError);
    expect(error.reason).toBe("timeout");
    expect(maxGapMs).toBeLessThan(250);
    expect(pool.stats.timeouts).toBe(1);
    expect(pool.liveWorkers).toBe(0); // terminated, not left spinning

    const spawnedBefore = pool.stats.spawned;
    await expect(pool.run("sanitizeFeedItems", { items: ["<p onclick=x>ok</p>"] }, 10_000)).resolves.toEqual([{ excerpt: "ok", html: "<p>ok</p>" }]);
    expect(pool.stats.spawned).toBe(spawnedBefore + 1);
  }, 30_000);

  it("a task waiting in the queue is not charged for the time it waited", async () => {
    const pool = makePool({ timeoutMs: 1_000 });
    // Worker start-up does not count either: the timer starts when the worker reports ready.
    const [slow, queued] = await Promise.allSettled([
      pool.run("__testBusyLoop", { ms: 700 }),
      pool.run("__testBusyLoop", { ms: 500 }),
    ]);
    expect(slow.status).toBe("fulfilled");
    expect(queued.status).toBe("fulfilled");
  }, 30_000);

  it("rejects with `busy` instead of queueing without bound", async () => {
    const pool = makePool({ maxQueue: 2, timeoutMs: 5_000 });
    const running = pool.run("__testBusyLoop", { ms: 300 });
    const q1 = pool.run("__testBusyLoop", { ms: 1 });
    const q2 = pool.run("__testBusyLoop", { ms: 1 });
    await expect(pool.run("__testBusyLoop", { ms: 1 })).rejects.toMatchObject({ name: "HtmlWorkerError", reason: "busy" });
    await Promise.all([running, q1, q2]);
    expect(pool.stats.rejectedBusy).toBe(1);
  }, 30_000);

  it("memory bombs hit the worker heap limit: `memory` error, worker replaced, the process survives (10 in a row)", () => {
    // Runs the real pool in a separate plain Node process, so a regression
    // (a worker's heap-limit abort taking the WHOLE process down) fails this
    // test instead of killing the test runner. The process keeps working
    // between and after the bombs.
    const dir = mkdtempSync(join(tmpdir(), "ff-html-worker-oom-"));
    try {
      const entry = join(dir, "oom-entry.ts");
      writeFileSync(
        entry,
        `import { HtmlWorkerPool, defaultPoolOptions } from ${JSON.stringify(join(process.cwd(), "lib/html-worker/pool.ts"))};
const pool = new HtmlWorkerPool({ ...defaultPoolOptions(), workerPath: ${JSON.stringify(defaultPoolOptions().workerPath)}, size: 1, maxOldGenerationSizeMb: 128, timeoutMs: 30000 });
const out = { bombs: [] };
for (let i = 0; i < 10; i++) {
  try { await pool.run("__testAllocate", { mb: 2000 }); out.bombs.push("resolved"); } catch (e) { out.bombs.push(e.name + ":" + e.reason); }
  await new Promise((r) => setTimeout(r, 20));
}
out.live = pool.liveWorkers;
out.after = await pool.run("sanitizeFeedItems", { items: ["<b>ok</b>"] });
pool.shutdown();
console.log(JSON.stringify(out));`,
      );
      const bundle = join(dir, "oom.mjs");
      buildSync({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", tsconfig: join(process.cwd(), "tsconfig.json"), logLevel: "silent" });
      const stdout = execFileSync(process.execPath, [bundle], { cwd: process.cwd(), encoding: "utf8", timeout: 110_000 });
      expect(JSON.parse(stdout.trim().split("\n").pop()!)).toEqual({
        bombs: Array(10).fill("HtmlWorkerError:memory"),
        live: 0,
        after: [{ excerpt: "ok", html: "<b>ok</b>" }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("re-raises an error thrown inside a task without killing the worker", async () => {
    const pool = makePool();
    await expect(
      pool.run("selectorExtract", { html: "<p>x</p>", url: "https://a.example/", selector: "::not a selector((", mode: "sync" }),
    ).rejects.toMatchObject({ name: "HtmlTaskFailedError" });
    expect(pool.liveWorkers).toBe(1);
  }, 30_000);

  it("every task round-trips through the worker (structured-clone safe) with the in-process result", async () => {
    const pool = makePool();
    const page = readFileSync(join(process.cwd(), "tests/fixtures/page-feed/news-de-1.html"), "utf8");
    const url = "https://news.example/";
    const listPage = `<html><body><main><ul class="posts">${Array.from({ length: 12 }, (_, i) => `<li class="post"><h2><a href="/p/${i}">Post number ${i} about something</a></h2><time datetime="2026-11-0${(i % 9) + 1}">x</time><p>Teaser text for post ${i}, long enough to look like a real teaser.</p></li>`).join("")}</ul></main></body></html>`;
    const cases = [
      ["xpathArticles", { html: page, url, config: { xpath: { xPathItem: "//article", xPathItemTitle: ".//h2", xPathItemUri: ".//a/@href" } }, contentType: "text/html" }],
      ["xpathString", { html: "<html><body><script id=d>{\"items\":[]}</script></body></html>", url, expression: "string(//script[@id='d'])" }],
      ["suggestFeedCandidates", { html: listPage, url }],
      // A real page with the deterministic work bound (no wall-clock budget): equal under any CI load.
      ["suggestFeedCandidates", { html: page, url, timeBudgetMs: Infinity, maxGroups: 12 }],
      ["pageDigest", { html: page, url }],
      ["selectorExtract", { html: page, url, selector: null, removeSelectors: null, mode: "preview" }],
      ["selectorText", { html: page, url, selector: "body" }],
      ["newsletterBody", { html: '<p>Hi <a href="https://x.example/?utm_source=a">x</a><img src="https://open.substack.com/o" width=1></p>', text: null, fallbackHtml: null, inlineImages: [] }],
      ["sanitizeFeedItems", { items: ["<p>a<script>x</script></p>", "<img src=x onerror=alert(1)>"], removeSelectors: ".ad" }],
      ["removeSelectors", { items: ['<p>keep</p><div class="ad">x</div>', "<p>none</p>"], selectors: ".ad, :is(aside, .promo)" }],
    ] as const;
    for (const [task, input] of cases) {
      const viaWorker = await pool.run(task, input as never);
      const inProcess = await runHtmlTaskInProcess(task, input as never);
      expect(viaWorker, task).toEqual(inProcess);
    }
  }, 60_000);

  it("full-text corpus (#275): worker extraction is identical to in-process extraction", async () => {
    const pool = makePool({ size: 2 });
    const root = join(process.cwd(), "tests/fixtures/fulltext");
    const cases = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    expect(cases.length).toBeGreaterThanOrEqual(7);
    for (const name of cases) {
      const html = readFileSync(join(root, name, "page.html"), "utf8");
      const { url } = JSON.parse(readFileSync(join(root, name, "expect.json"), "utf8")) as { url: string };
      const viaWorker = await pool.run("extractReadable", { html, url });
      const inProcess = await runHtmlTaskInProcess("extractReadable", { html, url });
      expect(viaWorker, name).toEqual(inProcess);
    }
  }, 60_000);
});

describe("extractReadableContent via the shared pool", () => {
  it("a page that cannot be parsed in budget yields parseAborted=too_complex instead of throwing or blocking", async () => {
    process.env.FEEDFERRET_HTML_WORKER_INLINE = "0";
    process.env.FEEDFERRET_HTML_WORKER_TIMEOUT_MS = "400";
    resetHtmlWorkerPool();
    // Within the guard's limits but still seconds of extractor work (4 000 paragraphs 120 levels deep).
    const heavy = `<html><body>${"<div>".repeat(120)}${"<p>x</p>".repeat(4_000)}</body></html>`;
    const { result, maxGapMs } = await whileTicking(() => extractReadableContent(heavy, "https://heavy.example/a"));
    expect(result.status).toBe("fulfilled");
    const value = (result as PromiseFulfilledResult<Awaited<ReturnType<typeof extractReadableContent>>>).value;
    expect(value.parseAborted).toBe("too_complex");
    expect(value.html).toBeNull();
    expect(maxGapMs).toBeLessThan(250);
  }, 30_000);

  it("runHtmlTask uses the bundled worker by default", async () => {
    process.env.FEEDFERRET_HTML_WORKER_INLINE = "0";
    resetHtmlWorkerPool();
    const out = await runHtmlTask("sanitizeFeedItems", { items: ["<b>hi</b><script>x</script>"] });
    expect(out).toEqual([{ excerpt: "hi", html: "<b>hi</b>" }]);
  }, 30_000);
});

describe("runInHtmlWorker: user-configured scraper expressions are bounded too", () => {
  // A big but guard-passing page (20 000 flat elements).
  const page = `<html><body>${'<div class="item"><a href="/x">t</a></div>'.repeat(10_000)}</body></html>`;

  async function underBudget<T>(fn: () => Promise<T>) {
    process.env.FEEDFERRET_HTML_WORKER_INLINE = "0";
    process.env.FEEDFERRET_HTML_WORKER_TIMEOUT_MS = "500";
    resetHtmlWorkerPool();
    return whileTicking(fn);
  }

  it("a quadratic XPath (Scout / frss:xPath* config) on a large page times out in the worker; the loop keeps ticking", async () => {
    const { result, maxGapMs } = await underBudget(() =>
      runInHtmlWorker({
        task: "xpath",
        html: page,
        url: "https://evil.example/",
        contentType: "text/html",
        config: { xpath: { xPathItem: "//div[count(//div[a]) > count(preceding::div)]", xPathItemUri: ".//a/@href" } },
      }),
    );
    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toMatchObject({ name: "HtmlWorkerError", reason: "timeout" });
    expect(maxGapMs).toBeLessThan(250);
  }, 30_000);

  it("a pathological CSS selector (fullTextSelector / frss:cssFullContent) times out in the worker; the loop keeps ticking", async () => {
    const { result, maxGapMs } = await underBudget(() =>
      runInHtmlWorker({
        task: "css",
        html: page,
        url: "https://evil.example/",
        selector: "div:not(:has(~ div ~ div ~ div a)) a",
        mode: "sync",
      }),
    );
    // Whatever nwsapi makes of it: never blocks the main thread past the worker budget.
    if (result.status === "rejected") expect((result as PromiseRejectedResult).reason).toMatchObject({ name: "HtmlWorkerError" });
    expect(maxGapMs).toBeLessThan(250);
  }, 30_000);

  it("remove-selectors (cssContentFilter) keep `:is(a, b)` lists intact, ignore an invalid list, and run on guarded input", async () => {
    process.env.FEEDFERRET_HTML_WORKER_INLINE = "0";
    resetHtmlWorkerPool();
    const items = ['<p>keep</p><div class="ad">x</div><aside>y</aside>', "<p>untouched</p>"];
    await expect(runInHtmlWorker({ task: "removeSelectors", items, selectors: ".ad, :is(aside, .promo)" })).resolves.toEqual([
      "<p>keep</p>",
      "<p>untouched</p>",
    ]);
    await expect(runInHtmlWorker({ task: "removeSelectors", items, selectors: "div[[" })).resolves.toEqual(items);
    const deep = await runInHtmlWorker({ task: "removeSelectors", items: ["<div>".repeat(5_000) + "x"], selectors: "span" });
    expect(deep[0].length).toBeLessThan(5_000 * 5); // cut by the guard before jsdom
  }, 30_000);
});

describe("priority lanes (interactive vs background)", () => {
  it("an interactive task runs at once on the reserved worker while background work saturates the rest", async () => {
    const pool = makePool({ size: 2, timeoutMs: 10_000 });
    await Promise.all([pool.run("warm", null), pool.run("warm", null)]);
    const background = Array.from({ length: 4 }, () => pool.run("__testBusyLoop", { ms: 600 }, { priority: "background" }));
    await new Promise((r) => setTimeout(r, 50));
    const started = performance.now();
    await pool.run("__testBusyLoop", { ms: 50 }, { priority: "interactive" });
    // Not behind 4 × 600 ms of background work (one worker is reserved).
    expect(performance.now() - started).toBeLessThan(400);
    await Promise.allSettled(background);
  }, 30_000);

  it("background work never occupies the reserved worker, even when it is idle", async () => {
    const pool = makePool({ size: 2, timeoutMs: 10_000 });
    const runs = Array.from({ length: 3 }, () => pool.run("__testBusyLoop", { ms: 300 }, { priority: "background" }));
    await new Promise((r) => setTimeout(r, 100));
    expect(pool.liveWorkers).toBe(1);
    await Promise.all(runs);
  }, 30_000);

  it("with a single worker, queued interactive tasks overtake queued background tasks", async () => {
    const pool = makePool({ size: 1, timeoutMs: 10_000 });
    const order: string[] = [];
    const running = pool.run("__testBusyLoop", { ms: 300 }, { priority: "background" }).then(() => order.push("bg-running"));
    const bg = pool.run("__testBusyLoop", { ms: 10 }, { priority: "background" }).then(() => order.push("bg-queued"));
    const ia = pool.run("__testBusyLoop", { ms: 10 }, { priority: "interactive" }).then(() => order.push("interactive"));
    await Promise.all([running, bg, ia]);
    expect(order).toEqual(["bg-running", "interactive", "bg-queued"]);
  }, 30_000);

  it("a background task that waits past its queue deadline is deferred (busy), interactive tasks never are", async () => {
    const pool = makePool({ size: 2, timeoutMs: 10_000, backgroundQueueWaitMs: 200 });
    const running = pool.run("__testBusyLoop", { ms: 800 }, { priority: "background" });
    const waiting = pool.run("__testBusyLoop", { ms: 10 }, { priority: "background" });
    await expect(waiting).rejects.toMatchObject({ name: "HtmlWorkerError", reason: "busy" });
    expect(pool.stats.backgroundExpired).toBe(1);
    await expect(running).resolves.toBeGreaterThan(0);
  }, 30_000);

  for (const size of [1, 2]) {
    it(`aging: under sustained interactive load a background task still runs (size ${size}), well before its deadline`, async () => {
      const pool = makePool({ size, timeoutMs: 10_000, backgroundAgingMs: 300, backgroundQueueWaitMs: 5_000 });
      await Promise.all(Array.from({ length: size }, () => pool.run("warm", null)));
      // Keep every worker busy with interactive work for ~3 s, with more always queued.
      const until = performance.now() + 3_000;
      const flood = async () => {
        while (performance.now() < until) await pool.run("__testBusyLoop", { ms: 80 }, { priority: "interactive" });
      };
      const floods = Array.from({ length: size + 2 }, () => flood());
      await new Promise((r) => setTimeout(r, 50));
      const queuedAt = performance.now();
      await pool.run("__testBusyLoop", { ms: 10 }, { priority: "background" });
      const waited = performance.now() - queuedAt;
      expect(performance.now()).toBeLessThan(until); // it ran while the flood was still going
      expect(waited).toBeLessThan(1_500); // ≈ aging (300 ms) + one interactive task
      expect(pool.stats.backgroundAged).toBeGreaterThanOrEqual(1);
      expect(pool.stats.backgroundExpired).toBe(0);
      await Promise.all(floods);
    }, 30_000);
  }

  it("runAsBackgroundHtmlWork marks every task started inside it (however deep) as background", async () => {
    expect(currentHtmlTaskPriority()).toBe("interactive");
    const seen = await runAsBackgroundHtmlWork(async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentHtmlTaskPriority();
    });
    expect(seen).toBe("background");
    expect(currentHtmlTaskPriority()).toBe("interactive");
  });
});

describe("fail closed", () => {
  afterEach(() => {
    delete process.env.FEEDFERRET_HTML_WORKER_PATH;
    (process.env as Record<string, string>).NODE_ENV = "test";
  });

  it("a missing worker bundle rejects with `unavailable` (never parses in-process) and reports it as the health status", async () => {
    process.env.FEEDFERRET_HTML_WORKER_INLINE = "0";
    process.env.FEEDFERRET_HTML_WORKER_PATH = join(tmpdir(), "ff-missing-worker", "worker.mjs");
    resetHtmlWorkerPool();
    await expect(runHtmlTask("sanitizeFeedItems", { items: ["<b>x</b>"] })).rejects.toMatchObject({ name: "HtmlWorkerError", reason: "unavailable" });
    expect(htmlWorkerStatus()).toBe("unavailable");
    expect(await warmHtmlWorker()).toBe("unavailable");
    // Full text keeps the feed content: an empty result with a reason, no throw.
    const result = await extractReadableContent("<article><p>x</p></article>", "https://a.example/");
    expect(result).toMatchObject({ html: null, parseAborted: "unavailable" });
  });

  it("a worker that dies while loading its bundle is `unavailable`, not a too-complex page", async () => {
    process.env.FEEDFERRET_HTML_WORKER_INLINE = "0";
    const dir = mkdtempSync(join(tmpdir(), "ff-broken-worker-"));
    try {
      writeFileSync(join(dir, "worker.mjs"), 'throw new Error("cannot find module jsdom");\n');
      const pool = makePool({ workerPath: join(dir, "worker.mjs") });
      await expect(pool.run("warm", null)).rejects.toMatchObject({ name: "HtmlWorkerError", reason: "unavailable" });
      expect(htmlWorkerStatus()).toBe("unavailable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pool and status are per process, not per module copy (Next bundles instrumentation and routes separately)", async () => {
    process.env.FEEDFERRET_HTML_WORKER_INLINE = "0";
    process.env.FEEDFERRET_HTML_WORKER_PATH = join(tmpdir(), "ff-missing-worker", "worker.mjs");
    resetHtmlWorkerPool();
    expect(await warmHtmlWorker()).toBe("unavailable");
    vi.resetModules();
    const copy = await import("@/lib/html-worker/pool");
    expect(copy.htmlWorkerStatus()).toBe("unavailable");
    const seen = await runAsBackgroundHtmlWork(async () => copy.currentHtmlTaskPriority());
    expect(seen).toBe("background");
  });

  it("the test-only inline flag is refused in production", async () => {
    process.env.FEEDFERRET_HTML_WORKER_INLINE = "1";
    (process.env as Record<string, string>).NODE_ENV = "production";
    process.env.FEEDFERRET_HTML_WORKER_PATH = join(tmpdir(), "ff-missing-worker", "worker.mjs");
    resetHtmlWorkerPool();
    await expect(runHtmlTask("sanitizeFeedItems", { items: ["<b>x</b>"] })).rejects.toMatchObject({ reason: "unavailable" });
  });
});
