import { describe, expect, it, vi } from "vitest";
import { resolvePublisherFeeds } from "../../lib/publisher-feeds";
import { matchSource } from "../../lib/smart-url-resolver";
import { discoverFeeds } from "../../lib/feed-discovery";

const mocks = vi.hoisted(() => ({
  fetchText: vi.fn(),
}));

vi.mock("../../lib/ssrf", async () => {
  const actual = await vi.importActual<any>("../../lib/ssrf");
  return {
    ...actual,
    fetchTextWithSsrfProtection: mocks.fetchText,
    fetchWithSsrfProtection: vi.fn(async (url: string, init?: any, options?: any) => {
      const text = await mocks.fetchText(url, init, options);
      return { notModified: false, text, etag: null, lastModified: null, headers: new Headers() };
    }),
    isTrustedFeedFetchingAllowed: vi.fn().mockResolvedValue(false),
  };
});

describe("resolvePublisherFeeds", () => {
  it("resolves Tagesschau homepage and sections", () => {
    const home = resolvePublisherFeeds(new URL("https://www.tagesschau.de/"));
    expect(home[0]).toMatchObject({
      url: "https://www.tagesschau.de/infoservices/alle-meldungen-100~rss2.xml",
      title: "Tagesschau · Alle Meldungen",
      platform: "tagesschau",
      format: "rss",
      verify: true,
    });

    const inland = resolvePublisherFeeds(new URL("https://www.tagesschau.de/inland"));
    expect(inland[0]).toMatchObject({
      url: "https://www.tagesschau.de/inland/index~rss2.xml",
      title: "Tagesschau · Inland",
      platform: "tagesschau",
      verify: true,
    });

    const ausland = resolvePublisherFeeds(new URL("https://www.tagesschau.de/ausland/meldung-123.html"));
    expect(ausland[0]).toMatchObject({
      url: "https://www.tagesschau.de/ausland/index~rss2.xml",
      title: "Tagesschau · Ausland",
      platform: "tagesschau",
    });
  });

  it("resolves Heise homepage and sections/subdomains", () => {
    const home = resolvePublisherFeeds(new URL("https://www.heise.de/"));
    expect(home[0]).toMatchObject({
      url: "https://www.heise.de/rss/heise-atom.xml",
      title: "Heise · News",
      platform: "heise",
      format: "atom",
    });

    const dev = resolvePublisherFeeds(new URL("https://www.heise.de/developer/"));
    expect(dev[0]).toMatchObject({
      url: "https://www.heise.de/developer/feed.xml",
      title: "Heise · Developer",
      platform: "heise",
    });

    const ct = resolvePublisherFeeds(new URL("https://www.heise.de/ct/"));
    expect(ct[0]).toMatchObject({
      url: "https://www.heise.de/ct/feed.xml",
      title: "Heise · c't",
    });

    const ctDomain = resolvePublisherFeeds(new URL("https://ct.de/"));
    expect(ctDomain[0]).toMatchObject({
      url: "https://www.heise.de/ct/feed.xml",
      title: "Heise · c't",
    });
  });

  it("resolves Spiegel homepage and sections", () => {
    const home = resolvePublisherFeeds(new URL("https://www.spiegel.de/"));
    expect(home[0]).toMatchObject({
      url: "https://www.spiegel.de/schlagzeilen/index.rss",
      title: "Spiegel · Schlagzeilen",
      platform: "spiegel",
    });

    const politik = resolvePublisherFeeds(new URL("https://www.spiegel.de/politik/"));
    expect(politik[0]).toMatchObject({
      url: "https://www.spiegel.de/politik/index.rss",
      title: "Spiegel · Politik",
      platform: "spiegel",
    });

    const netzwelt = resolvePublisherFeeds(new URL("https://www.spiegel.de/netzwelt/web/artikel-123.html"));
    expect(netzwelt[0]).toMatchObject({
      url: "https://www.spiegel.de/netzwelt/index.rss",
      title: "Spiegel · Netzwelt",
    });
  });

  it("resolves BBC News homepage and sections", () => {
    const home = resolvePublisherFeeds(new URL("https://www.bbc.com/news"));
    expect(home[0]).toMatchObject({
      url: "https://feeds.bbci.co.uk/news/rss.xml",
      title: "BBC News · Top Stories",
      platform: "bbc",
    });

    const world = resolvePublisherFeeds(new URL("https://www.bbc.com/news/world"));
    expect(world[0]).toMatchObject({
      url: "https://feeds.bbci.co.uk/news/world/rss.xml",
      title: "BBC News · World",
    });

    const ukCo = resolvePublisherFeeds(new URL("https://www.bbc.co.uk/news/technology"));
    expect(ukCo[0]).toMatchObject({
      url: "https://feeds.bbci.co.uk/news/technology/rss.xml",
      title: "BBC News · Technology",
    });
  });

  it("resolves NPR homepage and sections", () => {
    const home = resolvePublisherFeeds(new URL("https://www.npr.org/"));
    expect(home[0]).toMatchObject({
      url: "https://feeds.npr.org/1001/rss.xml",
      title: "NPR · News",
      platform: "npr",
    });

    const world = resolvePublisherFeeds(new URL("https://www.npr.org/sections/world/"));
    expect(world[0]).toMatchObject({
      url: "https://feeds.npr.org/1004/rss.xml",
      title: "NPR · World",
    });
  });

  it("resolves NYTimes homepage and sections", () => {
    const home = resolvePublisherFeeds(new URL("https://www.nytimes.com/"));
    expect(home[0]).toMatchObject({
      url: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
      title: "The New York Times · Home Page",
      platform: "nytimes",
    });

    const tech = resolvePublisherFeeds(new URL("https://www.nytimes.com/section/technology"));
    expect(tech[0]).toMatchObject({
      url: "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml",
      title: "The New York Times · Technology",
    });
  });

  it("resolves Zeit, Süddeutsche, FAZ, Golem, t3n, netzpolitik, and Der Standard", () => {
    expect(resolvePublisherFeeds(new URL("https://www.zeit.de/politik"))[0]).toMatchObject({
      url: "https://newsfeed.zeit.de/politik/index",
      title: "ZEIT ONLINE · Politik",
      platform: "zeit",
    });

    expect(resolvePublisherFeeds(new URL("https://www.sueddeutsche.de/wirtschaft"))[0]).toMatchObject({
      url: "https://rss.sueddeutsche.de/rss/Wirtschaft",
      title: "Süddeutsche Zeitung · Wirtschaft",
      platform: "sueddeutsche",
    });

    expect(resolvePublisherFeeds(new URL("https://www.faz.net/aktuell/finanzen/"))[0]).toMatchObject({
      url: "https://www.faz.net/rss/aktuell/finanzen/",
      title: "FAZ · Finanzen",
      platform: "faz",
    });

    expect(resolvePublisherFeeds(new URL("https://www.golem.de/specials/security/"))[0]).toMatchObject({
      url: "https://rss.golem.de/rss.php?tp=sec&feed=ATOM1.0",
      title: "Golem.de · Security",
      platform: "golem",
    });

    expect(resolvePublisherFeeds(new URL("https://t3n.de/"))[0]).toMatchObject({
      url: "https://t3n.de/rss.xml",
      title: "t3n · News",
      platform: "t3n",
    });

    expect(resolvePublisherFeeds(new URL("https://netzpolitik.org/"))[0]).toMatchObject({
      url: "https://netzpolitik.org/feed/",
      platform: "netzpolitik",
    });
    // Unverified category feeds are left to normal discovery.
    expect(resolvePublisherFeeds(new URL("https://netzpolitik.org/category/datenschutz/"))).toEqual([]);

    expect(resolvePublisherFeeds(new URL("https://www.derstandard.at/international"))[0]).toMatchObject({
      url: "https://www.derstandard.at/rss/international",
      title: "Der Standard · International",
      platform: "derstandard",
    });
  });

  it("is integrated in matchSource", () => {
    const match = matchSource("https://www.spiegel.de/kultur");
    expect(match.matched).toBe(true);
    expect(match.feeds[0]).toMatchObject({
      url: "https://www.spiegel.de/kultur/index.rss",
      title: "Spiegel · Kultur",
    });
  });
});

describe("resolvePublisherFeeds never broadens scope", () => {
  it.each([
    // Explicit feed URLs are never rewritten (normal discovery validates them).
    "https://feeds.npr.org/1004/rss.xml",
    "https://rss.nytimes.com/services/xml/rss/nyt/Science.xml",
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://www.tagesschau.de/inland/index~rss2.xml",
    "https://www.heise.de/rss/heise-atom.xml",
    "https://www.spiegel.de/politik/index.rss",
    "https://www.faz.net/rss/aktuell/politik/",
    "https://netzpolitik.org/feed/",
    "https://www.derstandard.at/rss/web",
    "https://rss.golem.de/rss.php?tp=oss&feed=ATOM1.0",
    "https://www.golem.de/rss.php?feed=RSS2.0",
    // Unsupported sections fall through instead of mapping to the main feed.
    "https://www.bbc.com/sport",
    "https://www.bbc.co.uk/sport/football",
    "https://www.bbc.com/",
    "https://www.bbc.com/news/articles/c0000000",
    "https://www.npr.org/2026/11/10/123/some-story",
    "https://www.nytimes.com/section/sports",
    "https://www.nytimes.com/2026/11/10/science/some-story.html",
    "https://www.spiegel.de/international/",
    "https://www.zeit.de/kultur/index",
    "https://www.zeit.de/wissen",
    "https://www.heise.de/news/Some-Story-123.html",
    "https://www.golem.de/news/some-story-2611-1.html",
    // Unsupported subdomains are no match.
    "https://sport.bbc.co.uk/",
    "https://developer.heise.de/",
    "https://blog.tagesschau.de/",
    "https://www.derstandard.de/",
  ])("%s → no publisher match", (url) => {
    expect(resolvePublisherFeeds(new URL(url))).toEqual([]);
  });

  it("explicit NPR World / NYT Science feed URLs are not hijacked by matchSource", () => {
    expect(matchSource("https://feeds.npr.org/1004/rss.xml").feeds.map((f) => f.url)).not.toContain("https://feeds.npr.org/1001/rss.xml");
    expect(matchSource("https://rss.nytimes.com/services/xml/rss/nyt/Science.xml").feeds.map((f) => f.url))
      .not.toContain("https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml");
  });

  it("BBC /sport does not resolve to general news", () => {
    const feeds = matchSource("https://www.bbc.com/sport").feeds.map((f) => f.url);
    expect(feeds).not.toContain("https://feeds.bbci.co.uk/news/rss.xml");
  });

  it("verified sections still map to their own feed", () => {
    expect(resolvePublisherFeeds(new URL("https://www.npr.org/sections/world/"))[0].url).toBe("https://feeds.npr.org/1004/rss.xml");
    expect(resolvePublisherFeeds(new URL("https://www.nytimes.com/section/science"))[0].url).toBe("https://rss.nytimes.com/services/xml/rss/nyt/Science.xml");
    expect(resolvePublisherFeeds(new URL("https://ct.de/"))[0].url).toBe("https://www.heise.de/ct/feed.xml");
  });
});

describe("discoverFeeds publisher fallback", () => {
  it("falls back to HTML discovery when publisher feed validation fails", async () => {
    // Mock: publisher feed probe fails (404), but HTML discovery finds custom feed
    mocks.fetchText.mockImplementation(async (url: string) => {
      if (url === "https://www.tagesschau.de/inland/index~rss2.xml") {
        throw new Error("Fetch failed: 404");
      }
      if (url === "https://www.tagesschau.de/inland") {
        return '<!doctype html><html><head><link rel="alternate" type="application/rss+xml" href="/fallback.xml"></head></html>';
      }
      if (url === "https://www.tagesschau.de/fallback.xml") {
        return '<?xml version="1.0"?><rss version="2.0"><channel><title>Fallback</title></channel></rss>';
      }
      throw new Error("404");
    });

    const result = await discoverFeeds("https://www.tagesschau.de/inland");
    expect(result.feeds.map((f) => f.url)).toContain("https://www.tagesschau.de/fallback.xml");
  });
});
