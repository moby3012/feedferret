import { decodeHTML } from "entities";

/**
 * Title synthesis for feed items without a title (Mastodon, Bluesky, micro-
 * blogs…): a readable display title derived from the item's content.
 *
 * - drops <script>/<style>/comments, strips tags (block boundaries → spaces)
 * - decodes HTML character references ONCE, per the HTML standard (named,
 *   decimal and hex incl. astral/emoji) — `&amp;lt;` stays `&lt;`
 * - collapses whitespace
 * - truncates by grapheme cluster (never splits an emoji / surrogate pair /
 *   combining sequence) on a word boundary when possible, appending "…"
 */
export function synthesizeItemTitle(
  contentOrSummary: string | null | undefined,
  maxChars = 80,
): string | null {
  if (!contentOrSummary) return null;

  const text = contentOrSummary
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?(?:p|div|li|ul|ol|blockquote|h[1-6]|tr|td|th|article|section|header|footer|figure|figcaption|pre)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "");

  const clean = decodeHTML(text).replace(/[\s ​]+/g, " ").trim();
  if (!clean) return null;

  const graphemes = splitGraphemes(clean);
  if (graphemes.length <= maxChars) return clean;

  const head = graphemes.slice(0, maxChars).join("");
  if (/^\s/.test(graphemes[maxChars])) return `${head.trimEnd()}…`;

  const lastSpace = head.lastIndexOf(" ");
  if (lastSpace > 0) return `${head.slice(0, lastSpace).trimEnd()}…`;
  return `${head}…`;
}

let segmenter: Intl.Segmenter | null | undefined;

function splitGraphemes(text: string): string[] {
  if (segmenter === undefined) {
    segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;
  }
  if (segmenter) return Array.from(segmenter.segment(text), (s) => s.segment);
  return Array.from(text); // code points: still never a lone surrogate
}

/** Placeholder the fetchers have always stored for title-less items. */
export const UNTITLED = "Untitled";

export type ItemTitle = {
  /** Display title (synthesized when the feed supplied none). */
  title: string;
  /** True when `title` was synthesized from content (not from the feed). */
  titleSynthetic?: true;
  /**
   * The title value the pre-synthesis code produced for this item
   * (`raw || "Untitled"`). Dedupe keys must keep using it so title-based
   * `unicityCriteria` identities don't change for existing rows.
   */
  identityTitle: string;
};

/**
 * Single source of truth for an item's title + provenance, used by every
 * fetcher path (RSS/Atom, JSON Feed, XPath, HTML+XPath+JSON).
 */
export function resolveItemTitle(rawTitle: string | null | undefined, ...contentCandidates: Array<string | null | undefined>): ItemTitle {
  const raw = rawTitle ?? "";
  const identityTitle = raw || UNTITLED;
  if (raw.trim() && raw.trim() !== UNTITLED) return { title: raw, identityTitle };
  for (const candidate of contentCandidates) {
    const synthesized = synthesizeItemTitle(candidate);
    if (synthesized) return { title: synthesized, titleSynthetic: true, identityTitle };
  }
  return { title: identityTitle, identityTitle };
}
