import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectSoftware,
  detectSoftwareFeeds,
  ADAPTER_SELECTORS,
  expandTemplate,
  matchPlatformAdapters,
  rsshubOnlyPlatform,
  scanForAdapters,
} from "../../lib/feed-adapters/engine";
import { compileSelector } from "../../lib/html-scan";
import { PLATFORM_ADAPTERS, SOFTWARE_ADAPTERS } from "../../lib/feed-adapters/registry";
import { matchRadarRules } from "../../lib/rsshub-radar-rules";

/**
 * Per-entry tests for the adapter registry (lib/feed-adapters/registry.ts):
 * URL patterns for platform adapters, synthetic page snapshots
 * (tests/fixtures/adapters) for software adapters. Pure — no network.
 */

const fixture = (name: string) => readFileSync(path.join(__dirname, "../fixtures/adapters", `${name}.html`), "utf8");
const urls = (list: Array<{ url: string }>) => list.map((c) => c.url);
/** The page as discovery sees it: one linear scan (lib/html-scan.ts), same call as lib/feed-discovery.ts. */
const pageOf = (html: string, url: string, headers?: Record<string, string>) => ({
  scan: scanForAdapters(html),
  headers: headers ? new Headers(headers) : null,
  url: new URL(url),
});

type PlatformCase = { adapter: string; url: string; expect: string[] };

const PLATFORM_CASES: PlatformCase[] = [
  {
    adapter: "dbolical",
    url: "https://www.moddb.com/mods/mental-omega",
    expect: ["https://rss.moddb.com/mods/mental-omega/articles/feed/rss.xml", "https://rss.moddb.com/mods/mental-omega/downloads/feed/rss.xml"],
  },
  {
    adapter: "dbolical",
    url: "https://www.moddb.com/mods/mental-omega/news",
    expect: ["https://rss.moddb.com/mods/mental-omega/articles/feed/rss.xml", "https://rss.moddb.com/mods/mental-omega/downloads/feed/rss.xml"],
  },
  {
    adapter: "dbolical",
    url: "https://www.moddb.com/games/cc-red-alert-2/downloads",
    expect: ["https://rss.moddb.com/games/cc-red-alert-2/downloads/feed/rss.xml", "https://rss.moddb.com/games/cc-red-alert-2/articles/feed/rss.xml"],
  },
  {
    adapter: "dbolical",
    url: "https://www.indiedb.com/games/cortex-command",
    expect: ["https://rss.indiedb.com/games/cortex-command/articles/feed/rss.xml", "https://rss.indiedb.com/games/cortex-command/downloads/feed/rss.xml"],
  },
  { adapter: "dbolical", url: "https://www.moddb.com/", expect: ["https://rss.moddb.com/news/feed/rss.xml"] },
  {
    adapter: "nexusmods",
    url: "https://www.nexusmods.com/skyrimspecialedition/mods/30379",
    expect: ["https://www.nexusmods.com/skyrimspecialedition/rss/newtoday/", "https://www.nexusmods.com/skyrimspecialedition/rss/updatedtoday/"],
  },
  {
    adapter: "nexusmods",
    url: "https://www.nexusmods.com/games/stardewvalley",
    expect: ["https://www.nexusmods.com/stardewvalley/rss/newtoday/", "https://www.nexusmods.com/stardewvalley/rss/updatedtoday/"],
  },
  {
    adapter: "gamebanana",
    url: "https://gamebanana.com/games/4254",
    expect: ["https://api.gamebanana.com/Rss/New?gameid=4254", "https://api.gamebanana.com/Rss/Featured?gameid=4254"],
  },
  { adapter: "steam-community", url: "https://steamcommunity.com/groups/cncnet", expect: ["https://steamcommunity.com/groups/cncnet/rss/"] },
  { adapter: "steam-community", url: "https://steamcommunity.com/games/1213210/announcements", expect: ["https://steamcommunity.com/games/1213210/rss/"] },
];

const PLATFORM_NON_MATCHES = [
  "https://www.nexusmods.com/users/12345",
  "https://www.nexusmods.com/",
  // Nexus Mods' own site sections are not games.
  "https://www.nexusmods.com/login",
  "https://www.nexusmods.com/search?q=x",
  "https://www.nexusmods.com/premium",
  "https://www.nexusmods.com/games",
  "https://www.nexusmods.com/games/",
  "https://www.nexusmods.com/news/12345",
  // Host confusion: only the real registrable domain (and its subdomains) match.
  "https://moddb.com.evil.com/mods/mental-omega",
  "https://evil.com/moddb.com/mods/mental-omega",
  "https://moddb.com@evil.com/mods/mental-omega",
  "https://notmoddb.com/mods/mental-omega",
  "https://www.notindiedb.com/games/x",
  "https://moddb.evil.com/mods/mental-omega",
  "https://gamebanana.com/news",
  "https://steamcommunity.com/app/1213210", // store/app hub: smart-url-resolver's Steam rule
  "https://www.moddb.com/search?q=x",
  "https://example.com/mods/mental-omega", // same path, other host
];

type SoftwareCase = { adapter: string; fixture: string; pageUrl: string; headers?: Record<string, string>; expect: string[] };

const SOFTWARE_CASES: SoftwareCase[] = [
  {
    adapter: "discourse",
    fixture: "discourse-subfolder",
    pageUrl: "https://forums.example.com/en/wow/",
    expect: ["https://forums.example.com/en/wow/latest.rss"],
  },
  {
    // Blue-post tracker style: a group's posts page in a sub-folder install.
    adapter: "discourse",
    fixture: "discourse-subfolder",
    pageUrl: "https://forums.example.com/en/wow/groups/blizzard-tracker/posts",
    expect: ["https://forums.example.com/en/wow/groups/blizzard-tracker/posts.rss", "https://forums.example.com/en/wow/latest.rss"],
  },
  {
    adapter: "discourse",
    fixture: "discourse-root",
    pageUrl: "https://meta.example.org/c/news-and-events/announcements/67",
    expect: ["https://meta.example.org/c/news-and-events/announcements/67.rss", "https://meta.example.org/latest.rss"],
  },
  {
    adapter: "discourse",
    fixture: "discourse-root",
    pageUrl: "https://meta.example.org/t/some-topic/123/4",
    expect: ["https://meta.example.org/t/some-topic/123.rss", "https://meta.example.org/latest.rss"],
  },
  {
    adapter: "phpbb",
    fixture: "phpbb",
    pageUrl: "https://forum.example.com/community/viewforum.php?f=2&sid=abc",
    expect: [
      "https://forum.example.com/community/app.php/feed/forum/2",
      "https://forum.example.com/community/feed.php?f=2",
      "https://forum.example.com/community/app.php/feed",
      "https://forum.example.com/community/app.php/feed/topics",
    ],
  },
  {
    adapter: "phpbb",
    fixture: "phpbb",
    pageUrl: "https://ppm.example.com/",
    expect: ["https://ppm.example.com/app.php/feed", "https://ppm.example.com/app.php/feed/topics", "https://ppm.example.com/feed.php"],
  },
  {
    adapter: "xenforo",
    fixture: "xenforo",
    pageUrl: "https://xf.example.com/community/forums/announcements.2/",
    expect: ["https://xf.example.com/community/forums/announcements.2/index.rss", "https://xf.example.com/community/forums/-/index.rss"],
  },
  {
    adapter: "xenforo",
    fixture: "xenforo",
    pageUrl: "https://xf.example.com/community/",
    expect: ["https://xf.example.com/community/forums/-/index.rss"],
  },
  {
    adapter: "vbulletin",
    fixture: "vbulletin",
    pageUrl: "https://vb.example.com/forum/forumdisplay.php?f=12",
    expect: [
      "https://vb.example.com/forum/external.php?type=RSS2&forumids=12",
      "https://vb.example.com/forum/external.php?type=RSS2",
      "https://vb.example.com/forum/external?type=rss2",
    ],
  },
  {
    adapter: "invision",
    fixture: "invision",
    pageUrl: "https://community.example.org/forums/forum/2-general/",
    expect: ["https://community.example.org/forums/forum/2-general.xml/", "https://community.example.org/forums/discover/all.xml/"],
  },
  {
    adapter: "flarum",
    fixture: "flarum",
    pageUrl: "https://discuss.example.org/d/123-hello-world",
    expect: ["https://discuss.example.org/atom/d/123", "https://discuss.example.org/atom", "https://discuss.example.org/rss"],
  },
  {
    adapter: "nodebb",
    fixture: "nodebb",
    pageUrl: "https://community.example.org/category/1/announcements",
    expect: ["https://community.example.org/category/1.rss", "https://community.example.org/recent.rss"],
  },
  {
    // Detected from the response header alone.
    adapter: "nodebb",
    fixture: "plain",
    headers: { "x-powered-by": "NodeBB" },
    pageUrl: "https://bb.example.org/topic/42/some-thread",
    expect: ["https://bb.example.org/topic/42.rss", "https://bb.example.org/recent.rss"],
  },
  {
    adapter: "mybb",
    fixture: "mybb",
    pageUrl: "https://mybb.example.com/forumdisplay.php?fid=3",
    expect: ["https://mybb.example.com/syndication.php?fid=3", "https://mybb.example.com/syndication.php"],
  },
  {
    adapter: "smf",
    fixture: "smf",
    pageUrl: "https://forum.example.net/index.php",
    expect: ["https://forum.example.net/index.php?action=.xml;type=rss2"],
  },
  {
    adapter: "wordpress",
    fixture: "wordpress",
    pageUrl: "https://blog.example.de/news/category/modding/",
    expect: ["https://blog.example.de/news/category/modding/feed/", "https://blog.example.de/news/feed/"],
  },
  {
    // A post page: the install base comes from the api.w.org link, never the post's own path.
    adapter: "wordpress",
    fixture: "wordpress",
    pageUrl: "https://blog.example.de/news/2026/11/hallo/",
    expect: ["https://blog.example.de/news/feed/"],
  },
  {
    adapter: "ghost",
    fixture: "ghost",
    pageUrl: "https://ghost.example.com/tag/engineering/",
    expect: ["https://ghost.example.com/tag/engineering/rss/", "https://ghost.example.com/rss/"],
  },
  { adapter: "substack", fixture: "substack", pageUrl: "https://letter.example.com/p/first-post", expect: ["https://letter.example.com/feed"] },
  {
    adapter: "blogger",
    fixture: "blogger",
    pageUrl: "https://notes.example.com/search/label/maps",
    expect: ["https://notes.example.com/feeds/posts/default/-/maps", "https://notes.example.com/feeds/posts/default"],
  },
  {
    adapter: "mediawiki",
    fixture: "mediawiki",
    pageUrl: "https://wiki.example.org/wiki/Main_Page",
    expect: ["https://wiki.example.org/w/index.php?title=Special:RecentChanges&feed=atom"],
  },
];

describe("registry coverage guard", () => {
  it("every platform adapter has at least one URL case", () => {
    const covered = new Set(PLATFORM_CASES.map((c) => c.adapter));
    for (const a of PLATFORM_ADAPTERS) expect(covered.has(a.id), `no test case for platform adapter "${a.id}"`).toBe(true);
  });

  it("every software adapter has at least one page fixture case", () => {
    const covered = new Set(SOFTWARE_CASES.map((c) => c.adapter));
    for (const a of SOFTWARE_ADAPTERS) expect(covered.has(a.id), `no test case for software adapter "${a.id}"`).toBe(true);
  });

  it("ids are unique and every template uses known placeholders only", () => {
    const ids = [...PLATFORM_ADAPTERS, ...SOFTWARE_ADAPTERS].map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    const templates = [
      ...PLATFORM_ADAPTERS.flatMap((a) => a.routes.flatMap((r) => r.feeds)),
      ...SOFTWARE_ADAPTERS.flatMap((a) => [...a.routes.flatMap((r) => r.feeds), ...a.site]),
    ];
    for (const t of templates) {
      expect(t.url.replace(/\{(?:origin|base|domain|\$\d|\?[\w-]+)\}/g, ""), t.url).not.toMatch(/[{}]/);
    }
    // Platform adapters never build URLs from the page origin: their endpoints are on the platform's own hosts.
    for (const a of PLATFORM_ADAPTERS) {
      for (const t of a.routes.flatMap((r) => r.feeds)) expect(t.url, a.id).not.toMatch(/\{(?:origin|base)\}/);
    }
  });
});

describe("platform adapters (URL patterns)", () => {
  it.each(PLATFORM_CASES)("$adapter: $url", ({ adapter, url, expect: expected }) => {
    const got = matchPlatformAdapters(new URL(url));
    expect(urls(got)).toEqual(expected);
    expect(got.every((c) => c.adapterId === adapter && c.scope === "route")).toBe(true);
    expect(got[0].via.family).toBe("platform");
  });

  it.each(PLATFORM_NON_MATCHES)("no candidates for %s", (url) => {
    expect(matchPlatformAdapters(new URL(url))).toEqual([]);
  });
});

describe("software adapters (page fixtures)", () => {
  it.each(SOFTWARE_CASES)("$adapter: $pageUrl ($fixture)", ({ adapter, fixture: name, pageUrl, headers, expect: expected }) => {
    const page = pageOf(fixture(name), pageUrl, headers);
    expect(detectSoftware(page).map((a) => a.id)).toEqual([adapter]);
    const got = detectSoftwareFeeds(page);
    expect(urls(got)).toEqual(expected);
    expect(got.every((c) => c.adapterId === adapter)).toBe(true);
    // Never leaves the page's origin.
    for (const c of got) expect(new URL(c.url).origin).toBe(new URL(pageUrl).origin);
  });

  it("a page that only mentions forum software is not detected as any of them", () => {
    const page = pageOf(fixture("plain"), "https://example.org/about");
    expect(detectSoftware(page)).toEqual([]);
    expect(detectSoftwareFeeds(page)).toEqual([]);
  });

  it("a cross-origin install base (CDN) is ignored in favour of the path heuristic", () => {
    const html = fixture("discourse-subfolder").replace('data-base-uri="/en/wow"', 'data-base-uri="https://cdn.example.net/x"');
    const got = detectSoftwareFeeds(pageOf(html, "https://forums.example.com/en/wow/latest"));
    expect(urls(got)).toEqual(["https://forums.example.com/en/wow/latest.rss"]);
  });

  it("phpBB route feeds are skipped when the id parameter is missing or not a plain token", () => {
    const html = fixture("phpbb");
    expect(urls(detectSoftwareFeeds(pageOf(html, "https://f.example.com/viewforum.php")))).toEqual([
      "https://f.example.com/app.php/feed",
      "https://f.example.com/app.php/feed/topics",
      "https://f.example.com/feed.php",
    ]);
    expect(urls(detectSoftwareFeeds(pageOf(html, "https://f.example.com/viewforum.php?f=2%2F..%2Fx")))).not.toContain(
      "https://f.example.com/app.php/feed/forum/2/../x",
    );
  });

  it("candidate titles name the software", () => {
    const [first] = detectSoftwareFeeds(pageOf(fixture("xenforo"), "https://xf.example.com/community/"));
    expect(first).toMatchObject({ title: "XenForo · latest threads", kind: "latest", via: { family: "forum", name: "XenForo" }, scope: "site" });
  });
});

describe("engine helpers", () => {
  it("the scan reads every generator meta, any attribute order / quoting / case", () => {
    expect(scanForAdapters(`<meta content='blogger' name='generator'/><meta name="Generator" content="WordPress 6.6">`).generators).toEqual([
      "blogger",
      "WordPress 6.6",
    ]);
  });

  it("every registry selector is in the supported simple-selector subset", () => {
    for (const sel of ADAPTER_SELECTORS) expect(() => compileSelector(sel), sel).not.toThrow();
    expect(() => compileSelector("div > a")).toThrow();
  });

  it("expandTemplate refuses non-http results and missing values", () => {
    const ctx = { origin: "https://a.example", base: "https://a.example/f", domain: "a.example", groups: ["x", "1"], query: new URLSearchParams("f=2") };
    expect(expandTemplate("{base}/feed/{$1}?f={?f}", ctx)).toBe("https://a.example/f/feed/1?f=2");
    expect(expandTemplate("{base}/feed/{$2}", ctx)).toBeNull();
    expect(expandTemplate("{base}/feed?t={?t}", ctx)).toBeNull();
    expect(expandTemplate("javascript:{$1}", ctx)).toBeNull();
  });
});

describe("RSSHub-only platforms", () => {
  it.each([
    ["https://x.com/EA", "X/Twitter"],
    ["https://twitter.com/EA", "X/Twitter"],
    ["https://www.facebook.com/EA", "Facebook"],
    ["https://www.instagram.com/ea/", "Instagram"],
    ["https://www.tiktok.com/@ea", "TikTok"],
    ["https://news.blizzard.com/en-us", "Blizzard News"],
  ])("%s → %s, with a radar route", (url, name) => {
    expect(rsshubOnlyPlatform(new URL(url))).toBe(name);
    expect(matchRadarRules(url).length).toBeGreaterThan(0);
  });

  it("radar routes for the new Instagram / Blizzard rules", () => {
    expect(matchRadarRules("https://www.instagram.com/ea/")).toEqual([{ route: "/instagram/user/ea", title: "Profile" }]);
    expect(matchRadarRules("https://www.instagram.com/p/abc123/")).toEqual([]);
    expect(matchRadarRules("https://news.blizzard.com/en-us")).toEqual([{ route: "/blizzard/news/en-us", title: "News" }]);
    expect(matchRadarRules("https://news.blizzard.com/en-us/world-of-warcraft")).toEqual([
      { route: "/blizzard/news/en-us/world-of-warcraft", title: "News" },
    ]);
  });

  it("other hosts are not RSSHub-only", () => {
    expect(rsshubOnlyPlatform(new URL("https://www.reddit.com/r/x"))).toBeNull();
  });
});

describe("host matching", () => {
  it("a trailing root dot is the same host and still builds the canonical endpoint", () => {
    expect(urls(matchPlatformAdapters(new URL("https://www.moddb.com./mods/mental-omega")))).toEqual([
      "https://rss.moddb.com/mods/mental-omega/articles/feed/rss.xml",
      "https://rss.moddb.com/mods/mental-omega/downloads/feed/rss.xml",
    ]);
  });

  it("endpoints are always on the platform's own domain, whatever the page host looked like", () => {
    for (const raw of ["https://sub.moddb.com/mods/x", "https://WWW.MODDB.COM/mods/x"]) {
      for (const c of matchPlatformAdapters(new URL(raw))) expect(new URL(c.url).hostname).toBe("rss.moddb.com");
    }
  });
});

describe("hostile pages (ReDoS guard: detection must stay linear on attacker HTML)", () => {
  const timed = (fn: () => void) => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };
  // Scan + detection, timed together (what discovery runs per page).
  const run = (html: string, url = "https://evil.example/forum/") =>
    timed(() => {
      const page = pageOf(html, url);
      detectSoftwareFeeds(page);
      for (const a of SOFTWARE_ADAPTERS) detectSoftware(page, [a]);
    });

  it.each([
    ["unterminated <meta ×100k", "<meta ".repeat(100_000)],
    ["api.w.org link prefix ×100k", '<link rel="https://api.w.org/" '.repeat(100_000)],
    ["unterminated <html / <body attributes", `<html ${"x ".repeat(100_000)}`],
    ["generator meta with a huge content value", `<meta name="generator" content="${"WordPress ".repeat(50_000)}">`],
    ["inline script full of near-miss base keys", `<body class="ipsApp"><script>${'baseURL: "'.repeat(50_000)}"relative_path":"${'"baseUrl": '.repeat(20_000)}</script>`],
  ])("%s completes in < 200 ms", (_label, html) => {
    expect(run(html)).toBeLessThan(200);
  });

  it("base-path script patterns are bounded (start with a literal, no unbounded quantifiers)", () => {
    for (const a of SOFTWARE_ADAPTERS) {
      for (const re of a.base?.script ?? []) {
        expect(re.source, a.id).not.toMatch(/(?<!\\)[*+](?!\?)/);
        expect(re.source, a.id).toMatch(/^["\w]/);
      }
    }
  });
});
