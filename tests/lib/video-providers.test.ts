import { describe, expect, it } from "vitest";
import { alternativeUrl, validateInstance, videoFor } from "@/lib/video-providers";
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
    for (const kind of ["invidious", "piped"]) expect(alternativeUrl(url, { mediaYoutubeFrontend: kind, mediaYoutubeInstance: "https://video.example" })).toBe("https://video.example/watch?v=abc");
    expect(alternativeUrl("https://www.reddit.com/r/test?a=b", { mediaRedditFrontend: "old" })).toBe("https://old.reddit.com/r/test?a=b");
    expect(alternativeUrl("https://x.com/test/status/1", { mediaTwitterInstance: "https://social.example" })).toBe("https://social.example/test/status/1");
  });
  it.each(["http://video.example", "https://user@video.example", "https://video.example/path", "https://video.example?q=x", "https://127.0.0.1", "https://localhost", null])("rejects invalid settings %s", value => expect(() => validateInstance(value)).toThrow());
});
describe("sanitized presentation pipeline", () => {
  const render = (html: string, keyHex = "", base = "https://news.example/article", frontends = {}) => runHtmlTaskInProcess("rewriteMedia", { html, keyHex, base, frontends });
  it("has no active player or thumbnail before consent without proxy", async () => {
    const html = await render('<iframe src="https://www.youtube.com/embed/abc"></iframe><a href="https://vimeo.com/123">video</a>');
    expect(html).not.toMatch(/<(?:iframe|img|video)/);
    expect(html).toContain('data-ff-video="https://www.youtube.com/embed/abc"');
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
