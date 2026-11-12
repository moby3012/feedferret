import { decodeHTML } from "entities";
import { timingSafeEqual } from "node:crypto";
import { getKeyring } from "./secret-box";
import { deriveMacKey } from "./secret-box-core.mjs";
import { alternativeUrl, videoFor } from "./video-providers";
import { canonicalMediaUrl, mediaSignature, signedMediaUrl } from "./media-url";
import en from "@/messages/en.json";
import de from "@/messages/de.json";
import { mediaFrontends, mediaProxyEnabled } from "./media-settings";
import { stripTags } from "./linear-text";
export { mediaProxyEnabled } from "./media-settings";
import { guardHtml } from "./html-guard";
import { runHtmlTask } from "./html-worker/pool";

export const MEDIA_PURPOSE = "media-proxy.url.v1";
export function mediaKey(): Buffer {
  return deriveMacKey(getKeyring().current.master, MEDIA_PURPOSE);
}
export function verifyMediaSignature(raw: string, signature: string): boolean {
  const url = canonicalMediaUrl(raw);
  if (!url || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const actual = Buffer.from(signature, "hex");
  const ring = getKeyring();
  let valid = false;
  for (const entry of [ring.current, ...ring.old]) {
    const expected = Buffer.from(mediaSignature(url, deriveMacKey(entry.master, MEDIA_PURPOSE)), "hex");
    if (timingSafeEqual(actual, expected)) valid = true;
  }
  return valid;
}
/** Only call at app presentation boundaries; external APIs keep raw URLs. */
export async function presentMedia<T extends { imageUrl: string | null; link: string; html?: string; contentFormat?: string }>(items: T[], userId: string): Promise<T[]> {
  const [enabled, frontends] = await Promise.all([mediaProxyEnabled(userId), mediaFrontends(userId)]);
  const key = enabled ? mediaKey() : null;
  const playLabel = (frontends.uiLanguage === "de" ? de : en).articleReader.loadVideo;
  const hasFrontend = !!(frontends.mediaYoutubeInstance || frontends.mediaRedditFrontend || frontends.mediaTwitterInstance);
  return Promise.all(items.map(async (item) => {
    let html = item.html;
    // Most articles need no parsing. Avoid pool admission (and saturation fallback)
    // unless a presentation transform can apply. This is a conservative, cheap gate.
    const candidate = (html ?? "").toLowerCase() + item.link.toLowerCase();
    const hasMedia = ["youtube.com", "youtu.be", "youtube-nocookie.com", "vimeo.com", "dailymotion.com", "dai.ly", "twitch.tv", "/videos/watch/", "redd.it", "reddit.com"].some(host => candidate.includes(host));
    if (html !== undefined && (enabled || hasFrontend || hasMedia)) {
      try {
        html = await runHtmlTask("rewriteMedia", { html: guardHtml(html).html, base: item.link, keyHex: key?.toString("hex") ?? "", frontends, playLabel, trustedRendererHtml: item.contentFormat === "markdown" });
      } catch {
        // Parser saturation / timeout must never restore third-party requests.
        // A parse-free plain-text fallback removes every fetching element.
        html = "<p>" + decodeHTML(stripTags(html)).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;") + "</p>";
      }
    }
    const openLink = alternativeUrl(item.link, frontends);
    return {
      ...item,
      ...(openLink !== item.link ? { openLink } : {}),
      imageUrl: item.imageUrl && key ? signedMediaUrl(item.imageUrl, key, item.link) || null : videoFor(item.link) ? null : item.imageUrl,
      ...(html !== undefined ? { html } : {}),
    };
  }));
}
