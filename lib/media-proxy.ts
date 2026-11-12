import { timingSafeEqual } from "node:crypto";
import { getKeyring } from "./secret-box";
import { deriveMacKey } from "./secret-box-core.mjs";
import { canonicalMediaUrl, mediaSignature, signedMediaUrl } from "./media-url";
import { db } from "./db";
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
export async function mediaProxyEnabled(userId: string): Promise<boolean> {
  const [global, user] = await Promise.all([
    db.globalSettings.findUnique({ where: { id: "global" }, select: { mediaProxyMode: true } }),
    db.user.findUnique({ where: { id: userId }, select: { mediaProxyImages: true } }),
  ]);
  return global?.mediaProxyMode === "on" || (global?.mediaProxyMode === "opt-in" && user?.mediaProxyImages === true);
}

/** Only call at app presentation boundaries; external APIs keep raw URLs. */
export async function presentMedia<T extends { imageUrl: string | null; link: string; html?: string }>(items: T[], userId: string): Promise<T[]> {
  if (!await mediaProxyEnabled(userId)) return items;
  const key = mediaKey();
  return Promise.all(items.map(async (item) => ({
    ...item,
    imageUrl: item.imageUrl ? signedMediaUrl(item.imageUrl, key, item.link) || null : null,
    ...(item.html ? { html: await runHtmlTask("rewriteMedia", { html: guardHtml(item.html).html, base: item.link, keyHex: key.toString("hex") }) } : {}),
  })));
}
