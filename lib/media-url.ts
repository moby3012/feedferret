import { createHmac } from "node:crypto";

/** Canonical signing form: no fragments or credentials; HTTP(S) only. */
export function canonicalMediaUrl(raw: string, base?: string): string | null {
  try {
    const url = new URL(raw, base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

export function mediaSignature(url: string, key: Buffer): string {
  return createHmac("sha256", key).update(url).digest("hex");
}

export function signedMediaUrl(raw: string, key: Buffer, base?: string): string {
  if (raw.startsWith("data:image/")) return raw;
  const url = canonicalMediaUrl(raw, base);
  if (!url) return "";
  return `/api/media?u=${encodeURIComponent(url)}&s=${mediaSignature(url, key)}`;
}
