import { JSDOM } from "jsdom";
import { alternativeUrl, videoFor, type Frontends } from "./video-providers";
import { signedMediaUrl } from "./media-url";

export type MediaRewriteInput = { html: string; base: string; keyHex: string; frontends?: Frontends; playLabel?: string };

/** Runs only in the bounded HTML worker. Never writes stored article content. */
export function rewriteMediaInProcess({ html, base, keyHex, frontends = {}, playLabel = "Load video" }: MediaRewriteInput): string {
  const dom = new JSDOM("");
  try {
    const body = dom.window.document.body;
    body.innerHTML = html;
    const key = Buffer.from(keyHex, "hex");
    // Discard publisher-supplied control markers, including nested/spoofed buttons.
    for (const el of body.querySelectorAll("[data-ff-video]")) el.removeAttribute("data-ff-video");
    const seen = new Set<string>();
    const placeholder = (raw: string) => {
      const video = videoFor(raw);
      if (!video) return;
      seen.add(video.url);
      const alternative = alternativeUrl(raw, frontends);
      const box = dom.window.document.createElement("span");
      box.className = "ff-video-placeholder";
      if (video.thumbnail && keyHex) {
        const img = dom.window.document.createElement("img");
        img.src = signedMediaUrl(video.thumbnail, key, base);
        img.alt = "";
        box.append(img);
      }
      const control = dom.window.document.createElement(alternative !== raw || !video.embed && !["Twitch", "Reddit video"].includes(video.provider) ? "a" : "button");
      control.textContent = "▶ " + playLabel + " · " + video.provider;
      if (control.tagName === "BUTTON") {
        control.setAttribute("type", "button");
        control.setAttribute("data-ff-video", video.url);
      } else {
        control.setAttribute("href", alternative);
        control.setAttribute("target", "_blank");
        control.setAttribute("rel", "noopener noreferrer");
      }
      box.append(control);
      return box;
    };
    for (const el of body.querySelectorAll("a[href], iframe[src], video[src]")) {
      const raw = el.getAttribute(el.tagName === "A" ? "href" : "src")!;
      let absolute: string;
      try { absolute = new URL(raw, base).href; } catch { continue; }
      const box = placeholder(absolute);
      if (box) el.replaceWith(box);
      else if (el.tagName === "IFRAME") el.remove();
      else if (el.tagName === "A") {
        const alternative = alternativeUrl(absolute, frontends);
        if (alternative !== absolute) { el.setAttribute("href", alternative); el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener noreferrer"); }
      }
    }
    if (videoFor(base) && !seen.has(base)) {
      const box = placeholder(base);
      if (box) body.append(box);
    }
    // Reddit RSS exposes gallery media as preview/image links. No JSON or page scraping.
    const reddit = (() => { try { return new URL(base).hostname.endsWith(".reddit.com") || new URL(base).hostname === "reddit.com"; } catch { return false; } })();
    if (reddit) {
      const images = new Set(Array.from(body.querySelectorAll("img[src]"), el => el.getAttribute("src")));
      for (const a of body.querySelectorAll("a[href]")) {
        try {
          const u = new URL(a.getAttribute("href")!, base);
          if (!["preview.redd.it", "i.redd.it"].includes(u.hostname) || u.protocol !== "https:" || images.has(u.href)) continue;
          const img = dom.window.document.createElement("img");
          img.src = u.href;
          img.alt = a.textContent || "Reddit";
          a.replaceChildren(img);
          images.add(u.href);
        } catch { /* malformed link */ }
      }
    }
    if (!keyHex) return body.innerHTML;
    const rewrite = (url: string) => signedMediaUrl(url, key, base);
    for (const media of body.querySelectorAll("video, audio")) {
      media.setAttribute("preload", "none");
      media.removeAttribute("autoplay");
      for (const source of media.querySelectorAll("source")) {
        source.setAttribute("preload", "none");
        source.removeAttribute("autoplay");
      }
    }
    for (const el of body.querySelectorAll('img, input[type="image" i], picture source, video[poster]')) {
      const attr = el.tagName === "VIDEO" ? "poster" : "src";
      if (el.hasAttribute(attr) && !el.getAttribute(attr)!.startsWith("/api/media?")) el.setAttribute(attr, rewrite(el.getAttribute(attr)!));
      if (el.hasAttribute("srcset")) {
        // HTTP image candidates cannot contain whitespace. Commas inside URL
        // tokens are retained; trailing commas delimit descriptor-less URLs.
        const candidates: string[] = [];
        const input = el.getAttribute("srcset")!;
        let pos = 0;
        while (pos < input.length) {
          while (pos < input.length && /[\s,]/.test(input[pos])) pos++;
          const start = pos;
          while (pos < input.length && !/\s/.test(input[pos])) pos++;
          let url = input.slice(start, pos);
          if (!url) break;
          if (url.endsWith(",")) {
            while (url.endsWith(",")) url = url.slice(0, -1);
            candidates.push(rewrite(url));
            continue;
          }
          const descStart = pos;
          while (pos < input.length && input[pos] !== ",") pos++;
          const descriptor = input.slice(descStart, pos).trim();
          pos++;
          const proxied = rewrite(url);
          if (proxied && (!descriptor || /^(?:\d+w|\d+(?:\.\d+)?x)$/.test(descriptor))) {
            candidates.push(`${proxied}${descriptor ? " " + descriptor : ""}`);
          }
        }
        el.setAttribute("srcset", candidates.filter(Boolean).join(", "));
      }
      if (el.tagName === "IMG") {
        el.setAttribute("loading", "lazy");
        el.setAttribute("referrerpolicy", "no-referrer");
      }
    }
    return body.innerHTML;
  } finally { dom.window.close(); }
}
