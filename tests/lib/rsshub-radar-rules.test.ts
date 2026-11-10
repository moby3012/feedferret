import { describe, expect, it } from "vitest";
import { matchRadarRules, RADAR_RULES } from "../../lib/rsshub-radar-rules";

const routes = (url: string) => matchRadarRules(url).map((m) => m.route);

describe("bundled radar rules (data sanity)", () => {
  it("ships a curated subset in the 50–150 range", () => {
    expect(RADAR_RULES.length).toBeGreaterThanOrEqual(50);
    expect(RADAR_RULES.length).toBeLessThanOrEqual(150);
  });

  it("every rule is well-formed and every required target param is captured by each source", () => {
    for (const rule of RADAR_RULES) {
      expect(rule.hosts.length, rule.target).toBeGreaterThan(0);
      expect(rule.target.startsWith("/"), rule.target).toBe(true);
      expect(rule.title, rule.target).toBeTruthy();
      const required = [...rule.target.matchAll(/\/:(\w+)(\?)?/g)].filter((m) => !m[2]).map((m) => m[1]);
      for (const source of rule.source) {
        const provided = new Set([...source.matchAll(/[:*](\w+)/g)].map((m) => m[1]));
        for (const p of required) expect(provided.has(p), `${rule.target} ← ${source}: ${p}`).toBe(true);
      }
    }
  });

  it("has no duplicate (host, target) pairs", () => {
    const keys = RADAR_RULES.map((r) => `${r.hosts[0]}|${r.target}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("matchRadarRules", () => {
  it("GitHub repo → issues, PRs, discussions", () => {
    expect(routes("https://github.com/vercel/next.js")).toEqual([
      "/github/issue/vercel/next.js",
      "/github/pull/vercel/next.js",
      "/github/discussion/vercel/next.js",
    ]);
  });

  it("GitHub user → repos + starred; reserved owner names match nothing", () => {
    expect(routes("https://github.com/torvalds")).toEqual(["/github/repos/torvalds", "/github/starred_repos/torvalds"]);
    expect(routes("https://github.com/settings")).toEqual([]);
  });

  it("GitHub trending + topics (literal segments, optional params dropped)", () => {
    expect(routes("https://github.com/trending")).toEqual(["/github/trending/daily/any"]);
    expect(routes("https://github.com/trending/rust")).toEqual(["/github/trending/daily/rust"]);
    expect(routes("https://github.com/topics/llm")).toEqual(["/github/topics/llm"]);
  });

  it("x.com and twitter.com share rules; site pages are reserved", () => {
    expect(routes("https://x.com/jack")).toEqual(["/twitter/user/jack"]);
    expect(routes("https://twitter.com/jack/media")).toEqual(["/twitter/media/jack"]);
    expect(routes("https://x.com/i/lists/123")).toEqual(["/twitter/list/123"]);
    expect(routes("https://x.com/home")).toEqual([]);
  });

  it("leading www. is ignored on both sides", () => {
    expect(routes("https://www.pixiv.net/users/123")).toEqual(["/pixiv/user/123"]);
    expect(routes("https://pixiv.net/users/123")).toEqual(["/pixiv/user/123"]);
  });

  it("t.me with and without /s/", () => {
    expect(routes("https://t.me/s/durov")).toEqual(["/telegram/channel/durov"]);
    expect(routes("https://t.me/durov")).toEqual(["/telegram/channel/durov"]);
    expect(routes("https://t.me/joinchat")).toEqual([]);
  });

  it("per-param constraints (TikTok users start with @)", () => {
    expect(routes("https://www.tiktok.com/@scout2015")).toEqual(["/tiktok/user/@scout2015"]);
    expect(routes("https://www.tiktok.com/foryou")).toEqual([]);
  });

  it("query-string sources (Google Play ?id=)", () => {
    expect(routes("https://play.google.com/store/apps/details?id=com.spotify.music")).toEqual(["/google/play/com.spotify.music"]);
    expect(routes("https://play.google.com/store/apps/details")).toEqual([]);
  });

  it("subdomain-scoped rules (anthropic www, claude code)", () => {
    expect(routes("https://www.anthropic.com/news")).toEqual(["/anthropic/news"]);
    expect(routes("https://code.claude.com/docs/en/changelog")).toEqual(["/claude/code/changelog"]);
  });

  it("scoped npm packages are not mis-split; no match for unknown hosts or bad input", () => {
    expect(routes("https://www.npmjs.com/package/react")).toEqual(["/npm/package/react"]);
    expect(routes("https://example.com/whatever")).toEqual([]);
    expect(matchRadarRules("not a url")).toEqual([]);
    expect(matchRadarRules("ftp://github.com/a/b")).toEqual([]);
  });

  it("de-duplicates routes and accepts a URL instance", () => {
    const r = matchRadarRules(new URL("https://github.com/a/b"));
    expect(new Set(r.map((x) => x.route)).size).toBe(r.length);
  });
});
