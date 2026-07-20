import { describe, it, expect } from "vitest";
import { renderMarkdownToHtml } from "../../lib/markdown-render";

describe("renderMarkdownToHtml — GFM polish (tables/code/task-lists/math/images)", () => {
  it("renders a GFM table", async () => {
    const html = await renderMarkdownToHtml("| a | b |\n| --- | --- |\n| 1 | 2 |\n");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });

  it("syntax-highlights fenced code blocks with a known language", async () => {
    const html = await renderMarkdownToHtml("```js\nconst x = 1;\n```\n");
    expect(html).toContain('class="hljs"');
    // highlight.js wraps recognized tokens (keywords, etc.) in hljs-* spans.
    expect(html).toMatch(/class="hljs-\w+"/);
  });

  it("falls back to escaped, unhighlighted code for an unknown language", async () => {
    const html = await renderMarkdownToHtml("```notarealanguage\n<script>evil</script>\n```\n");
    expect(html).toContain('class="hljs"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>evil</script>");
  });

  it("renders GFM task-list checkboxes instead of literal [x]/[ ] text", async () => {
    const html = await renderMarkdownToHtml("- [x] done\n- [ ] todo\n");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
    expect(html).not.toContain("[x] done");
  });

  it("renders inline images with lazy loading", async () => {
    const html = await renderMarkdownToHtml("![a cat](https://example.com/cat.png)\n");
    expect(html).toContain('src="https://example.com/cat.png"');
    expect(html).toContain('alt="a cat"');
    expect(html).toContain('loading="lazy"');
  });

  it("renders KaTeX math with its layout-critical inline widths intact", async () => {
    // A matrix specifically emits a literal `width:` (not e.g. border-width)
    // on its column elements.
    const html = await renderMarkdownToHtml("$$\\begin{matrix}1&2\\\\3&4\\end{matrix}$$\n");
    expect(html).toContain('class="katex'); // katex / katex-display
    // KaTeX depends on inline width for math-symbol spacing/alignment — the
    // sanitizer's normal width-strip (for untrusted scraped-page styles)
    // must exempt this or math renders as a jumbled mess.
    expect(html).toMatch(/style="[^"]*\bwidth:/);
  });

  it("still strips width from non-KaTeX inline styles (regression guard)", async () => {
    // Markdown itself can't carry raw HTML (html:false), but guard the
    // sanitizer behavior directly for anything that reaches it outside a
    // .katex subtree — e.g. a future plugin emitting its own inline styles.
    const { getSanitizer } = await import("../../lib/sanitize-html");
    const DOMPurify = await getSanitizer();
    const clean = DOMPurify.sanitize('<div style="width: 1200px; color: red;">x</div>');
    expect(clean).not.toContain("width");
    expect(clean).not.toContain("color");
  });
});
