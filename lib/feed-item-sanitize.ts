// Sanitizing feed item bodies (RSS/Atom/JSON content is attacker-controlled
// HTML; DOMPurify parses it with jsdom). Pure; production code runs it in the
// HTML worker pool via `sanitizeFeedItemBodies` in lib/feed-item-sanitize-client.ts.

import { getSanitizer } from "./sanitize-html";
import { removeSelectorsFromFragments } from "./selector-extract";

export type SanitizedFeedItem = {
  /** First 200 chars of the tag-stripped content. */
  excerpt: string;
  /** DOMPurify-sanitized content. */
  html: string;
};

export type SanitizeFeedItemsInput = {
  items: string[];
  /** Feed's remove-selector list (FreshRSS `cssContentFilter`), applied before sanitizing. */
  removeSelectors?: string | null;
  /** Excerpt from the sanitized HTML (FreshRSS import) instead of the raw content (feed sync). */
  excerptFromSanitized?: boolean;
};

export async function sanitizeFeedItemsInProcess(input: SanitizeFeedItemsInput): Promise<SanitizedFeedItem[]> {
  const DOMPurify = await getSanitizer();
  const contents = removeSelectorsFromFragments({ items: input.items, selectors: input.removeSelectors });
  return contents.map((content) => {
    const html = DOMPurify.sanitize(content);
    const excerpt = DOMPurify.sanitize(input.excerptFromSanitized ? html : content, { ALLOWED_TAGS: [] }).substring(0, 200);
    return { excerpt, html };
  });
}
