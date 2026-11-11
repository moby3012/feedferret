// Markdown display rendering runs in the HTML worker pool; a busy / missing /
// overloaded pool must never fail an article read or an API page (#281 review).
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetHtmlWorkerPool } from "@/lib/html-worker/pool";
import {
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
});
