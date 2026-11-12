import { describe, expect, it } from "vitest";
import { sanitizeFeedItemsInProcess } from "@/lib/feed-item-sanitize";
import { rewriteMediaInProcess } from "@/lib/media-rewrite-core";

const run = async (html: string, o: { embedLinks?: boolean; removeSelectors?: string } = { embedLinks: true }) =>
  (await sanitizeFeedItemsInProcess({ items: [html], ...o }))[0];

describe("sanitizeFeedItemsInProcess embedLinks", () => {
  it.each([
    ["youtube embed", "https://www.youtube.com/embed/abc_123-X", "https://www.youtube.com/watch?v=abc_123-X"],
    ["youtube-nocookie embed", "https://www.youtube-nocookie.com/embed/abc123?rel=0", "https://www.youtube.com/watch?v=abc123"],
    ["protocol-relative source", "//www.youtube.com/embed/abc123", "https://www.youtube.com/watch?v=abc123"],
    ["http source", "http://www.youtube.com/embed/abc123", "https://www.youtube.com/watch?v=abc123"],
    ["vimeo player", "https://player.vimeo.com/video/123456?h=abc&dnt=1", "https://vimeo.com/123456"],
    ["dailymotion embed", "https://www.dailymotion.com/embed/video/x8abc", "https://www.dailymotion.com/video/x8abc"],
  ])("%s becomes a plain link to the canonical watch page", async (_name, src, watch) => {
    const out = await run(`<p>before</p><iframe src="${src}" width="560" height="315" allowfullscreen></iframe><p>after</p>`);
    expect(out.html).toBe(`<p>before</p><a href="${watch}">${watch}</a><p>after</p>`);
    expect(out.html).not.toMatch(/iframe/i);
    // The stable pre-feature form: exactly what the default profile produced (iframe stripped).
    expect(out.legacyHtml).toBe("<p>before</p><p>after</p>");
  });

  it("strips every iframe that is not a known provider, as before", async () => {
    for (const src of [
      "https://evil.example/embed/abc",
      "https://youtube.com.evil.example/embed/abc",
      "https://www.youtube.com/embed/videoseries?list=PL1",
      "https://peer.example/videos/embed/abc",
      "https://player.twitch.tv/?video=123",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "/relative/embed/abc",
      "",
    ]) {
      const out = await run(`<p>x</p><iframe src="${src}">fallback</iframe>`);
      expect(out.html, src).toBe("<p>x</p>");
      expect(out.legacyHtml, src).toBeUndefined();
    }
    expect((await run('<p>x</p><iframe srcdoc="<script>1</script>"></iframe>')).html).toBe("<p>x</p>");
  });

  it("converts the known ones and strips the others in the same item", async () => {
    const out = await run('<iframe src="https://evil.example/a"></iframe><iframe src="https://player.vimeo.com/video/42"></iframe>');
    expect(out.html).toBe('<a href="https://vimeo.com/42">https://vimeo.com/42</a>');
  });

  it("never copies anything from the iframe but the matched id (attributes, fallback content, injected markup)", async () => {
    const out = await run('<iframe src="https://www.youtube.com/embed/abc123" onload="alert(1)" style="position:fixed" srcdoc="<b>x</b>" title="&quot;><img src=x onerror=alert(1)>">&lt;script&gt;</iframe>');
    expect(out.html).toBe('<a href="https://www.youtube.com/watch?v=abc123">https://www.youtube.com/watch?v=abc123</a>');
  });

  it("is off by default and in every other caller's profile", async () => {
    const html = '<p>a</p><iframe src="https://www.youtube.com/embed/abc123"></iframe>';
    const out = await run(html, {});
    expect(out).toEqual({ excerpt: "a", html: "<p>a</p>" });
  });

  it("leaves items without a (convertible) iframe byte-identical to the default profile", async () => {
    for (const html of [
      "<p>plain <b>text</b> &amp; <a href=\"https://x.example/a?b=1&amp;c=2\">link</a></p>",
      '<p onclick="x()">a</p><img src="https://x.example/i.png"><script>1</script><style>p{}</style>',
      "<ul><li>a<li>b</ul><table><tr><td>x</table>",
      "<p>unclosed <i>markup",
      "",
    ]) {
      const on = await run(html);
      const off = await run(html, {});
      expect(on, html).toEqual(off);
      expect(on.legacyHtml).toBeUndefined();
    }
  });

  it("keeps the excerpt exactly as before (no link text from the embed)", async () => {
    const html = '<p>Intro text</p><iframe src="https://www.youtube.com/embed/abc123"></iframe>';
    expect((await run(html)).excerpt).toBe((await run(html, {})).excerpt);
    expect((await run(html)).excerpt).toBe("Intro text");
  });

  it("applies remove-selectors first, so a removed container takes its embed with it", async () => {
    const out = await run('<p>keep</p><div class="ad"><iframe src="https://www.youtube.com/embed/abc123"></iframe></div>', { embedLinks: true, removeSelectors: ".ad" });
    expect(out.html).toBe("<p>keep</p>");
    expect(out.legacyHtml).toBeUndefined();
  });

  it("is deterministic: the same item sanitizes to the same bytes (what the unchanged-item comparison relies on)", async () => {
    const html = '<p>a</p><iframe src="//www.youtube.com/embed/abc123"></iframe>';
    expect(await run(html)).toEqual(await run(html));
  });

  it("the stored link is what the render-time inliner (#299) turns into a click-to-load placeholder", () => {
    const stored = '<p>a</p><a href="https://www.youtube.com/watch?v=abc123">https://www.youtube.com/watch?v=abc123</a>';
    const html = rewriteMediaInProcess({ html: stored, base: "https://news.example/post", keyHex: "" });
    expect(html).toContain("ff-video-placeholder");
    expect(html).toContain('data-ff-video="https://www.youtube.com/watch?v=abc123"');
    expect(html).not.toMatch(/<iframe/i);
  });
});
