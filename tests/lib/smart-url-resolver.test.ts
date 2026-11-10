import { describe, expect, it, vi } from "vitest";
import {
  buildTopicFeeds,
  googleNewsLocale,
  matchSource,
  parseSourceInput,
  parseYoutubePage,
  resolveSource,
  type ResolverDeps,
} from "../../lib/smart-url-resolver";

const urls = (input: string) => matchSource(input).feeds.map((f) => f.url);
const noFetch: ResolverDeps = { fetchText: vi.fn(async () => { throw new Error("network must not be used"); }) };

describe("parseSourceInput", () => {
  it.each([
    ["https://example.com/a?b=1", "url", "https://example.com/a?b=1"],
    ["example.com/blog", "url", "https://example.com/blog"],
    ["youtube.com/@MKBHD", "url", "https://youtube.com/@MKBHD"],
    ["feed:https://example.com/feed.xml", "url", "https://example.com/feed.xml"],
    ["feed://example.com/feed.xml", "url", "https://example.com/feed.xml"],
    ["r/rust", "url", "https://www.reddit.com/r/rust"],
    ["/r/rust", "url", "https://www.reddit.com/r/rust"],
    ["u/spez", "url", "https://www.reddit.com/user/spez"],
    ["@Gargron@mastodon.social", "url", "https://mastodon.social/@Gargron"],
    ["gargron@mastodon.social", "url", "https://mastodon.social/@gargron"],
    ["@bsky.app.bsky.social", "url", "https://bsky.app/profile/bsky.app.bsky.social"],
    ["@MKBHD", "url", "https://www.youtube.com/@MKBHD"],
  ])("%s → %s", (input, type, href) => {
    const parsed = parseSourceInput(input);
    expect(parsed.type).toBe(type);
    if (parsed.type === "url") expect(parsed.url.toString()).toBe(href);
  });

  it.each(["rust", "postgres vs sqlite", "next.js", "main.py", "AC/DC tour dates"])("treats %j as a topic", (input) => {
    expect(parseSourceInput(input).type).toBe("topic");
  });

  it("returns empty for blank input and collapses whitespace in topics", () => {
    expect(parseSourceInput("   ").type).toBe("empty");
    expect(parseSourceInput("a   b\t c")).toEqual({ type: "topic", query: "a b c" });
  });
});

describe("YouTube", () => {
  const id = "UCBJycsmduvYEL83R_U4JriQ";
  it("/channel/UC… resolves without any lookup", () => {
    const m = matchSource(`https://www.youtube.com/channel/${id}/videos`);
    expect(m.lookups).toEqual([]);
    expect(m.feeds.map((f) => f.url)).toEqual([`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`]);
    expect(m.feeds[0]).toMatchObject({ kind: "videos", platform: "youtube", format: "atom" });
    expect(m.feeds[0].confidence).toBeGreaterThan(0.9);
  });

  it("playlist URL → playlist_id feed", () => {
    expect(urls("https://www.youtube.com/playlist?list=PLBCF2DAC6FFB574DE")).toEqual([
      "https://www.youtube.com/feeds/videos.xml?playlist_id=PLBCF2DAC6FFB574DE",
    ]);
  });

  it("ignores auto-generated mixes (RD…) on the playlist route", () => {
    expect(matchSource("https://www.youtube.com/playlist?list=RDdQw4w9WgXcQ").feeds).toEqual([]);
  });

  it.each([
    ["https://www.youtube.com/@MKBHD", "https://www.youtube.com/@MKBHD"],
    ["https://www.youtube.com/@MKBHD/videos", "https://www.youtube.com/@MKBHD"],
    ["https://m.youtube.com/@MKBHD/shorts", "https://www.youtube.com/@MKBHD"],
    ["https://www.youtube.com/c/Google", "https://www.youtube.com/c/Google"],
    ["https://www.youtube.com/user/GoogleDevelopers", "https://www.youtube.com/user/GoogleDevelopers"],
  ])("%s needs a channel-page lookup", (input, lookupUrl) => {
    const m = matchSource(input);
    expect(m.matched).toBe(true);
    expect(m.feeds).toEqual([]);
    expect(m.lookups).toEqual([expect.objectContaining({ type: "youtube-page", url: lookupUrl })]);
  });

  it.each([
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ",
  ])("video URL %s → channel lookup", (input) => {
    expect(matchSource(input).lookups).toEqual([
      expect.objectContaining({ type: "youtube-page", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    ]);
  });

  it("watch URL inside a playlist also offers the playlist feed", () => {
    const m = matchSource("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLBCF2DAC6FFB574DE");
    expect(m.feeds.map((f) => f.url)).toEqual(["https://www.youtube.com/feeds/videos.xml?playlist_id=PLBCF2DAC6FFB574DE"]);
    expect(m.lookups).toHaveLength(1);
  });

  it("never emits the undocumented UULF/UUSH variants", () => {
    const all = [...urls(`https://www.youtube.com/channel/${id}`), ...urls("https://www.youtube.com/playlist?list=PLBCF2DAC6FFB574DE")];
    expect(all.join(" ")).not.toMatch(/playlist_id=UU(?:LF|SH|LV)/);
  });

  it("resolveSource turns the channel page into a channel feed (mocked fetch)", async () => {
    const html = `<html><head><link rel="canonical" href="https://www.youtube.com/channel/${id}"><meta property="og:title" content="Marques &amp; Co"></head></html>`;
    const fetchText = vi.fn(async () => html);
    const { matched, feeds } = await resolveSource("@MKBHD", { fetchText });
    expect(matched).toBe(true);
    expect(fetchText).toHaveBeenCalledWith("https://www.youtube.com/@MKBHD", expect.objectContaining({ headers: expect.any(Object) }));
    expect(feeds).toEqual([
      expect.objectContaining({ url: `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`, title: "YouTube · Marques & Co" }),
    ]);
  });

  it("lookup failure yields matched=true with no feeds (caller falls back to scraping)", async () => {
    const r = await resolveSource("https://www.youtube.com/@x_user", noFetch);
    expect(r).toEqual({ matched: true, feeds: [] });
  });

  describe("parseYoutubePage", () => {
    const id2 = "UC_x5XG1OV2P6uZZ5FSM9Ttw";
    it("prefers the RSS <link>", () => {
      expect(parseYoutubePage(`<link rel="alternate" type="application/rss+xml" title="RSS" href="https://www.youtube.com/feeds/videos.xml?channel_id=${id2}">`)?.channelId).toBe(id2);
    });
    it("reads watch-page itemprop channelId before any JSON blob", () => {
      const html = `<meta itemprop="channelId" content="${id2}"><script>{"channelId":"UCaaaaaaaaaaaaaaaaaaaaaa"}</script>`;
      expect(parseYoutubePage(html)?.channelId).toBe(id2);
    });
    it("falls back to externalId JSON", () => {
      expect(parseYoutubePage(`<script>{"externalId":"${id2}"}</script>`)?.channelId).toBe(id2);
    });
    it("returns null for a consent wall", () => {
      expect(parseYoutubePage("<html>consent.youtube.com</html>")).toBeNull();
    });
  });
});

describe("Reddit", () => {
  it("subreddit → hot / new / top-week", () => {
    expect(urls("https://www.reddit.com/r/rust/")).toEqual([
      "https://www.reddit.com/r/rust/.rss",
      "https://www.reddit.com/r/rust/new/.rss",
      "https://www.reddit.com/r/rust/top/.rss?t=week",
    ]);
  });
  it("old.reddit.com and sort suffix", () => {
    expect(urls("https://old.reddit.com/r/selfhosted/new")[0]).toBe("https://www.reddit.com/r/selfhosted/.rss");
  });
  it("multi-subreddit", () => {
    expect(urls("https://www.reddit.com/r/rust+golang")[0]).toBe("https://www.reddit.com/r/rust+golang/.rss");
  });
  it("unknown sort is not a subreddit view", () => {
    expect(matchSource("https://www.reddit.com/r/rust/wiki").matched).toBe(false);
  });
  it("user", () => {
    expect(urls("https://www.reddit.com/user/spez/comments")).toEqual([
      "https://www.reddit.com/user/spez/.rss",
      "https://www.reddit.com/user/spez/submitted/.rss",
    ]);
  });
  it("multireddit", () => {
    expect(urls("https://www.reddit.com/user/someone/m/tech")).toEqual(["https://www.reddit.com/user/someone/m/tech/.rss"]);
  });
  it("search (site-wide and per-subreddit)", () => {
    expect(urls("https://www.reddit.com/search/?q=local%20first")).toEqual(["https://www.reddit.com/search.rss?q=local%20first&sort=new"]);
    expect(urls("https://www.reddit.com/r/rust/search?q=async&restrict_sr=1")).toEqual([
      "https://www.reddit.com/r/rust/search.rss?q=async&restrict_sr=on&sort=new",
    ]);
  });
  it("comment thread + its subreddit", () => {
    expect(urls("https://www.reddit.com/r/rust/comments/abc123/some_title/")).toEqual([
      "https://www.reddit.com/r/rust/comments/abc123/.rss",
      "https://www.reddit.com/r/rust/.rss",
    ]);
  });
  it("shorthand r/rust resolves like a URL", () => {
    expect(urls("r/rust")[0]).toBe("https://www.reddit.com/r/rust/.rss");
  });
});

describe("Mastodon / fediverse", () => {
  it("@user@host handle → home-server .rss, flagged for verification", () => {
    const m = matchSource("@Gargron@mastodon.social");
    expect(m.feeds).toEqual([expect.objectContaining({ url: "https://mastodon.social/@Gargron.rss", platform: "mastodon", verify: true })]);
  });
  it("profile URL", () => {
    expect(urls("https://fosstodon.org/@someone")).toEqual(["https://fosstodon.org/@someone.rss"]);
  });
  it("remote profile viewed on another server points at the home server", () => {
    expect(urls("https://mastodon.social/@someone@fosstodon.org")).toEqual(["https://fosstodon.org/@someone.rss"]);
  });
  it("status URL → author's feed", () => {
    expect(urls("https://mastodon.social/@Gargron/109123456789")).toEqual(["https://mastodon.social/@Gargron.rss"]);
  });
  it("/tags/x → tag .rss", () => {
    expect(urls("https://mastodon.social/tags/rust")).toEqual(["https://mastodon.social/tags/rust.rss"]);
  });
  it.each(["https://www.tiktok.com/@someone", "https://medium.com/@someone/post", "https://www.youtube.com/@someone"])(
    "does not guess a fediverse feed on %s",
    (u) => {
      expect(urls(u).filter((x) => x.endsWith(".rss") && !x.includes("medium.com"))).toEqual([]);
    },
  );
});

describe("Bluesky", () => {
  it("profile → /rss", () => {
    expect(urls("https://bsky.app/profile/bsky.app")).toEqual(["https://bsky.app/profile/bsky.app/rss"]);
    expect(urls("https://bsky.app/profile/did:plc:abc123/")).toEqual(["https://bsky.app/profile/did:plc:abc123/rss"]);
  });
  it("post URL → author's feed; custom feeds are ignored", () => {
    expect(urls("https://bsky.app/profile/bsky.app/post/3k44")).toEqual(["https://bsky.app/profile/bsky.app/rss"]);
    expect(matchSource("https://bsky.app/profile/bsky.app/feed/whats-hot").matched).toBe(false);
  });
});

describe("GitHub", () => {
  it("repo → releases / commits / tags", () => {
    const m = matchSource("https://github.com/rust-lang/rust");
    expect(m.feeds.map((f) => [f.kind, f.url])).toEqual([
      ["releases", "https://github.com/rust-lang/rust/releases.atom"],
      ["commits", "https://github.com/rust-lang/rust/commits.atom"],
      ["tags", "https://github.com/rust-lang/rust/tags.atom"],
    ]);
    expect(m.feeds[0].confidence).toBeGreaterThan(m.feeds[2].confidence);
  });
  it("deep link keeps the branch for the commits feed", () => {
    const commits = matchSource("https://github.com/vercel/next.js/tree/canary").feeds.find((f) => f.kind === "commits");
    expect(commits?.url).toBe("https://github.com/vercel/next.js/commits/canary.atom");
  });
  it("strips .git and works from issue pages", () => {
    expect(urls("https://github.com/o/r.git")[0]).toBe("https://github.com/o/r/releases.atom");
    expect(urls("https://github.com/o/r/issues/12")[0]).toBe("https://github.com/o/r/releases.atom");
  });
  it("user → public activity atom", () => {
    expect(urls("https://github.com/torvalds")).toEqual(["https://github.com/torvalds.atom"]);
  });
  it.each(["https://github.com/settings/profile", "https://github.com/orgs/vercel", "https://github.com/topics/rust", "https://github.com/trending"])(
    "reserved path %s is not a repo/user",
    (u) => expect(matchSource(u).matched).toBe(false),
  );
});

describe("GitLab", () => {
  it("project → tags / commits / activity", () => {
    expect(urls("https://gitlab.com/gitlab-org/gitlab")).toEqual([
      "https://gitlab.com/gitlab-org/gitlab/-/tags?format=atom",
      "https://gitlab.com/gitlab-org/gitlab/-/commits/HEAD?format=atom",
      "https://gitlab.com/gitlab-org/gitlab.atom",
    ]);
  });
  it("nested groups and /-/ deep links", () => {
    const m = matchSource("https://gitlab.com/a/b/c/-/tree/develop");
    expect(m.feeds[0].url).toBe("https://gitlab.com/a/b/c/-/tags?format=atom");
    expect(m.feeds[1].url).toBe("https://gitlab.com/a/b/c/-/commits/develop?format=atom");
  });
  it("self-hosted gitlab.* host", () => {
    expect(urls("https://gitlab.example.org/team/app")[0]).toBe("https://gitlab.example.org/team/app/-/tags?format=atom");
  });
  it("single segment is a user guess that must be verified", () => {
    expect(matchSource("https://gitlab.com/dzaporozhets").feeds).toEqual([
      expect.objectContaining({ url: "https://gitlab.com/dzaporozhets.atom", verify: true }),
    ]);
  });
  it("reserved first segments are ignored", () => {
    expect(matchSource("https://gitlab.com/explore/projects").matched).toBe(false);
  });
});

describe("arXiv", () => {
  it("category listing → rss + atom", () => {
    expect(urls("https://arxiv.org/list/cs.AI/recent")).toEqual(["https://rss.arxiv.org/rss/cs.AI", "https://rss.arxiv.org/atom/cs.AI"]);
    expect(urls("https://arxiv.org/list/hep-th/new")[0]).toBe("https://rss.arxiv.org/rss/hep-th");
  });
  it("search page → API query atom feed sorted by date", () => {
    const [f] = matchSource("https://arxiv.org/search/?query=quantum+error&searchtype=all").feeds;
    expect(f.url).toBe(
      "https://export.arxiv.org/api/query?search_query=all:quantum+AND+all:error&sortBy=submittedDate&sortOrder=descending&max_results=50",
    );
  });
});

describe("Substack", () => {
  it("publication subdomain and post URLs", () => {
    expect(urls("https://stratechery.substack.com/")).toEqual(["https://stratechery.substack.com/feed"]);
    expect(urls("https://stratechery.substack.com/p/some-post")).toEqual(["https://stratechery.substack.com/feed"]);
  });
  it("open.substack.com/pub/<name>", () => {
    expect(urls("https://open.substack.com/pub/lennysnewsletter/p/x")).toEqual(["https://lennysnewsletter.substack.com/feed"]);
  });
  it.each(["https://substack.com/", "https://www.substack.com/about", "https://open.substack.com/"])("%s is not a publication", (u) => {
    expect(matchSource(u).matched).toBe(false);
  });
});

describe("Medium", () => {
  it("user, tag, publication, subdomain", () => {
    expect(urls("https://medium.com/@someone/a-post-123")).toEqual(["https://medium.com/feed/@someone"]);
    expect(urls("https://medium.com/tag/rust")).toEqual(["https://medium.com/feed/tag/rust"]);
    expect(urls("https://medium.com/better-programming")).toEqual(["https://medium.com/feed/better-programming"]);
    expect(urls("https://netflixtechblog.medium.com/some-post-abc")).toEqual(["https://netflixtechblog.medium.com/feed"]);
  });
  it("reserved paths are not publications", () => {
    expect(matchSource("https://medium.com/m/signin").matched).toBe(false);
    expect(matchSource("https://medium.com/").matched).toBe(false);
  });
});

describe("Hacker News", () => {
  it("front page + variants", () => {
    expect(urls("https://news.ycombinator.com/")).toEqual([
      "https://hnrss.org/frontpage",
      "https://hnrss.org/frontpage?points=100",
      "https://hnrss.org/best",
    ]);
  });
  it.each([
    ["https://news.ycombinator.com/newest", "https://hnrss.org/newest"],
    ["https://news.ycombinator.com/ask", "https://hnrss.org/ask"],
    ["https://news.ycombinator.com/show", "https://hnrss.org/show"],
    ["https://news.ycombinator.com/jobs", "https://hnrss.org/jobs"],
    ["https://news.ycombinator.com/user?id=pg", "https://hnrss.org/submitted?id=pg"],
    ["https://news.ycombinator.com/item?id=8863", "https://hnrss.org/item?id=8863"],
    ["https://news.ycombinator.com/from?site=github.com", "https://hnrss.org/newest?link=github.com"],
  ])("%s → %s", (input, first) => expect(urls(input)[0]).toBe(first));
  it("rejects malformed ids", () => {
    expect(matchSource("https://news.ycombinator.com/item?id=abc").matched).toBe(false);
  });
});

describe("Lobsters", () => {
  it.each([
    ["https://lobste.rs/", "https://lobste.rs/rss"],
    ["https://lobste.rs/newest", "https://lobste.rs/newest.rss"],
    ["https://lobste.rs/comments", "https://lobste.rs/comments.rss"],
    ["https://lobste.rs/t/rust", "https://lobste.rs/t/rust.rss"],
    ["https://lobste.rs/~pushcx", "https://lobste.rs/~pushcx/stories.rss"],
  ])("%s → %s", (input, first) => expect(urls(input)[0]).toBe(first));
});

describe("Apple Podcasts", () => {
  const url = "https://podcasts.apple.com/us/podcast/the-daily/id1200361736";
  it("needs an iTunes lookup, carrying the storefront country", () => {
    expect(matchSource(url).lookups).toEqual([{ type: "itunes", id: "1200361736", country: "us" }]);
  });
  it("resolves feedUrl from the lookup JSON (mocked)", async () => {
    const fetchText = vi.fn(async () =>
      JSON.stringify({ resultCount: 1, results: [{ collectionName: "The Daily", feedUrl: "https://feeds.simplecast.com/54nAGcIl" }] }),
    );
    const { feeds } = await resolveSource(url, { fetchText });
    expect(fetchText).toHaveBeenCalledWith("https://itunes.apple.com/lookup?id=1200361736&entity=podcast&country=us");
    expect(feeds).toEqual([expect.objectContaining({ url: "https://feeds.simplecast.com/54nAGcIl", title: "Apple Podcasts · The Daily", kind: "podcast" })]);
  });
  it("handles missing feedUrl / bad JSON gracefully", async () => {
    expect((await resolveSource(url, { fetchText: async () => JSON.stringify({ results: [{}] }) })).feeds).toEqual([]);
    expect((await resolveSource(url, { fetchText: async () => "<html>" })).feeds).toEqual([]);
    expect((await resolveSource(url, { fetchText: async () => JSON.stringify({ results: [{ feedUrl: "javascript:alert(1)" }] }) })).feeds).toEqual([]);
  });
});

describe("Steam", () => {
  it.each([
    "https://store.steampowered.com/app/570/Dota_2/",
    "https://steamcommunity.com/app/570",
    "https://store.steampowered.com/news/app/570",
  ])("%s → news feed", (u) => expect(urls(u)).toEqual(["https://store.steampowered.com/feeds/news/app/570/"]));
});

describe("Letterboxd", () => {
  it("user pages → /rss/", () => {
    expect(urls("https://letterboxd.com/dave/films/diary/")).toEqual(["https://letterboxd.com/dave/rss/"]);
  });
  it("site sections are not users", () => {
    expect(matchSource("https://letterboxd.com/films/").matched).toBe(false);
  });
});

describe("non-matches", () => {
  it("returns matched=false for unknown sites and topics", () => {
    expect(matchSource("https://example.com/blog")).toEqual({ feeds: [], lookups: [], matched: false });
    expect(matchSource("rust news")).toEqual({ feeds: [], lookups: [], matched: false });
  });
});

describe("topic feeds", () => {
  it("offers Google News, Bing News, hnrss and arXiv", () => {
    const feeds = buildTopicFeeds("local first software", { locale: "de" });
    expect(feeds.map((f) => f.platform)).toEqual(["google-news", "bing-news", "hackernews", "arxiv"]);
    expect(feeds[0].url).toBe("https://news.google.com/rss/search?q=local%20first%20software&hl=de&gl=DE&ceid=DE%3Ade");
    expect(feeds[1].url).toBe("https://www.bing.com/news/search?q=local%20first%20software&format=rss");
    expect(feeds[2].url).toBe("https://hnrss.org/newest?q=local%20first%20software");
    expect(feeds[3].url).toContain("search_query=all:local+AND+all:first+AND+all:software");
    expect(feeds.every((f) => f.kind === "topic" || f.kind === "search")).toBe(true);
  });
  it("keeps quoted phrases together and encodes operators", () => {
    const feeds = buildTopicFeeds('"quantum computing" OR qubits & more');
    expect(feeds[0].url).toContain("q=%22quantum%20computing%22%20OR%20qubits%20%26%20more");
    expect(feeds[3].url).toContain("all:%22quantum%20computing%22+AND+all:OR");
  });
  it("is empty for blank queries", () => {
    expect(buildTopicFeeds("   ")).toEqual([]);
  });
  it.each([
    ["de", { hl: "de", gl: "DE", ceid: "DE:de" }],
    ["en", { hl: "en-US", gl: "US", ceid: "US:en" }],
    ["en-GB", { hl: "en-GB", gl: "GB", ceid: "GB:en" }],
    ["pt_BR", { hl: "pt", gl: "BR", ceid: "BR:pt" }],
    [undefined, { hl: "en-US", gl: "US", ceid: "US:en" }],
    ["../evil", { hl: "en-US", gl: "US", ceid: "US:en" }],
  ])("googleNewsLocale(%s)", (locale, expected) => expect(googleNewsLocale(locale as string | undefined)).toEqual(expected));
});
