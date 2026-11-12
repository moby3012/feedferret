// Sanitizing feed item bodies (RSS/Atom/JSON content is attacker-controlled
// HTML; DOMPurify parses it with jsdom). Pure; production code runs it in the
// HTML worker pool via `sanitizeFeedItemBodies` in lib/feed-item-sanitize-client.ts.

import { getSanitizer } from "./sanitize-html";
import { removeSelectorsFromFragments } from "./selector-extract";
import { watchUrlForEmbed } from "./video-providers";

export type SanitizedFeedItem = {
  /** First 200 chars of the tag-stripped content. */
  excerpt: string;
  /** DOMPurify-sanitized content. */
  html: string;
  /**
   * Only set when `embedLinks` turned an iframe into a link (so `html` differs): the plain DOMPurify output
   * the same item produced before that existed. Sync compares an already stored body against this form, so an
   * unchanged upstream item is not rewritten (no updatedAt bump) just because the sanitizer learned something.
   */
  legacyHtml?: string;
};

export type SanitizeFeedItemsInput = {
  items: string[];
  /** Feed's remove-selector list (FreshRSS `cssContentFilter`), applied before sanitizing. */
  removeSelectors?: string | null;
  /** Excerpt from the sanitized HTML (FreshRSS import) instead of the raw content (feed sync). */
  excerptFromSanitized?: boolean;
  /**
   * Turn `<iframe src>` of a known video provider (lib/video-providers.ts) into a plain `<a href>` to its
   * canonical watch page instead of stripping it; any other iframe is stripped as always. Off by default:
   * only the feed-sync body path opts in (see `legacyHtml`).
   */
  embedLinks?: boolean;
};

type Sanitizer = Awaited<ReturnType<typeof getSanitizer>>;

/**
 * DOMPurify keeps `iframe` for this one pass (RETURN_DOM: no re-parse of its output), then every iframe is
 * replaced by a link (known provider, URL built from the provider table, never copied from the source) or
 * removed together with its fallback content, as the default profile does. Notes on wrappers:
 *   - `<noscript>`: wherever the HTML parser keeps its children inside the element (after other content) the
 *     whole wrapper is dropped with them, as before; a noscript that LEADS the fragment is parsed as head
 *     content and its iframe is re-parented to the body, so that one converts like a bare iframe;
 *   - an iframe inside `<video>` fallback content converts as well;
 *   - an iframe inside an `<a>` is removed, never turned into a nested link (`<a><a>` is invalid, and the
 *     surrounding link already leads somewhere).
 * Returns null when no iframe was converted, i.e. the plain output is the answer.
 */
function sanitizeWithEmbedLinks(DOMPurify: Sanitizer, content: string): string | null {
  const body = DOMPurify.sanitize(content, { ADD_TAGS: ["iframe"], RETURN_DOM: true }) as unknown as HTMLElement;
  let converted = 0;
  for (const frame of Array.from(body.querySelectorAll("iframe"))) {
    const watch = watchUrlForEmbed(frame.getAttribute("src") ?? "");
    if (!watch || frame.closest("a")) {
      frame.remove();
      continue;
    }
    const link = frame.ownerDocument.createElement("a");
    link.setAttribute("href", watch.url);
    link.textContent = watch.url;
    frame.replaceWith(link);
    converted++;
  }
  return converted > 0 ? body.innerHTML : null;
}

export async function sanitizeFeedItemsInProcess(input: SanitizeFeedItemsInput): Promise<SanitizedFeedItem[]> {
  const DOMPurify = await getSanitizer();
  const contents = removeSelectorsFromFragments({ items: input.items, selectors: input.removeSelectors });
  return contents.map((content) => {
    const plain = DOMPurify.sanitize(content);
    // Cheap pre-check: items without an iframe never take the second pass.
    const withLinks = input.embedLinks && /<iframe/i.test(content) ? sanitizeWithEmbedLinks(DOMPurify, content) : null;
    const html = withLinks ?? plain;
    const excerpt = DOMPurify.sanitize(input.excerptFromSanitized ? html : content, { ALLOWED_TAGS: [] }).substring(0, 200);
    return withLinks === null ? { excerpt, html } : { excerpt, html, legacyHtml: plain };
  });
}
