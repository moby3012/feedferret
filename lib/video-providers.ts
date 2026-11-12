/** Pure URL rules shared by the worker and click handler. No discovery requests. */
export type Frontends = {
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
type Rule = {
  name: string;
  hosts?: string[];
  match: (u: URL) => string | undefined;
  embed?: (id: string) => string;
  thumbnail?: (id: string) => string;
  /** Canonical public watch page of a matched video (ingest turns an <iframe> into a link to it); absent = never converted. */
  watch?: (id: string, u: URL) => string;
};
const segment = (value?: string | null) => value && /^[\w-]+$/.test(value) ? value : undefined;
// Both placeholders happen to be 11 characters long.
const youtubeEmbedId = (value?: string) => value && /^[\w-]{11}$/.test(value) && value !== "videoseries" && value !== "live_stream" ? value : undefined;
/** Twitch player ids: `?video=v123` and `?video=123` are the same video. */
const twitchPlayerVideo = (value: string | null) => /^v?(\d+)$/.exec(value ?? "")?.[1];
export const VIDEO_PROVIDERS: Rule[] = [
  { name: "YouTube", hosts: ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtube-nocookie.com"],
    // Embed paths carry exactly an 11-character video id: `/embed/videoseries?list=…` and
    // `/embed/live_stream?channel=…` are players without one.
    match: u => segment(u.hostname === "youtu.be" ? u.pathname.split("/")[1] : u.searchParams.get("v") ?? (u.pathname.split("/")[1] === "embed" ? youtubeEmbedId(u.pathname.split("/")[2]) : ["shorts", "live"].includes(u.pathname.split("/")[1]) ? u.pathname.split("/")[2] : undefined)),
    embed: id => `https://www.youtube-nocookie.com/embed/${id}`,
    thumbnail: id => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    watch: id => `https://www.youtube.com/watch?v=${id}` },
  { name: "Vimeo", hosts: ["vimeo.com", "www.vimeo.com", "player.vimeo.com"],
    match: u => /^\d+$/.test(u.pathname.split("/").at(-1) ?? "") ? u.pathname.split("/").at(-1) : undefined,
    embed: id => `https://player.vimeo.com/video/${id}?dnt=1`,
    watch: id => `https://vimeo.com/${id}` },
  { name: "Dailymotion", hosts: ["dailymotion.com", "www.dailymotion.com", "dai.ly"],
    match: u => segment(u.hostname === "dai.ly" ? u.pathname.split("/")[1] : u.pathname.startsWith("/video/") || u.pathname.startsWith("/embed/video/") ? u.pathname.split("/").at(-1) : undefined),
    embed: id => `https://www.dailymotion.com/embed/video/${id}`,
    watch: id => `https://www.dailymotion.com/video/${id}` },
  { name: "Twitch", hosts: ["twitch.tv", "www.twitch.tv", "clips.twitch.tv", "player.twitch.tv"],
    match: u => u.hostname === "player.twitch.tv" ? twitchPlayerVideo(u.searchParams.get("video")) :
      u.hostname === "clips.twitch.tv" ? segment(u.pathname.split("/")[1] === "embed" ? u.searchParams.get("clip") : u.pathname.split("/")[1]) :
      u.pathname.split("/")[1] === "videos" ? segment(u.pathname.split("/")[2]) : u.pathname.split("/")[2] === "clip" ? segment(u.pathname.split("/")[3]) : undefined,
    watch: (id, u) => u.hostname === "clips.twitch.tv" || u.pathname.includes("/clip/") ? `https://clips.twitch.tv/${id}` : `https://www.twitch.tv/videos/${id}` },
  { name: "PeerTube", match: u => u.pathname.startsWith("/videos/watch/") ? segment(u.pathname.split("/")[3]) : undefined },
  { name: "Reddit video", hosts: ["v.redd.it"], match: u => segment(u.pathname.split("/")[1]), watch: id => `https://v.redd.it/${id}` },
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
/**
 * Canonical watch URL (and provider) of a known video provider's iframe `src`, for ingest: the stored article
 * keeps a plain link and the render-time inliner (lib/media-rewrite-core.ts) turns it into a click-to-load
 * placeholder. Same matcher as `videoFor`, so both stay in step. `//host/…` and `http:` sources are read as https
 * (every provider serves it); relative or non-http(s) sources, unknown hosts and providers without a canonical
 * watch page (PeerTube instances cannot be told from an arbitrary https URL) give `undefined`.
 */
export function watchUrlForEmbed(src: string): { provider: string; url: string } | undefined {
  try {
    let raw = src.trim();
    if (raw.startsWith("//")) raw = "https:" + raw;
    else if (/^http:\/\//i.test(raw)) raw = "https:" + raw.slice(5);
    const video = videoFor(raw);
    if (!video) return;
    const u = new URL(video.url);
    for (const rule of VIDEO_PROVIDERS) {
      if (rule.name !== video.provider || !rule.watch) continue;
      const id = rule.match(u);
      if (id) return { provider: rule.name, url: rule.watch(id, u) };
    }
  } catch { /* not an absolute URL */ }
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
