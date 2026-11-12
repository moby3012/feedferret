import { JSDOM } from "jsdom";
import { signedMediaUrl } from "./media-url";

export type MediaRewriteInput = { html: string; base: string; keyHex: string };

/** Runs only in the bounded HTML worker. Never writes stored article content. */
export function rewriteMediaInProcess({ html, base, keyHex }: MediaRewriteInput): string {
  const dom = new JSDOM("");
  try {
    const body = dom.window.document.body;
    body.innerHTML = html;
    const key = Buffer.from(keyHex, "hex");
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
      if (el.hasAttribute(attr)) el.setAttribute(attr, rewrite(el.getAttribute(attr)!));
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
