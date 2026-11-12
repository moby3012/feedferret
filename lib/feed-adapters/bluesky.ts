// Optional, public AppView enrichment. RSS remains authoritative for identity/dates.
import { safeFetch, readTextWithLimit } from "../ssrf";
import { dedupeEnclosures, type FetchedFeed } from "../feed-item-fields";

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
function https(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { const url = new URL(value); return url.protocol === "https:" ? url.href : null; } catch { return null; }
}
export function blueskyRssActor(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.hostname !== "bsky.app" || url.protocol !== "https:") return null;
    const match = /^\/profile\/([^/]+)\/rss\/?$/.exec(url.pathname);
    return match ? decodeURIComponent(match[1]) : null;
  } catch { return null; }
}

export function enrichBlueskyArticles(feed: FetchedFeed, data: unknown): FetchedFeed {
  const entries = object(data).feed;
  if (!Array.isArray(entries)) return markUnenriched(feed, new Set());
  const seen = new Set<string>();
  const matched = new Set<FetchedFeed["articles"][number]>();
  for (const entry of entries) {
    const post = object(object(entry).post);
    const uri = typeof post.uri === "string" ? post.uri.split("/") : [];
    const rkey = uri.at(-1);
    if (uri[0] !== "at:" || uri[3] !== "app.bsky.feed.post" || !rkey) continue;
    if (seen.has(String(post.uri))) continue;
    seen.add(String(post.uri));
    const author = object(post.author);
    const article = feed.articles.find((item) => {
      try {
        const url = new URL(item.link);
        const parts = url.pathname.split("/");
        return url.hostname === "bsky.app" && parts[1] === "profile" && parts[3] === "post" && parts[4] === rkey &&
          [author.handle, author.did].includes(decodeURIComponent(parts[2]));
      } catch { return false; }
    });
    if (!article) continue;
    matched.add(article);
    const embed = object(post.embed);
    const media = embed.$type === "app.bsky.embed.recordWithMedia#view" ? object(embed.media) : embed;
    const additions: string[] = [];
    const enclosures = article.enclosures ?? [];
    if (Array.isArray(media.images)) for (const raw of media.images) {
      const image = object(raw);
      const src = https(image.fullsize);
      if (!src) continue;
      additions.push(`<img src="${escape(src)}" alt="${escape(typeof image.alt === "string" ? image.alt : "")}">`);
      enclosures.push({ href: src, type: "image/jpeg" });
      article.imageUrl ||= src;
    }
    const playlist = https(media.playlist);
    if (playlist) {
      const poster = https(media.thumbnail);
      additions.push(`<video controls src="${escape(playlist)}"${poster ? ` poster="${escape(poster)}"` : ""}></video>`);
      enclosures.push({ href: playlist, type: "application/vnd.apple.mpegurl" });
      article.media = { url: playlist, type: "application/vnd.apple.mpegurl" };
      article.imageUrl ||= poster;
    }
    const recordEmbed = embed.$type === "app.bsky.embed.recordWithMedia#view" ? object(embed.record) : embed;
    const quote = object(recordEmbed.record);
    const quoteText = object(quote.value).text;
    if (typeof quoteText === "string") {
      const name = object(quote.author).handle;
      additions.push(`<blockquote><p>${typeof name === "string" ? `@${escape(name)}: ` : ""}${escape(quoteText).replaceAll("\n", "<br>")}</p></blockquote>`);
    }
    article.content += additions.join("");
    article.enclosures = dedupeEnclosures(enclosures);
  }
  return markUnenriched(feed, matched);
}

/**
 * Items the API page did not cover (older than its window, or the call failed)
 * are flagged so sync keeps whatever it stored - an item once enriched never
 * flips back to the plain RSS text and bumps updatedAt each time.
 */
function markUnenriched(feed: FetchedFeed, matched: Set<FetchedFeed["articles"][number]>): FetchedFeed {
  for (const article of feed.articles) if (!matched.has(article)) article.keepStored = true;
  return feed;
}

export async function enrichBlueskyFeed(feed: FetchedFeed, actor: string, signal?: AbortSignal): Promise<FetchedFeed> {
  try {
    const url = new URL("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed");
    url.searchParams.set("actor", actor); url.searchParams.set("limit", "100");
    const timeout = AbortSignal.timeout(8_000);
    const response = await safeFetch(url.href, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) { await response.body?.cancel(); return markUnenriched(feed, new Set()); }
    return enrichBlueskyArticles(feed, JSON.parse(await readTextWithLimit(response, 4 * 1024 * 1024)));
  } catch { return markUnenriched(feed, new Set()); } // Public enrichment must never break a working RSS subscription.
}
