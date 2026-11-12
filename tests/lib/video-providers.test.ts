import { describe, expect, it } from "vitest";
import { alternativeUrl, validateInstance, videoFor, watchUrlForEmbed } from "@/lib/video-providers";
import { runHtmlTaskInProcess } from "@/lib/html-worker/tasks";
describe("declarative providers", () => {
  it.each([
    ["https://youtu.be/abc123", "YouTube"], ["https://www.youtube.com/shorts/abc123", "YouTube"],
    ["https://youtube.com/watch?v=abc123", "YouTube"], ["https://vimeo.com/12345", "Vimeo"],
    ["https://www.dailymotion.com/video/x123", "Dailymotion"],
    ["https://www.twitch.tv/videos/1234", "Twitch"], ["https://clips.twitch.tv/ClipId", "Twitch"],
    ["https://www.twitch.tv/channel/clip/ClipId", "Twitch"],
    ["https://video.example/videos/watch/abc-123", "PeerTube"], ["https://v.redd.it/abc", "Reddit video"],
  ])("recognizes %s", (url, name) => expect(videoFor(url)?.provider).toBe(name));
  it.each(["javascript:alert(1)", "https://youtube.com.evil.example/watch?v=abc", "https://user:pass@youtube.com/watch?v=a", "https://youtube.com:444/watch?v=a"])("rejects %s", url => expect(videoFor(url)).toBeUndefined());
  it("rewrites frontends without selecting a default", () => {
    const url = "https://youtu.be/abc";
    expect(alternativeUrl(url, {})).toBe(url);
    expect(alternativeUrl(url, { mediaYoutubeInstance: "https://video.example" })).toBe("https://video.example/watch?v=abc");
    expect(alternativeUrl("https://www.reddit.com/r/test?a=b", { mediaRedditFrontend: "old" })).toBe("https://old.reddit.com/r/test?a=b");
    expect(alternativeUrl("https://x.com/test/status/1", { mediaTwitterInstance: "https://social.example" })).toBe("https://social.example/test/status/1");
  });
  it.each(["http://video.example", "https://user@video.example", "https://video.example/path", "https://video.example?q=x", "https://127.0.0.1", "https://localhost", null])("rejects invalid settings %s", value => expect(() => validateInstance(value)).toThrow());
});
describe("watchUrlForEmbed (ingest: iframe src → canonical watch page)", () => {
  it.each([
    ["https://www.youtube.com/embed/abcdefghijk", "YouTube", "https://www.youtube.com/watch?v=abcdefghijk"],
    ["https://www.youtube-nocookie.com/embed/abc_123-XYZ?start=4", "YouTube", "https://www.youtube.com/watch?v=abc_123-XYZ"],
    ["//www.youtube.com/embed/abcdefghijk", "YouTube", "https://www.youtube.com/watch?v=abcdefghijk"],
    ["http://youtube.com/embed/abcdefghijk", "YouTube", "https://www.youtube.com/watch?v=abcdefghijk"],
    ["https://player.vimeo.com/video/99", "Vimeo", "https://vimeo.com/99"],
    ["https://www.dailymotion.com/embed/video/x1", "Dailymotion", "https://www.dailymotion.com/video/x1"],
    ["https://www.twitch.tv/videos/1234", "Twitch", "https://www.twitch.tv/videos/1234"],
    ["https://clips.twitch.tv/ClipId", "Twitch", "https://clips.twitch.tv/ClipId"],
    ["https://clips.twitch.tv/embed?clip=ClipId&parent=news.example", "Twitch", "https://clips.twitch.tv/ClipId"],
    ["https://player.twitch.tv/?video=v1234&parent=news.example", "Twitch", "https://www.twitch.tv/videos/1234"],
    ["https://player.twitch.tv/?video=1234", "Twitch", "https://www.twitch.tv/videos/1234"],
    ["https://v.redd.it/abc", "Reddit video", "https://v.redd.it/abc"],
  ])("%s", (src, provider, url) => expect(watchUrlForEmbed(src)).toEqual({ provider, url }));
  it.each([
    "https://video.example/videos/watch/abc-123", // PeerTube: any origin, no canonical page we can vouch for
    "https://www.youtube.com/embed/videoseries?list=PL1", "https://www.youtube.com/embed/",
    "https://www.youtube.com/embed/live_stream?channel=UC1", "https://www.youtube.com/embed/abc", "https://www.youtube.com/embed/abcdefghijkl",
    "https://clips.twitch.tv/embed", "https://clips.twitch.tv/embed?clip=a/b", "https://player.twitch.tv/?channel=somechannel", "https://player.twitch.tv/?video=abc", "https://player.twitch.tv/",
    "https://youtube.com.evil.example/embed/abc", "https://user:pw@www.youtube.com/embed/abc", "https://www.youtube.com:8443/embed/abc",
    "ftp://www.youtube.com/embed/abc", "javascript:alert(1)", "/embed/abc", "not a url", "",
  ])("rejects %s", (src) => expect(watchUrlForEmbed(src)).toBeUndefined());
});
describe("sanitized presentation pipeline", () => {
  const render = (html: string, keyHex = "", base = "https://news.example/article", frontends = {}) => runHtmlTaskInProcess("rewriteMedia", { html, keyHex, base, frontends });
  it("has no active player or thumbnail before consent without proxy", async () => {
    const html = await render('<iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe><a href="https://vimeo.com/123">video</a>');
    expect(html).not.toMatch(/<(?:iframe|img|video)/);
    expect(html).toContain('data-ff-video="https://www.youtube.com/embed/abcdefghijk"');
    expect(html).toContain("Load video");
  });
  it("only shows signed thumbnails and handles link-only articles", async () => {
    const html = await render("", "01".repeat(32), "https://youtu.be/abc");
    expect(html).toContain('src="/api/media?');
    expect(html).toContain('data-ff-video=');
  });
  it("uses external links for custom origins and PeerTube", async () => {
    const html = await render('<a href="https://youtu.be/abc">video</a>', "", undefined, { mediaYoutubeInstance: "https://video.example" });
    expect(html).toContain('href="https://video.example/watch?v=abc"');
    expect(html).not.toContain("data-ff-video");
    expect(await render("", "", "https://peer.example/videos/watch/abc")).toContain('target="_blank"');
  });
  it("turns alternative Reddit and Twitter embeds into inert navigation links", async () => {
    const html = await render('<iframe src="https://platform.twitter.com/embed/Tweet.html?id=123"></iframe><iframe src="https://www.redditmedia.com/r/test/comments/abc"></iframe>', "", undefined, { mediaTwitterInstance: "https://social.example", mediaRedditFrontend: "https://forum.example" });
    expect(html).toContain('href="https://social.example/i/status/123"');
    expect(html).toContain('href="https://forum.example/r/test/comments/abc"');
    expect(html).not.toContain("<iframe");
  });
  it("inlines gallery images exposed by Reddit RSS", async () => {
    const html = await render('<a href="https://preview.redd.it/a.jpg?width=1080">image</a><a href="https://i.redd.it/b.jpg">image</a><a href="https://v.redd.it/abc">video</a>', "01".repeat(32), "https://reddit.com/r/test/comments/abc");
    expect(html.match(/<img/g)).toHaveLength(2);
    expect(html).toContain("/api/media?");
    expect(html).toContain('data-ff-video="https://v.redd.it/abc"');
  });
  it.each([
    '<button data-ff-video="https://evil.example">fake</button><script>alert(1)</script>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
    '<svg><foreignObject><iframe src="https://evil.example"></iframe></foreignObject></svg>',
  ])("removes forged controls and mXSS: %s", async payload => {
    const html = await render(payload);
    expect(html).not.toMatch(/data-ff-video|<script|onerror|<iframe/);
  });
});

it("keeps all renderer KaTeX metrics while applying media transforms", async () => {
  const html = await runHtmlTaskInProcess("renderMarkdown", String.raw`$\frac{a}{b}$ ![Image](https://images.example/picture.png) [Video](https://youtu.be/abc)`);
  const metrics = html.match(/style="[^"]*"/g)!;
  expect(metrics.length).toBeGreaterThan(1);
  const rewritten = await runHtmlTaskInProcess("rewriteMedia", { html, base: "https://news.example/article", keyHex: "01".repeat(32), trustedRendererHtml: true });
  expect(rewritten.match(/style="[^"]*"/g)).toEqual(metrics);
  expect(rewritten).toContain('src="/api/media?');
  expect(rewritten).toContain("data-ff-video");
});
it("does not elevate publisher KaTeX classes to renderer trust", async () => {
  const html = await runHtmlTaskInProcess("rewriteMedia", { html: '<span class="katex"><span style="width:50px;position:relative;top:20px">fake</span></span>', base: "https://news.example", keyHex: "" });
  expect(html).not.toMatch(/width:|position:|top:/);
});
it("does not turn Reddit gallery links into hotlinks when the proxy is off", async () => {
  const html = await runHtmlTaskInProcess("rewriteMedia", { html: '<a href="https://preview.redd.it/a.jpg">preview</a><a href="https://i.redd.it/b.jpg">image</a>', base: "https://reddit.com/r/test/comments/abc", keyHex: "" });
  expect(html).not.toContain("<img");
  expect(html).toContain('href="https://preview.redd.it/a.jpg"');
  expect(html).toContain('href="https://i.redd.it/b.jpg"');
});
it("only exempts generated thumbnails from signing, never publisher proxy-looking paths", async () => {
  const html = await runHtmlTaskInProcess("rewriteMedia", { html: '<img src="/api/media?u=publisher"><a href="https://youtu.be/abc">video</a>', base: "https://news.example/article", keyHex: "01".repeat(32) });
  expect(html).toContain("u=https%3A%2F%2Fnews.example%2Fapi%2Fmedia%3Fu%3Dpublisher");
  expect(html).toContain("u=https%3A%2F%2Fi.ytimg.com");
  expect(html).not.toContain("u=https%3A%2F%2Fnews.example%2Fapi%2Fmedia%3Fu%3Dhttps");
});
