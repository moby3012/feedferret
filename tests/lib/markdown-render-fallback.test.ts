// Markdown display rendering runs in the HTML worker pool; a busy / missing /
// overloaded pool must never fail an article read or an API page (#281 review).
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetHtmlWorkerPool, runHtmlTask } from "@/lib/html-worker/pool";
import {
  mapRendered,
  markdownPlainTextFallback,
  renderMarkdownForDisplay,
  renderMarkdownToHtml,
  renderMarkdownToHtmlStrict,
  resetMarkdownRenderCache,
} from "@/lib/markdown-render";
import { renderArticleBody } from "@/server/articles/detail";

function workerMissing() {
  process.env.FEEDFERRET_HTML_WORKER_INLINE = "0";
  process.env.FEEDFERRET_HTML_WORKER_PATH = join(tmpdir(), "ff-no-worker", "worker.mjs");
  resetHtmlWorkerPool();
}

beforeEach(() => resetMarkdownRenderCache());
afterEach(() => {
  process.env.FEEDFERRET_HTML_WORKER_INLINE = "1";
  delete process.env.FEEDFERRET_HTML_WORKER_PATH;
  resetHtmlWorkerPool();
});

describe("markdown rendering resilience", () => {
  const md = "# Title\n\nSome *text* <script>alert(1)</script>\nsecond line\n\n- item";

  it("renders normally when the pool works", async () => {
    const out = await renderMarkdownForDisplay(md);
    expect(out.fallback).toBeNull();
    expect(out.html).toContain("<h1>Title</h1>");
    expect(out.html).not.toContain("<script");
  });

  it("falls back to escaped plain text with a reason when the worker is unavailable, never throws", async () => {
    workerMissing();
    const out = await renderMarkdownForDisplay(md);
    expect(out.fallback).toBe("unavailable");
    expect(out.html).toBe(markdownPlainTextFallback(md));
    expect(out.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;<br>second line");
    expect(out.html).not.toMatch(/<(?!\/?p>|br>)/); // only our own <p>/<br>
    await expect(renderMarkdownToHtml(md)).resolves.toBe(out.html);
    // Stored content (hosted / AI tiers) must not become degraded text.
    await expect(renderMarkdownToHtmlStrict(md)).rejects.toMatchObject({ name: "HtmlWorkerError", reason: "unavailable" });
  });

  it("memoizes rendered HTML: a later read is served from the cache even if the pool is gone", async () => {
    const first = await renderMarkdownForDisplay(md);
    workerMissing();
    const second = await renderMarkdownForDisplay(md);
    expect(second).toEqual(first);
    expect(second.fallback).toBeNull();
  });

  it("a batch of article reads (API page / reader) never fails for one unrenderable article", async () => {
    workerMissing();
    const bodies = await Promise.all([
      renderArticleBody("<p>stored html</p>", "html"),
      renderArticleBody("**md**", "markdown"),
      renderArticleBody(null, "markdown"),
    ]);
    expect(bodies).toEqual([
      { html: "<p>stored html</p>", fallback: false },
      { html: "<p>**md**</p>", fallback: true },
      { html: "", fallback: false },
    ]);
  });

  describe("cold-cache bursts against the real worker pool", () => {
    function smallPool(queue: number) {
      process.env.FEEDFERRET_HTML_WORKER_INLINE = "0";
      process.env.FEEDFERRET_HTML_WORKER_POOL_SIZE = "1";
      process.env.FEEDFERRET_HTML_WORKER_QUEUE = String(queue);
      resetHtmlWorkerPool();
    }
    afterEach(() => {
      delete process.env.FEEDFERRET_HTML_WORKER_POOL_SIZE;
      delete process.env.FEEDFERRET_HTML_WORKER_QUEUE;
    });

    it("a 250-item API page renders every article for real (bounded concurrency), even with a tiny queue", async () => {
      smallPool(8);
      const docs = Array.from({ length: 250 }, (_, i) => `# Post ${i}\n\nBody *${i}* with [link](https://x.example/${i}).`);
      const out = await mapRendered(docs, (md) => renderMarkdownForDisplay(md));
      expect(out.filter((r) => r.fallback !== null)).toEqual([]);
      expect(out[249].html).toContain("<h1>Post 249</h1>");
    }, 60_000);

    it("unbounded Promise.all over the same page would overflow the queue (why mapRendered exists)", async () => {
      smallPool(8);
      const docs = Array.from({ length: 250 }, (_, i) => `# Other ${i}\n\ntext ${i}`);
      const out = await Promise.all(docs.map((md) => renderMarkdownForDisplay(md)));
      expect(out.some((r) => r.fallback === "busy")).toBe(true);
    }, 60_000);

    it("identical markdown rendering concurrently shares one in-flight render", async () => {
      smallPool(1);
      const results = await Promise.all(Array.from({ length: 50 }, () => renderMarkdownForDisplay("# Same\n\nshared body")));
      // 50 separate tasks could never fit a queue of 1: every one got the real rendering.
      expect(results.every((r) => r.fallback === null && r.html.includes("<h1>Same</h1>"))).toBe(true);
    }, 60_000);

    it("a momentarily busy pool is waited for and retried once before falling back", async () => {
      smallPool(1);
      await runHtmlTask("warm", null); // worker booted: the busy window below is the tasks only
      const running = runHtmlTask("__testBusyLoop", { ms: 120 }).catch(() => 0);
      await new Promise((r) => setTimeout(r, 20));
      const queued = runHtmlTask("__testBusyLoop", { ms: 60 }).catch(() => 0);
      // Queue (1) is full right now: the first attempt is `busy`, the retry 250 ms later succeeds.
      const rendered = await renderMarkdownForDisplay("# Retry\n\nafter busy");
      expect(rendered.fallback).toBeNull();
      expect(rendered.html).toContain("<h1>Retry</h1>");
      await Promise.all([running, queued]);
    }, 60_000);
  });
});
