import { decodeHTML } from "entities";
import { replaceElements, replaceTagsNamed, stripTags } from "@/lib/linear-text";

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "p", "div", "li", "ul", "ol", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "td", "th",
  "article", "section", "header", "footer", "figure", "figcaption", "pre",
]);

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

  const blockTagged = replaceElements(contentOrSummary.replace(/<!--[\s\S]*?(?:-->|$)/g, " "), ["script", "style", "template", "noscript"], " ", {
    closeTagWhitespace: true,
    unclosedToEnd: true,
  })
    .replace(/<br\s*\/?>/gi, " ");
  const text = stripTags(replaceTagsNamed(blockTagged, BLOCK_TAGS, " "), "");
  const clean = decodeHTML(text).replace(/[\s ​]+/g, " ").trim();
  if (!clean) return null;

  // Only the first maxChars + 1 graphemes matter; segmenting a megabyte of content just to cut it at 80 is wasted work.
  const graphemes = splitGraphemes(clean, maxChars + 1);
  if (graphemes.length <= maxChars) return clean;

  const head = graphemes.slice(0, maxChars).join("");
  if (/^\s/.test(graphemes[maxChars])) return `${head.trimEnd()}…`;

  const lastSpace = head.lastIndexOf(" ");
  if (lastSpace > 0) return `${head.slice(0, lastSpace).trimEnd()}…`;
  return `${head}…`;
}

let segmenter: Intl.Segmenter | null | undefined;

function splitGraphemes(text: string, limit = Infinity): string[] {
  if (segmenter === undefined) {
    segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;
  }
  const out: string[] = [];
  const parts: Iterable<string> = segmenter ? (function* () { for (const s of segmenter!.segment(text)) yield s.segment; })() : text; // code points: still never a lone surrogate
  for (const part of parts) {
    if (out.length >= limit) break;
    out.push(part);
  }
  return out;
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
