import { describe, expect, it, vi } from "vitest";
import { synthesizeItemTitle } from "../../lib/title-synthesis";
import { fetchFeedArticles } from "../../lib/feed-fetcher";
import { db } from "../../lib/db";

describe("synthesizeItemTitle", () => {
  it("decodes character references exactly once (named, decimal, hex incl. emoji)", () => {
    expect(synthesizeItemTitle("Tom &amp;amp; Jerry &amp;lt;b&amp;gt;")).toBe("Tom &amp; Jerry &lt;b&gt;");
    expect(synthesizeItemTitle("caf&eacute; &mdash; &hellip; &copy;")).toBe("café — … ©");
    expect(synthesizeItemTitle("&#128512; &#x1F600; &#X1f389;")).toBe("😀 😀 🎉");
    expect(synthesizeItemTitle("a&nbsp;&nbsp;b")).toBe("a b");
    expect(synthesizeItemTitle("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe("<script>alert(1)</script>");
  });

  it("ignores script/style/comments", () => {
    expect(synthesizeItemTitle("<style>p{color:red}</style><!-- hidden --><script>var a = '<p>';</script><p>Visible</p>")).toBe("Visible");
  });

  it("never splits a grapheme cluster or leaves a lone surrogate when truncating", () => {
    const family = "👨‍👩‍👧‍👦";
    const text = `${"x".repeat(9)}${family}${"y".repeat(20)}`;
    const out = synthesizeItemTitle(text, 10)!;
    expect(out).toBe(`${"x".repeat(9)}${family}…`);
    const emojiOnly = "😀".repeat(100);
    const cut = synthesizeItemTitle(emojiOnly, 80)!;
    expect(cut).toBe(`${"😀".repeat(80)}…`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut)).toBe(false);
    expect(synthesizeItemTitle("é".normalize("NFD").repeat(90), 80)).toBe(`${"é".normalize("NFD").repeat(80)}…`);
  });

  it("strips HTML, decodes entities, and collapses whitespace", () => {
    const html = "<p>Hello &amp; welcome to <b>FeedFerret</b>!<br/>This is a test &quot;quote&#39;.</p>";
    expect(synthesizeItemTitle(html)).toBe('Hello & welcome to FeedFerret! This is a test "quote\'.');
  });

  it("leaves text <= 80 chars untouched without adding ellipsis", () => {
    const text = "A short post that easily fits under eighty characters.";
    expect(text.length).toBeLessThan(80);
    expect(synthesizeItemTitle(text)).toBe(text);
  });

  it("leaves text exactly 80 chars untouched without adding ellipsis", () => {
    const text = "1234567890 1234567890 1234567890 1234567890 1234567890 1234567890 1234567890 123";
    expect(text.length).toBe(80);
    expect(synthesizeItemTitle(text)).toBe(text);
  });

  it("cuts text > 80 chars on a word boundary and appends ellipsis", () => {
    const text = "The quick brown fox jumps over the lazy dog and runs across the wide green field towards the forest.";
    expect(text.length).toBeGreaterThan(80);
    const synthesized = synthesizeItemTitle(text, 80);
    expect(synthesized).toBe("The quick brown fox jumps over the lazy dog and runs across the wide green field…");
    expect(synthesized?.endsWith("…")).toBe(true);
    expect(synthesized!.length).toBeLessThanOrEqual(81);
  });

  it("cuts text > 80 chars on maxChars boundary when next char is space", () => {
    const prefix = "A".repeat(80);
    const text = `${prefix} next word`;
    expect(synthesizeItemTitle(text, 80)).toBe(`${prefix}…`);
  });

  it("cuts text > 80 chars without any space at maxChars boundary", () => {
    const longWord = "A".repeat(120);
    expect(synthesizeItemTitle(longWord, 80)).toBe(`${"A".repeat(80)}…`);
  });

  it("returns null for empty, whitespace, or tag-only content", () => {
    expect(synthesizeItemTitle(null)).toBeNull();
    expect(synthesizeItemTitle("")).toBeNull();
    expect(synthesizeItemTitle("   \n\t  ")).toBeNull();
    expect(synthesizeItemTitle("<p><br/></p>")).toBeNull();
  });
});

describe("fetchFeedArticles title synthesis for Mastodon and Bluesky feeds", () => {
  it("synthesizes titles from post content when title is absent or Untitled", async () => {
    const mastodonXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Eugen Rochko (@Gargron@mastodon.social)</title>
    <link>https://mastodon.social/@Gargron</link>
    <item>
      <title></title>
      <link>https://mastodon.social/@Gargron/123456789</link>
      <guid>https://mastodon.social/@Gargron/123456789</guid>
      <description>&lt;p&gt;Working on the next release of Mastodon. Full-text search and account migration improvements coming soon!&lt;/p&gt;</description>
      <pubDate>Mon, 10 Nov 2026 12:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

    const globalSpy = vi.spyOn(db.globalSettings, "findUnique").mockResolvedValue({ allowInternalFeedUrls: false } as any);
    const ssrf = await import("../../lib/ssrf");
    const fetchSpy = vi.spyOn(ssrf, "fetchWithSsrfProtection").mockResolvedValueOnce({
      notModified: false,
      text: mastodonXml,
      etag: null,
      lastModified: null,
      headers: new Headers(),
    });

    const feed = await fetchFeedArticles({ url: "https://mastodon.social/@Gargron.rss" });
    expect(feed.articles.length).toBe(1);
    expect(feed.articles[0].title).toBe("Working on the next release of Mastodon. Full-text search and account migration…");
    fetchSpy.mockRestore();
    globalSpy.mockRestore();
  });
});

// The DB-level provenance behaviour (legacy "Untitled" rows, unicityCriteria,
// Article.updatedAt) is covered end to end through the real fetchers and
// syncFeed in title-synthesis-sync.sqlite.test.ts.
