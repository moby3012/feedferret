// Worker-only, pure parser for Telegram's public web timeline.
import { JSDOM } from "jsdom";
import { getSanitizer } from "./sanitize-html";
import { dateFrom, type FetchedFeed, type FetchedFeedArticle } from "./feed-item-fields";

export async function parseTelegramPreview(input: { html: string; url: string; channel: string }): Promise<FetchedFeed> {
  const dom = new JSDOM(input.html, { url: input.url });
  try {
    const doc = dom.window.document;
    if (!doc.querySelector(".tgme_channel_info") || !doc.querySelector(".tgme_channel_history")) {
      throw new Error("Telegram channel has no public web preview (private or nonexistent channel)");
    }
    const purify = await getSanitizer();
    const articles: FetchedFeedArticle[] = [];
    const seen = new Set<string>();
    // Signed/rotating URLs (token, expiry, signature) change every sync and soon
    // answer 403: never store them; the item simply has no such media.
    const VOLATILE = new Set(["token", "sig", "signature", "expires", "exp", "hash", "hmac", "key"]);
    const mediaUrl = (value: string | null) => {
      if (!value) return null;
      try {
        const u = new URL(value, input.url);
        if (u.protocol !== "https:") return null;
        for (const name of u.searchParams.keys()) if (VOLATILE.has(name.toLowerCase())) return null;
        return u.href;
      } catch { return null; }
    };
    const backgroundOf = (element: Element) => {
      // Parse CSS with the DOM CSS parser, never regex over raw markup.
      const background = (element as HTMLElement).style.backgroundImage;
      return background.startsWith("url(") ? mediaUrl(background.slice(4, -1).replace(/^["']|["']$/g, "")) : null;
    };
    for (const message of doc.querySelectorAll(".tgme_widget_message[data-post]")) {
      const id = message.getAttribute("data-post") ?? "";
      const [channel, number, extra] = id.split("/");
      if (channel?.toLowerCase() !== input.channel || !/^\d+$/.test(number ?? "") || extra || seen.has(id)) continue;
      seen.add(id);
      const link = `https://t.me/${input.channel}/${number}`;
      const body = doc.createElement("div");
      const forwarded = message.querySelector(".tgme_widget_message_forwarded_from");
      if (forwarded) {
        // Language-neutral marker + origin name; no hardcoded prose.
        const note = doc.createElement("p");
        note.textContent = `\u21AA ${forwarded.textContent?.replace(/\s+/g, " ").trim()}`;
        body.append(note);
      }
      const text = message.querySelector(".tgme_widget_message_text")?.cloneNode(true) as Element | undefined;
      if (text) {
        // Emoji wrappers (<i class="emoji"><b>😀</b></i>) carry only a CSS image: keep the character.
        for (const emoji of text.querySelectorAll("i.emoji")) emoji.replaceWith(doc.createTextNode(emoji.textContent ?? ""));
        body.insertAdjacentHTML("beforeend", text.innerHTML);
      }
      const enclosures: NonNullable<FetchedFeedArticle["enclosures"]> = [];
      for (const photo of message.querySelectorAll(".tgme_widget_message_photo_wrap")) {
        const src = backgroundOf(photo);
        if (!src) continue;
        const img = doc.createElement("img"); img.src = src; img.alt = ""; body.append(img);
        enclosures.push({ href: src, type: "image/jpeg" });
      }
      // Video files are served from rotating signed URLs: store only the poster
      // image and a stable link to the post, never the media source itself.
      const videos = message.querySelectorAll("video, .tgme_widget_message_video_thumb, .tgme_widget_message_roundvideo_thumb");
      if (videos.length) {
        const posterEl = message.querySelector(".tgme_widget_message_video_thumb, .tgme_widget_message_roundvideo_thumb");
        const poster = (posterEl && backgroundOf(posterEl)) || mediaUrl(message.querySelector("video")?.getAttribute("poster") ?? null);
        const anchor = doc.createElement("a"); anchor.href = link;
        if (poster) {
          const img = doc.createElement("img"); img.src = poster; img.alt = ""; anchor.append(img);
          enclosures.push({ href: poster, type: "image/jpeg" });
        } else anchor.textContent = "\u25B6";
        const paragraph = doc.createElement("p"); paragraph.append(anchor); body.append(paragraph);
      }
      const content = purify.sanitize(body.innerHTML);
      // <br> must separate words in the title (textContent would glue lines).
      const titleSource = text?.cloneNode(true) as Element | undefined;
      for (const br of titleSource?.querySelectorAll("br") ?? []) br.replaceWith(doc.createTextNode(" "));
      for (const inert of titleSource?.querySelectorAll("script, style, template") ?? []) inert.remove();
      const titleText = (titleSource?.textContent ?? "").replace(/\s+/g, " ").trim();
      articles.push({ title: (titleText || `Telegram post ${number}`).slice(0, 160), link, content,
        guid: `${input.channel}/${number}`, externalId: `${input.channel}/${number}`,
        publishedAt: dateFrom(message.querySelector("time[datetime]")?.getAttribute("datetime")),
        imageUrl: enclosures.find((e) => e.type.startsWith("image/"))?.href ?? null,
        enclosures, media: null });
    }
    return { title: doc.querySelector(".tgme_channel_info_header_title")?.textContent?.trim() || input.channel,
      htmlUrl: `https://t.me/${input.channel}`, articles };
  } finally { dom.window.close(); }
}
