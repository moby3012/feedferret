// Curated, declarative subset of RSSHub Radar rules.
//
// Source: https://github.com/DIYgod/RSSHub — the radar rules published at
// https://rsshub.js.org/build/radar-rules.json.
//
//   RSSHub — Copyright (C) DIYgod and RSSHub contributors.
//   Licensed under the GNU Affero General Public License v3.0
//   (https://github.com/DIYgod/RSSHub/blob/master/LICENSE). FeedFerret is
//   also AGPL-3.0, so this derived data is distributed under the same terms.
//
// Local deviations from upstream rules: Mixcloud `/:username` (upstream
// `/:username/:type`), Twitch `/:login` and t.me `/:username` sources.
//
// Only high-value rules with a plain-string `target` are bundled (generated
// from the upstream JSON and checked against it at generation time; titles,
// `reserved` first-path-segments and `where` param constraints are local
// additions so `/:user`-style sources don't match site pages like /settings).
// Format (per rule):
//   hosts    exact host names the rule applies to (a leading "www." is ignored)
//   source   path patterns — `:param`, `:param?` (optional), `*rest`; an optional
//            `?key=:param` query part (e.g. Google Play's `?id=:id`)
//   target   RSSHub route path, `:param` placeholders filled from the match
//   reserved first-segment values that must NOT match (site pages, not users)
//   where    per-param regex constraints
//
// Rules are evaluated in-process (<1 ms) by `matchRadarRules`; `lib/rsshub.ts`
// consults them before asking an LLM to propose a route, and only when an
// RSSHub instance is configured. Routes are always validated against that
// instance before a feed is created, so a stale rule can never create a dead feed.

export type RadarRule = {
  hosts: string[];
  title: string;
  source: string[];
  target: string;
  reserved?: string[];
  where?: Record<string, string>;
};

export const RADAR_RULES: RadarRule[] = [
  { hosts: ["github.com"], title: "Issues", source: ["/:user/:repo/issues","/:user/:repo/issues/:id","/:user/:repo"], target: "/github/issue/:user/:repo", reserved: ["about","account","apps","collections","contact","customer-stories","enterprise","events","explore","features","issues","login","logout","marketplace","new","notifications","orgs","organizations","pricing","pulls","search","security","sessions","settings","signup","sponsors","topics","trending","users","codespaces","copilot","discussions","gist","readme","resources","solutions","team","premium-support"] },
  { hosts: ["github.com"], title: "Pull requests", source: ["/:user/:repo/pulls","/:user/:repo/pulls/:id","/:user/:repo"], target: "/github/pull/:user/:repo", reserved: ["about","account","apps","collections","contact","customer-stories","enterprise","events","explore","features","issues","login","logout","marketplace","new","notifications","orgs","organizations","pricing","pulls","search","security","sessions","settings","signup","sponsors","topics","trending","users","codespaces","copilot","discussions","gist","readme","resources","solutions","team","premium-support"] },
  { hosts: ["github.com"], title: "Discussions", source: ["/:user/:repo/discussions","/:user/:repo/discussions/:id","/:user/:repo"], target: "/github/discussion/:user/:repo", reserved: ["about","account","apps","collections","contact","customer-stories","enterprise","events","explore","features","issues","login","logout","marketplace","new","notifications","orgs","organizations","pricing","pulls","search","security","sessions","settings","signup","sponsors","topics","trending","users","codespaces","copilot","discussions","gist","readme","resources","solutions","team","premium-support"] },
  { hosts: ["github.com"], title: "New repositories", source: ["/:user"], target: "/github/repos/:user/:type?/:sort?", reserved: ["about","account","apps","collections","contact","customer-stories","enterprise","events","explore","features","issues","login","logout","marketplace","new","notifications","orgs","organizations","pricing","pulls","search","security","sessions","settings","signup","sponsors","topics","trending","users","codespaces","copilot","discussions","gist","readme","resources","solutions","team","premium-support"] },
  { hosts: ["github.com"], title: "Starred repositories", source: ["/:user"], target: "/github/starred_repos/:user", reserved: ["about","account","apps","collections","contact","customer-stories","enterprise","events","explore","features","issues","login","logout","marketplace","new","notifications","orgs","organizations","pricing","pulls","search","security","sessions","settings","signup","sponsors","topics","trending","users","codespaces","copilot","discussions","gist","readme","resources","solutions","team","premium-support"] },
  { hosts: ["github.com"], title: "Trending today", source: ["/trending"], target: "/github/trending/daily/any" },
  { hosts: ["github.com"], title: "Trending today by language", source: ["/trending/:language"], target: "/github/trending/daily/:language" },
  { hosts: ["github.com"], title: "Topic", source: ["/topics/:name"], target: "/github/topics/:name/:qs?" },
  { hosts: ["bitbucket.org"], title: "Commits", source: ["/:workspace/:repo_slug/commits"], target: "/bitbucket/commits/:workspace/:repo_slug" },
  { hosts: ["gitee.com"], title: "Releases", source: ["/:owner/:repo/releases"], target: "/gitee/releases/:owner/:repo" },
  { hosts: ["gitee.com"], title: "Commits", source: ["/:owner/:repo/commits"], target: "/gitee/commits/:owner/:repo" },
  { hosts: ["www.npmjs.com"], title: "Package versions", source: ["/package/:name"], target: "/npm/package/:name" },
  { hosts: ["f-droid.org"], title: "App releases", source: ["/en/packages/:app/"], target: "/f-droid/apprelease/:app" },
  { hosts: ["hackerone.com"], title: "Hacktivity", source: ["/hacktivity"], target: "/hackerone/hacktivity" },
  { hosts: ["www.codeforces.com"], title: "Contests", source: ["/contests"], target: "/codeforces/contests" },
  { hosts: ["codeforces.com"], title: "Recent actions", source: ["/recent-actions"], target: "/codeforces/recent-actions" },
  { hosts: ["daily.dev"], title: "Popular", source: ["/posts","/popular"], target: "/daily/popular" },
  { hosts: ["dev.to"], title: "Top posts", source: ["/top/:period"], target: "/dev.to/top/:period" },
  { hosts: ["civitai.com"], title: "Latest models", source: ["/"], target: "/civitai/models" },
  { hosts: ["huggingface.co"], title: "Blog", source: ["/blog","/"], target: "/huggingface/blog" },
  { hosts: ["huggingface.co"], title: "Daily papers", source: ["/papers/:cycle"], target: "/huggingface/daily-papers/:cycle" },
  { hosts: ["huggingface.co"], title: "Models", source: ["/:group/models"], target: "/huggingface/models/:group" },
  { hosts: ["huggingface.co"], title: "Posts", source: ["/:user/activity/posts"], target: "/huggingface/activity/:user/posts" },
  { hosts: ["www.anthropic.com"], title: "News", source: ["/news","/"], target: "/anthropic/news" },
  { hosts: ["www.anthropic.com"], title: "Research", source: ["/research","/"], target: "/anthropic/research" },
  { hosts: ["www.anthropic.com"], title: "Engineering", source: ["/engineering","/"], target: "/anthropic/engineering" },
  { hosts: ["claude.com"], title: "Blog", source: ["/blog","/resources/articles"], target: "/claude/blog" },
  { hosts: ["code.claude.com"], title: "Claude Code changelog", source: ["/docs/en/changelog"], target: "/claude/code/changelog" },
  { hosts: ["cursor.com"], title: "Changelog", source: ["/changelog"], target: "/cursor/changelog" },
  { hosts: ["cursor.com"], title: "Blog", source: ["/blog"], target: "/cursor/blog" },
  { hosts: ["deepmind.google"], title: "Blog", source: ["/blog","/blog/:slug","/"], target: "/deepmind/blog" },
  { hosts: ["cohere.com"], title: "Blog", source: ["/"], target: "/cohere/blog" },
  { hosts: ["www.deeplearning.ai"], title: "The Batch", source: ["/the-batch/"], target: "/deeplearning/the-batch" },
  { hosts: ["www.technologyreview.com"], title: "Topic", source: ["/topic/:category_name"], target: "/technologyreview/:category_name" },
  { hosts: ["the-decoder.com"], title: "News", source: ["/","/artificial-intelligence-news/"], target: "/the-decoder/news" },
  { hosts: ["postman.com"], title: "Release notes", source: ["/downloads/release-notes","/"], target: "/postman/release-notes" },
  { hosts: ["brave.com"], title: "Release notes", source: ["/latest","/"], target: "/brave/latest" },
  { hosts: ["nodejs.org"], title: "Blog", source: ["/:language/blog","/"], target: "/nodejs/blog/:language?" },
  { hosts: ["www.gitkraken.com"], title: "Release notes", source: ["/"], target: "/gitkraken/release-note" },
  { hosts: ["source.android.com"], title: "Security bulletins", source: ["/docs/security/bulletin","/docs/security/bulletin/asb-overview","/"], target: "/android/security-bulletin" },
  { hosts: ["source.android.com"], title: "Pixel update bulletins", source: ["/docs/security/bulletin/pixel","/"], target: "/android/pixel-update-bulletin" },
  { hosts: ["x.com","twitter.com"], title: "Timeline", source: ["/:id"], target: "/twitter/user/:id", reserved: ["home","search","explore","notifications","messages","i","settings","compose","hashtag","login","signup","tos","privacy","intent","share"] },
  { hosts: ["x.com","twitter.com"], title: "Media", source: ["/:id/media"], target: "/twitter/media/:id", reserved: ["home","search","explore","notifications","messages","i","settings","compose","hashtag","login"] },
  { hosts: ["x.com","twitter.com"], title: "List", source: ["/i/lists/:id"], target: "/twitter/list/:id" },
  { hosts: ["t.me"], title: "Channel", source: ["/s/:username","/:username"], target: "/telegram/channel/:username", reserved: ["joinchat","addstickers","addemoji","proxy","socks","share","login","iv"], where: {"username":"^(?!s$)"} },
  { hosts: ["telegram.org"], title: "Blog", source: ["/blog"], target: "/telegram/blog" },
  { hosts: ["www.twitch.tv"], title: "Videos", source: ["/:login/videos","/:login"], target: "/twitch/video/:login", reserved: ["directory","downloads","jobs","turbo","settings","subscriptions","inventory","wallet","friends","videos","p"] },
  { hosts: ["www.twitch.tv"], title: "Stream schedule", source: ["/:login/schedule"], target: "/twitch/schedule/:login" },
  { hosts: ["www.tiktok.com"], title: "User", source: ["/:user"], target: "/tiktok/user/:user", where: {"user":"^@"} },
  { hosts: ["www.pinterest.com"], title: "User pins", source: ["/:username"], target: "/pinterest/user/:username", reserved: ["pin","ideas","search","today","business","settings","login","news_hub","_"] },
  { hosts: ["bandcamp.com"], title: "Tag", source: ["/tag/:tag","/discover/:tag"], target: "/bandcamp/tag/:tag" },
  { hosts: ["daily.bandcamp.com"], title: "Bandcamp Daily", source: ["/latest"], target: "/bandcamp/daily" },
  { hosts: ["vimeo.com"], title: "Channel", source: ["/channels/:channel","/channels/:channel/videos","/channels/:channel/videos/:sort/:format","/channels/:channel/videos/:page/:sort/:format"], target: "/vimeo/channel/:channel" },
  { hosts: ["www.pixiv.net"], title: "User", source: ["/users/:id","/en/users/:id"], target: "/pixiv/user/:id" },
  { hosts: ["patreon.com"], title: "Creator posts", source: ["/:creator","/cw/:creator"], target: "/patreon/:creator", reserved: ["home","login","signup","c","user","explore","pricing","about","policy","product","apps","posts","join","settings"] },
  { hosts: ["www.facebook.com"], title: "Page", source: ["/:id","/people/:name/:id"], target: "/facebook/page/:id", reserved: ["groups","watch","marketplace","events","gaming","pages","people","photo","photos","reel","reels","stories","login","help","policies","share","sharer","dialog","hashtag","profile.php","story.php","permalink.php","friends","bookmarks","settings","public","login.php","business","ads","plugins"] },
  { hosts: ["www.facebook.com"], title: "Group", source: ["/groups/:id"], target: "/facebook/group/:id" },
  { hosts: ["dribbble.com"], title: "User shots", source: ["/:name"], target: "/dribbble/user/:name", reserved: ["shots","designers","tags","jobs","stories","following","pro","search","teams","hiring","learn","session","signup","about","colors","following","podcast","places"] },
  { hosts: ["dribbble.com"], title: "Popular", source: ["/"], target: "/dribbble/popular" },
  { hosts: ["www.artstation.com"], title: "Portfolio", source: ["/:handle"], target: "/artstation/:handle", reserved: ["artwork","marketplace","learning","jobs","blogs","contests","channels","search","prints","magazine","sessions","users","about","studios","contact","terms","privacy","pro"] },
  { hosts: ["www.producthunt.com"], title: "Launches today", source: ["/"], target: "/producthunt/today" },
  { hosts: ["open.spotify.com"], title: "Artist albums", source: ["/artist/:id"], target: "/spotify/artist/:id" },
  { hosts: ["open.spotify.com"], title: "Playlist", source: ["/playlist/:id"], target: "/spotify/playlist/:id" },
  { hosts: ["open.spotify.com"], title: "Podcast", source: ["/show/:id"], target: "/spotify/show/:id" },
  { hosts: ["rumble.com"], title: "Channel", source: ["/c/:channel","/c/:channel/videos"], target: "/rumble/c/:channel" },
  { hosts: ["castbox.fm"], title: "Podcast", source: ["/channel/:channel"], target: "/castbox/channel/:channel" },
  { hosts: ["www.mixcloud.com"], title: "User", source: ["/:username"], target: "/mixcloud/:username/:type?", reserved: ["discover","upload","pro","settings","select","categories","about","blog","dashboard"] },
  { hosts: ["www.nicovideo.jp"], title: "User videos", source: ["/user/:id","/user/:id/video"], target: "/nicovideo/user/:id/video" },
  { hosts: ["mangadex.org"], title: "Manga chapters", source: ["/title/:id/:suffix","/title/:id"], target: "/mangadex/manga/:id" },
  { hosts: ["store.epicgames.com"], title: "Free games", source: ["/:locale/free-games"], target: "/epicgames/freegames/:locale" },
  { hosts: ["play.google.com"], title: "Play Store updates", source: ["/store/apps/details?id=:id"], target: "/google/play/:id/:lang?" },
  { hosts: ["chromewebstore.google.com"], title: "Chrome extension updates", source: ["/detail/:name/:id"], target: "/google/chrome/extension/:id" },
  { hosts: ["apps.apple.com"], title: "App Store updates", source: ["/:country/app/:appSlug/:id","/:country/app/:id"], target: "/apple/apps/update/:country/:id" },
  { hosts: ["addons.mozilla.org"], title: "Firefox add-on updates", source: ["/:lang/firefox/addon/:id/versions","/:lang/firefox/addon/:id"], target: "/firefox/addons/:id" },
  { hosts: ["microsoftedge.microsoft.com"], title: "Edge add-on updates", source: ["/addons/detail/:name/:crxid"], target: "/microsoft/edge/addon/:crxid" },
  { hosts: ["www.bbc.com"], title: "Topic", source: ["/news/topics/:topic"], target: "/bbc/topics/:topic" },
  { hosts: ["apnews.com"], title: "Topic", source: ["/hub/:topic"], target: "/apnews/topics/:topic" },
  { hosts: ["nature.com"], title: "News", source: ["/latest-news","/news","/"], target: "/nature/news" },
  { hosts: ["nature.com"], title: "Research", source: ["/:journal/research-articles","/"], target: "/nature/research/:journal?" },
  { hosts: ["en.wikipedia.org"], title: "Current events", source: ["/wiki/Portal:Current_events"], target: "/wikipedia/current-events" },
  { hosts: ["www.wired.com"], title: "Tag", source: ["/tag/:tag/"], target: "/wired/tag/:tag" },
  { hosts: ["theverge.com"], title: "Hub", source: ["/:hub"], target: "/theverge/:hub?" },
  { hosts: ["www.eurogamer.net"], title: "Category", source: ["/:category"], target: "/eurogamer/:category" },
  { hosts: ["gigazine.net"], title: "English news", source: ["/gsc_news/en/","/gsc_news/en"], target: "/gigazine/en" },
  { hosts: ["www.engadget.com"], title: "Home", source: ["/"], target: "/engadget/" },
  { hosts: ["inspirehep.net"], title: "Seminars", source: ["/seminars"], target: "/inspirehep/seminars" },
  { hosts: ["space.bilibili.com"], title: "UP uploads", source: ["/:uid"], target: "/bilibili/user/video/:uid" },
  { hosts: ["space.bilibili.com"], title: "UP dynamics", source: ["/:uid"], target: "/bilibili/user/dynamic/:uid" },
  { hosts: ["live.bilibili.com"], title: "Live room", source: ["/:roomID"], target: "/bilibili/live/room/:roomID" },
  { hosts: ["weibo.com"], title: "User posts", source: ["/u/:uid"], target: "/weibo/user/:uid" },
  { hosts: ["www.zhihu.com"], title: "User activity", source: ["/people/:id"], target: "/zhihu/people/activities/:id" },
  { hosts: ["www.zhihu.com"], title: "Collection", source: ["/collection/:id"], target: "/zhihu/collection/:id" },
  { hosts: ["douyin.com"], title: "User", source: ["/user/:uid"], target: "/douyin/user/:uid" },
  { hosts: ["xiaohongshu.com"], title: "User notes", source: ["/user/profile/:user_id"], target: "/xiaohongshu/user/:user_id/notes" },
  { hosts: ["sspai.com"], title: "Author", source: ["/u/:id/posts"], target: "/sspai/author/:id" },
  { hosts: ["www.douban.com"], title: "Group topics", source: ["/group/:groupid"], target: "/douban/group/:groupid" },
];

export type RadarMatch = {
  /** RSSHub route path, e.g. "/github/issue/vercel/next.js". */
  route: string;
  title: string;
};

const stripWww = (host: string) => host.toLowerCase().replace(/^www\./, "");

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Matches one source pattern against a URL; returns captured params or null. */
function matchSource(pattern: string, url: URL): Record<string, string> | null {
  const [pathPattern, queryPattern] = pattern.split("?", 2);
  const patternSegs = pathPattern.split("/").filter(Boolean);
  const urlSegs = url.pathname.split("/").filter(Boolean).map(safeDecode);
  const params: Record<string, string> = {};

  let i = 0;
  for (const seg of patternSegs) {
    if (seg.startsWith("*")) {
      const name = seg.slice(1);
      if (name) params[name] = urlSegs.slice(i).join("/");
      i = urlSegs.length;
      continue;
    }
    if (seg.startsWith(":")) {
      const optional = seg.endsWith("?");
      const name = seg.slice(1, optional ? -1 : undefined);
      if (i >= urlSegs.length) {
        if (optional) continue;
        return null;
      }
      params[name] = urlSegs[i++];
      continue;
    }
    if (i >= urlSegs.length || urlSegs[i].toLowerCase() !== seg.toLowerCase()) return null;
    i++;
  }
  if (i < urlSegs.length) return null;

  if (queryPattern) {
    for (const pair of queryPattern.split("&")) {
      const [key, valuePattern = ""] = pair.split("=", 2);
      const actual = url.searchParams.get(key);
      if (actual === null) return null;
      if (valuePattern.startsWith(":")) params[valuePattern.slice(1)] = actual;
      else if (valuePattern !== actual) return null;
    }
  }
  return params;
}

function fillTarget(target: string, params: Record<string, string>): string | null {
  let missing = false;
  const filled = target.replace(/\/:([A-Za-z_][\w]*)(\?)?/g, (_m, name: string, optional?: string) => {
    const value = params[name];
    if (value === undefined || value === "") {
      if (!optional) missing = true;
      return "";
    }
    return `/${encodeURIComponent(value).replace(/%40/g, "@")}`;
  });
  return missing ? null : filled;
}

/**
 * Deterministic, in-process RSSHub-Radar matching for a pasted URL. Returns the
 * RSSHub route paths that apply (callers build the full URL against the
 * configured instance and validate it). Never throws.
 */
export function matchRadarRules(input: string | URL, rules: RadarRule[] = RADAR_RULES): RadarMatch[] {
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch {
    return [];
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return [];
  const host = stripWww(url.hostname);
  const firstSeg = (url.pathname.split("/").filter(Boolean)[0] ?? "").toLowerCase();

  const out: RadarMatch[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (!rule.hosts.some((h) => stripWww(h) === host)) continue;
    if (rule.reserved?.includes(firstSeg)) continue;
    for (const source of rule.source) {
      const params = matchSource(source, url);
      if (!params) continue;
      if (rule.where) {
        const ok = Object.entries(rule.where).every(([name, re]) => params[name] !== undefined && new RegExp(re).test(params[name]));
        if (!ok) continue;
      }
      const route = fillTarget(rule.target, params);
      if (!route || seen.has(route)) continue;
      seen.add(route);
      out.push({ route, title: rule.title });
      break;
    }
  }
  return out;
}
