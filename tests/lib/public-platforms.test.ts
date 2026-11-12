import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { runInHtmlWorker } from "../../lib/html-worker";
import { telegramChannel } from "../../lib/feed-adapters/telegram";
import { blueskyRssActor, enrichBlueskyArticles } from "../../lib/feed-adapters/bluesky";
import type { FetchedFeed } from "../../lib/feed-item-fields";
const mocks = vi.hoisted(() => ({ safeFetch: vi.fn(), rss: vi.fn(), rsshub: false }));
vi.mock("../../lib/ssrf", async (original) => ({ ...await original<typeof import("../../lib/ssrf")>(), safeFetch: mocks.safeFetch, isTrustedFeedFetchingAllowed: async () => false, fetchTextWithSsrfProtection: async () => (await mocks.rss()).text, fetchWithSsrfProtection: mocks.rss }));
vi.mock("../../lib/connector-secrets", () => ({ getConnectorSecretRules: async () => [], stripConnectorSecretsWith: (_rules: unknown, url: string) => url, resolveConnectorRequestWith: (_rules: unknown, url: string) => ({ url, trusted: false }) }));
vi.mock("../../lib/rsshub", () => ({
  radarRoutesFor: () => [{ route: "/telegram/channel/example_channel", title: "Channel" }],
  getRsshubConfig: async () => mocks.rsshub ? { url: "https://rsshub.example" } : null,
  buildRsshubPublicRouteUrl: (config: { url: string }, route: string) => config.url + route,
  validateRsshubRoute: async () => ({ ok: true, title: "Channel" }),
}));
const fixture = (name: string) => readFileSync(new URL(`../fixtures/public-platforms/${name}`, import.meta.url), "utf8");
import { fetchFeedArticles, isFediverseProfileFeed } from "../../lib/feed-fetcher";
import { discoverFeeds } from "../../lib/feed-discovery";
const articleFeed = (): FetchedFeed => ({ articles: [{ title: "Post", link: "https://bsky.app/profile/example.bsky.social/post/post123", guid: "keep-guid", content: "Original" }] });
beforeEach(() => { mocks.rsshub = false; vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe("public Telegram previews", () => {
  it.each(["https://t.me/example_channel", "https://t.me/s/example_channel", "https://telegram.me/example_channel", "https://t.me/example_channel/42"])("normalizes %s", (url) => expect(telegramChannel(url)).toBe("example_channel"));
  it.each(["https://t.me/+private", "https://t.me/joinchat/abcdef", "https://t.me/share/url", "https://t.me/c/123/456", "https://t.me/s", "https://t.me.evil.example/example_channel"])("rejects %s", (url) => expect(telegramChannel(url)).toBeNull());
  it("extracts stable IDs, dates, sanitized text, a gallery, video and forwarding note in the worker", async () => {
    const feed = await runInHtmlWorker({ task: "telegram", html: fixture("telegram.html"), channel: "example_channel", url: "https://t.me/s/example_channel" });
    expect(feed.articles).toHaveLength(2);
    const post = feed.articles[0];
    expect(post.guid).toBe("example_channel/42");
    expect(post.link).toBe("https://t.me/example_channel/42");
    expect(post.publishedAt).toEqual(new Date("2026-10-01T12:00:00Z"));
    expect(post.content).toContain("\u21AA Example newsroom");
    expect(post.content).not.toContain("Forwarded from");
    expect(post.title).toBe("Hello 😊 world");
    expect(post.content).toContain("😊");
    expect(post.content).not.toContain("class=\"emoji\"");
    expect(post.content).toContain("<b>world</b>");
    expect(post.content).not.toMatch(/script|onerror/);
    // the photo with a signed URL is dropped (it would rot), the plain photo and the
    // video poster stay; the signed video file itself is never stored
    expect(post.enclosures).toEqual([
      { href: "https://media.example/two.jpg", type: "image/jpeg" },
      { href: "https://media.example/poster.jpg", type: "image/jpeg" },
    ]);
    expect(post.content).toContain("https://media.example/two.jpg");
    expect(post.content).toContain('href="https://t.me/example_channel/42"');
    expect(post.content + JSON.stringify(post)).not.toMatch(/movie\.mp4|token|expires/);
    expect(post.media).toBeNull();
    expect(feed.articles[1].publishedAt).toBeNull();
  });
  it("rotating signed media tokens do not change the parsed item", async () => {
    const parse = (html: string) => runInHtmlWorker({ task: "telegram", html, channel: "example_channel", url: "https://t.me/s/example_channel" });
    const first = await parse(fixture("telegram.html"));
    const second = await parse(fixture("telegram.html").replaceAll("VIDEO_TOKEN", "OTHER").replaceAll("PHOTO_TOKEN", "NEW").replace("expires=1", "expires=999"));
    expect(second).toEqual(first);
  });
  it("keeps HTML/XPath feeds on t.me pages on their own parser", async () => {
    mocks.safeFetch.mockClear();
    mocks.rss.mockResolvedValue({ text: "<html><body></body></html>", notModified: false, etag: null, lastModified: null, headers: new Headers() });
    await fetchFeedArticles({ url: "https://t.me/s/example_channel", sourceType: "HTML+XPath", scraperConfig: "{}" }).catch(() => undefined);
    expect(mocks.safeFetch).not.toHaveBeenCalled();
    expect(mocks.rss).toHaveBeenCalled();
  });
  it.each([429, 503])("treats HTTP %i as temporary, not as a missing channel", async (status) => {
    mocks.safeFetch.mockImplementation(async () => new Response("busy", { status }));
    const result = await discoverFeeds("https://t.me/example_channel");
    expect(result.feeds).toEqual([]);
    expect(result.hint).toBe("rate-limited");
    expect(result.error).toMatch(new RegExp(`Fetch failed: ${status}`));
  });
  it("discovers canonical native feeds without RSSHub and syncs the same preview", async () => {
    mocks.safeFetch.mockImplementation(async () => new Response(fixture("telegram.html")));
    const discovery = await discoverFeeds("https://telegram.me/example_channel");
    expect(discovery.feeds[0]).toMatchObject({ url: "https://t.me/s/example_channel", platform: "telegram" });
    const feed = await fetchFeedArticles({ url: discovery.feeds[0].url });
    expect(feed.articles[0].guid).toBe("example_channel/42");
    expect(mocks.safeFetch.mock.calls.every(([url]) => url === "https://t.me/s/example_channel")).toBe(true);
  });
  it("prefers native previews with RSSHub configured and falls back when the preview is unavailable", async () => {
    mocks.rsshub = true;
    mocks.safeFetch.mockImplementation(async () => new Response(fixture("telegram.html")));
    expect((await discoverFeeds("https://t.me/example_channel")).feeds[0].platform).toBe("telegram");
    mocks.safeFetch.mockImplementation(async () => new Response("Unavailable", { status: 404 }));
    expect((await discoverFeeds("https://telegram.me/example_channel")).feeds[0].platform).toBe("rsshub");
  });
  it("makes no network request when discovery's request budget is exhausted", async () => {
    const result = await discoverFeeds("https://t.me/example_channel", { limits: { maxRequests: 0, deadlineMs: 1_000 } });
    expect(result.partial).toBe("request-budget");
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });
  it("returns an actionable discovery error for private/nonexistent previews", async () => {
    mocks.safeFetch.mockResolvedValue(new Response("<html>Contact channel</html>"));
    const result = await discoverFeeds("https://t.me/example_channel");
    expect(result.feeds).toEqual([]);
    expect(result.hint).toBe("public-preview-unavailable");
    expect(result.error).toContain("private or nonexistent");
  });
  it("accepts an empty public history", async () => {
    const result = await runInHtmlWorker({ task: "telegram", html: '<div class="tgme_channel_info"></div><div class="tgme_channel_history"></div>', channel: "example_channel", url: "https://t.me/s/example_channel" });
    expect(result.articles).toEqual([]);
  });
});

describe("Bluesky enrichment and Mastodon RSS media", () => {
  it("retains native Bluesky RSS discovery", async () => {
    const result = await discoverFeeds("https://bsky.app/profile/example.bsky.social");
    expect(result.feeds[0].url).toBe("https://bsky.app/profile/example.bsky.social/rss");
  });
  it("adds full-size images and escaped quote text, preserving RSS identity", () => {
    const feed = enrichBlueskyArticles(articleFeed(), JSON.parse(fixture("bluesky.json")));
    expect(feed.articles[0].guid).toBe("keep-guid");
    expect(feed.articles[0].enclosures).toHaveLength(2);
    expect(feed.articles[0].content).toContain("&lt;script&gt;text&lt;/script&gt;");
    expect(feed.articles[0].content).not.toContain("javascript:");
    expect(feed.articles[0].imageUrl).toBe("https://media.example/sky1.jpg");
  });
  it("includes video playlists and ignores unavailable quotes", () => {
    const data = JSON.parse(fixture("bluesky.json"));
    data.feed[0].post.embed = { $type: "app.bsky.embed.video#view", playlist: "https://video.example/stream.m3u8", thumbnail: "https://media.example/thumb.jpg" };
    const post = enrichBlueskyArticles(articleFeed(), data).articles[0];
    expect(post.media?.type).toBe("application/vnd.apple.mpegurl");
    expect(post.content).toContain("<video controls");
  });
  it("does not attach media to a different author's post with the same key", () => {
    const feed = articleFeed(); feed.articles[0].link = "https://bsky.app/profile/other.example/post/post123";
    expect(enrichBlueskyArticles(feed, JSON.parse(fixture("bluesky.json"))).articles[0].content).toBe("Original");
  });
  it("recognizes RSS actor URLs", () => expect(blueskyRssActor("https://bsky.app/profile/custom.example/rss")).toBe("custom.example"));
  it("fetches enrichment by default, honors global/per-feed opt-out, and falls back on API failure", async () => {
    mocks.rss.mockResolvedValue({ text: '<rss version="2.0"><channel><title>Sky</title><item><title>Post</title><guid>keep-guid</guid><link>https://bsky.app/profile/example.bsky.social/post/post123</link><description>Original</description></item></channel></rss>' });
    mocks.safeFetch.mockImplementation(async () => new Response(fixture("bluesky.json")));
    const config = { url: "https://bsky.app/profile/example.bsky.social/rss" };
    expect((await fetchFeedArticles(config)).articles[0].enclosures).toHaveLength(2);
    expect(mocks.safeFetch).toHaveBeenCalledWith(expect.stringContaining("public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed"), expect.anything());
    mocks.safeFetch.mockClear();
    vi.stubEnv("FEEDFERRET_BLUESKY_ENRICHMENT", "false");
    await fetchFeedArticles(config); expect(mocks.safeFetch).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    await fetchFeedArticles({ ...config, scraperConfig: '{"blueskyEnrichment":false}' }); expect(mocks.safeFetch).not.toHaveBeenCalled();
    mocks.safeFetch.mockRejectedValue(new Error("offline"));
    expect((await fetchFeedArticles(config)).articles[0].content).toBe("Original");
  });
  it("preserves all Mastodon media:content images/video and native RSS resolution", async () => {
    mocks.rss.mockResolvedValue({ text: '<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Public posts</title><item><title>Caption</title><guid>post-1</guid><description>&lt;p&gt;Caption&lt;/p&gt;</description><media:content url="https://media.example/one.jpg" type="image/jpeg"/><media:content url="https://media.example/two.jpg" type="image/jpeg"/><media:content url="https://media.example/video.mp4" type="video/mp4"/></item></channel></rss>' });
    const feed = await fetchFeedArticles({ url: "https://social.example/@demo.rss" });
    // images only (video stays with `media`), none duplicated
    expect(feed.articles[0].enclosures).toEqual([{ href: "https://media.example/one.jpg", type: "image/jpeg" }, { href: "https://media.example/two.jpg", type: "image/jpeg" }]);
    expect(feed.articles[0].imageUrl).toBe("https://media.example/one.jpg");
    expect(feed.articles[0].content).toContain("https://media.example/two.jpg");
    expect(feed.articles[0].media?.type).toBe("video/mp4");
    expect(mocks.safeFetch).not.toHaveBeenCalled();
    const discovery = await discoverFeeds("https://social.example/@demo");
    expect(discovery.feeds[0].url).toBe("https://social.example/@demo.rss");
  });
  it("collapses size variants of one status image and duplicate hrefs", async () => {
    mocks.rss.mockResolvedValue({ text: '<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>P</title><item><title>Caption</title><guid>p</guid><description>Caption</description><media:content url="https://media.example/s.jpg" type="image/jpeg" width="100" height="50"/><media:content url="https://media.example/l.jpg" type="image/jpeg" width="1000" height="500"/><media:content url="https://media.example/l.jpg" type="image/jpeg" width="1000" height="500"/></item></channel></rss>' });
    const feed = await fetchFeedArticles({ url: "https://social.example/@demo.rss" });
    expect(feed.articles[0].enclosures).toEqual([{ href: "https://media.example/l.jpg", type: "image/jpeg" }]);
  });
});

// Output for ordinary feeds must stay what main produced: media:content outside
// Fediverse profile feeds must not rewrite stored content/enclosures (updatedAt wave).
describe("media:content outside Fediverse profile feeds is left alone", () => {
  const rss = (items: string) => ({ text: `<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>T</title>${items}</channel></rss>` });
  const one = async (items: string, url = "https://news.example/feed") => {
    mocks.rss.mockResolvedValue(rss(items));
    return (await fetchFeedArticles({ url })).articles[0];
  };
  it("news item with media:content variants and an image already in content", async () => {
    const article = await one('<item><title>Headline</title><guid>n1</guid><link>https://news.example/1</link><description>&lt;p&gt;Lead&lt;/p&gt;&lt;img src="https://news.example/hero.jpg"&gt;</description><media:content url="https://news.example/hero-640.jpg" type="image/jpeg" width="640" height="360"/><media:content url="https://news.example/hero-1280.jpg" type="image/jpeg" width="1280" height="720"/></item>');
    expect(article.content).toBe('<p>Lead</p><img src="https://news.example/hero.jpg">');
    expect(article.enclosures).toEqual([]);
    expect(article.imageUrl).toBe("https://news.example/hero.jpg");
  });
  it("(a) news item whose short description repeats the title, plus a thumbnail", async () => {
    const article = await one('<item><title>Markets close higher</title><guid>n2</guid><link>https://news.example/2</link><description>Markets close higher</description><media:content url="https://news.example/thumb.jpg" type="image/jpeg"/></item>');
    expect(article.content).toBe("Markets close higher");
    expect(article.enclosures).toEqual([]);
    expect(article.imageUrl).toBeNull();
  });
  it("(b) item without title and description", async () => {
    const article = await one('<item><guid>n3</guid><link>https://news.example/3</link><media:content url="https://news.example/thumb.jpg" type="image/jpeg"/></item>');
    expect(article.content).toBe("");
    expect(article.enclosures).toEqual([]);
    expect(article.imageUrl).toBeNull();
  });
  it("(c) Reddit-style Atom self-post with media:content", async () => {
    mocks.rss.mockResolvedValue({ text: '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/"><title>r/example</title><entry><id>t3_abc</id><title>Self post</title><link href="https://forum.example/r/example/abc"/><updated>2026-11-10T12:00:00Z</updated><content type="html">&lt;p&gt;Short body&lt;/p&gt;</content><media:content url="https://forum.example/thumb.jpg" type="image/jpeg"/></entry></feed>' });
    const [article] = (await fetchFeedArticles({ url: "https://forum.example/r/example/.rss" })).articles;
    expect(article.content).toBe("<p>Short body</p>");
    expect(article.enclosures).toEqual([]);
    expect(article.imageUrl).toBeNull();
  });
  it("(d) audio item with media:content only: one `media`, no enclosure copy", async () => {
    const article = await one('<item><title>Episode</title><guid>a1</guid><link>https://pod.example/a1</link><description>Short notes</description><media:content url="https://pod.example/a1.mp3" type="audio/mpeg"/></item>');
    expect(article.enclosures).toEqual([]);
    expect(article.media).toEqual({ url: "https://pod.example/a1.mp3", type: "audio/mpeg" });
    expect(article.content).toBe("Short notes");
  });
  it("(e) short video item with media:content video and thumbnail", async () => {
    const article = await one('<item><title>Clip</title><guid>v1</guid><link>https://video.example/v1</link><description>Short clip</description><media:content url="https://video.example/v1.mp4" type="video/mp4"/><media:content url="https://video.example/v1.jpg" type="image/jpeg"/></item>');
    expect(article.enclosures).toEqual([]);
    expect(article.media).toEqual({ url: "https://video.example/v1.mp4", type: "video/mp4" });
    expect(article.content).toBe("Short clip");
    expect(article.imageUrl).toBeNull();
  });
  it("podcast with the same mp3 in enclosure and media:content has one enclosure", async () => {
    const article = await one('<item><title>Episode 1</title><guid>e1</guid><link>https://pod.example/1</link><description>Notes</description><enclosure url="https://pod.example/1.mp3" type="audio/mpeg" length="123"/><media:content url="https://pod.example/1.mp3" type="audio/mpeg"/></item>', "https://pod.example/feed");
    expect(article.enclosures).toEqual([{ href: "https://pod.example/1.mp3", type: "audio/mpeg", length: 123 }]);
    expect(article.content).toBe("Notes");
  });
  it("only Fediverse profile feed URLs opt in", () => {
    expect(isFediverseProfileFeed("https://social.example/@demo.rss")).toBe(true);
    expect(isFediverseProfileFeed("https://social.example/users/demo.rss")).toBe(true);
    expect(isFediverseProfileFeed("https://news.example/feed")).toBe(false);
    expect(isFediverseProfileFeed("https://forum.example/r/example/.rss")).toBe(false);
  });
});
