// Shared input-validation constants and helpers used by server actions and API routes.

export const MAX_FEED_URL_LENGTH = 2048;
export const MAX_OPML_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_OPML_FEEDS = 500;
export const MAX_LABEL_NAME = 100;
export const MAX_SEARCH_QUERY = 1000;
export const MAX_SAVED_SEARCH_NAME = 255;

export function validateFeedUrl(url: string): string | null {
  if (url.length > MAX_FEED_URL_LENGTH) return "Feed URL exceeds maximum length";
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return "Feed URL must use http or https";
    return null;
  } catch {
    return "Invalid feed URL";
  }
}

export function validateOpml(xml: string): string | null {
  const bytes = Buffer.byteLength(xml, "utf8");
  if (bytes > MAX_OPML_BYTES) return `OPML file too large (max ${MAX_OPML_BYTES / 1024 / 1024} MB)`;
  return null;
}
