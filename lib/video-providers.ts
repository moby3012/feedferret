/** Pure URL rules shared by the worker and click handler. No discovery requests. */
export type Frontends = {
  mediaYoutubeFrontend?: string;
  mediaYoutubeInstance?: string;
  mediaRedditFrontend?: string;
  mediaTwitterInstance?: string;
};
export function validateInstance(value: unknown): string {
  if (value === "") return "";
  if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid frontend URL");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/" || url.hostname === "localhost" || !url.hostname.includes(".") ||
      url.hostname.includes(":") || /^\d+(?:\.\d+){3}$/.test(url.hostname)) throw new Error("Invalid frontend URL");
  return url.origin;
}
type Video = { provider: string; url: string; embed?: string; thumbnail?: string };
type Rule = { name: string; hosts?: string[]; match: (u: URL) => string | undefined; embed?: (id: string) => string; thumbnail?: (id: string) => string };
const segment = (value?: string) => value && /^[\w-]+$/.test(value) ? value : undefined;
export const VIDEO_PROVIDERS: Rule[] = [
  { name: "YouTube", hosts: ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtube-nocookie.com"],
    match: u => segment(u.hostname === "youtu.be" ? u.pathname.split("/")[1] : u.searchParams.get("v") ?? (["shorts", "embed", "live"].includes(u.pathname.split("/")[1]) ? u.pathname.split("/")[2] : undefined)),
    embed: id => `https://www.youtube-nocookie.com/embed/${id}`,
    thumbnail: id => `https://i.ytimg.com/vi/${id}/hqdefault.jpg` },
  { name: "Vimeo", hosts: ["vimeo.com", "www.vimeo.com", "player.vimeo.com"],
    match: u => /^\d+$/.test(u.pathname.split("/").at(-1) ?? "") ? u.pathname.split("/").at(-1) : undefined,
    embed: id => `https://player.vimeo.com/video/${id}?dnt=1` },
  { name: "Dailymotion", hosts: ["dailymotion.com", "www.dailymotion.com", "dai.ly"],
    match: u => segment(u.hostname === "dai.ly" ? u.pathname.split("/")[1] : u.pathname.startsWith("/video/") || u.pathname.startsWith("/embed/video/") ? u.pathname.split("/").at(-1) : undefined),
    embed: id => `https://www.dailymotion.com/embed/video/${id}` },
  { name: "Twitch", hosts: ["twitch.tv", "www.twitch.tv", "clips.twitch.tv"],
    match: u => u.hostname === "clips.twitch.tv" ? segment(u.pathname.split("/")[1]) : u.pathname.split("/")[1] === "videos" ? segment(u.pathname.split("/")[2]) : u.pathname.split("/")[2] === "clip" ? segment(u.pathname.split("/")[3]) : undefined },
  { name: "PeerTube", match: u => u.pathname.startsWith("/videos/watch/") ? segment(u.pathname.split("/")[3]) : undefined },
  { name: "Reddit video", hosts: ["v.redd.it"], match: u => segment(u.pathname.split("/")[1]) },
];
export function videoFor(raw: string, parent?: string): Video | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || u.port) return;
    for (const rule of VIDEO_PROVIDERS) {
      if (rule.hosts && !rule.hosts.includes(u.hostname)) continue;
      const id = rule.match(u);
      if (!id) continue;
      let embed = rule.embed?.(id);
      if (rule.name === "Twitch" && parent) {
        const clip = u.hostname === "clips.twitch.tv" || u.pathname.includes("/clip/");
        embed = clip ? `https://clips.twitch.tv/embed?clip=${id}&parent=${encodeURIComponent(parent)}&autoplay=false` :
          `https://player.twitch.tv/?video=${id}&parent=${encodeURIComponent(parent)}&autoplay=false`;
      }
      // Arbitrary PeerTube origins cannot be included in a fixed frame-src policy.
      return { provider: rule.name, url: u.href, embed, thumbnail: rule.thumbnail?.(id) };
    }
  } catch { /* not an absolute public video URL */ }
}
export function alternativeUrl(raw: string, settings: Frontends): string {
  try {
    const u = new URL(raw);
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) return raw;
    const video = videoFor(raw);
    if (video?.provider === "YouTube" && settings.mediaYoutubeInstance) {
      const origin = validateInstance(settings.mediaYoutubeInstance);
      const id = new URL(video.embed!).pathname.split("/").at(-1)!;
      return `${origin}/watch?v=${id}`;
    }
    if (["reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com", "www.redditmedia.com", "embed.reddit.com"].includes(u.hostname) && settings.mediaRedditFrontend) {
      const origin = settings.mediaRedditFrontend === "old" ? "https://old.reddit.com" : validateInstance(settings.mediaRedditFrontend);
      return origin + u.pathname + u.search + u.hash;
    }
    if (u.hostname === "platform.twitter.com" && u.pathname === "/embed/Tweet.html" && settings.mediaTwitterInstance) {
      const id = u.searchParams.get("id") ?? "";
      if (/^\d+$/.test(id)) return validateInstance(settings.mediaTwitterInstance) + "/i/status/" + id;
    }
    if (["twitter.com", "www.twitter.com", "x.com", "www.x.com", "mobile.twitter.com"].includes(u.hostname) && settings.mediaTwitterInstance) {
      return validateInstance(settings.mediaTwitterInstance) + u.pathname + u.search + u.hash;
    }
  } catch { /* invalid settings never produce active URLs */ }
  return raw;
}
