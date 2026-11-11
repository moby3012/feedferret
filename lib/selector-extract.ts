// CSS-selector based full-text extraction ("selector" full-text mode, the
// feed settings preview and the AI selector proposal check). Parses untrusted
// article pages with jsdom, so production code runs these functions only in
// the HTML worker pool (lib/html-worker); they are pure (no I/O).

import { JSDOM } from "jsdom";
import { getSanitizer } from "@/lib/sanitize-html";
import { normalizeLazyMedia } from "@/lib/lazy-media";
import { assessExtraction, type ExtractionQuality } from "@/lib/extraction-quality";

const DEFAULT_REMOVE_SELECTORS = ["script", "style", "nav", "footer", "header", "aside", "form", "iframe", "noscript", "svg"];
const SYNC_CANDIDATE_SELECTORS = ["article", "main", "[role='main']", ".post-content", ".entry-content", ".article-content", ".content"];
const PREVIEW_CANDIDATE_SELECTORS = [...SYNC_CANDIDATE_SELECTORS, ".post", ".entry"];

export type SelectorCandidate = {
  selector: string;
  charCount: number;
  paragraphCount: number;
  linkCount: number;
  sample: string;
};

export type SelectorExtractInput = {
  html: string;
  url: string;
  /** Feed's configured content selector; falls back to the heuristic when it matches nothing. */
  selector?: string | null;
  /** Comma-separated extra selectors to strip before extracting. */
  removeSelectors?: string | null;
  /**
   * `sync`: background full-text (lazy media normalized, quality assessed).
   * `preview`: the feed-settings preview (ranked candidates, plain length).
   */
  mode: "sync" | "preview";
};

export type SelectorExtractOutput = {
  /** Sanitized HTML of the chosen element, null when nothing was found. */
  html: string | null;
  /** Plain-text length of `html` (preview mode). */
  plainLength: number;
  /** Generic quality assessment of `html` (sync mode). */
  quality: ExtractionQuality | null;
  /** Top ranked auto-detect candidates (preview mode). */
  candidates: SelectorCandidate[];
};

const cssEscape = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);

function selectorFor(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const id = element.getAttribute("id");
  if (id) return `${tag}#${cssEscape(id)}`;
  const classes = Array.from(element.classList).slice(0, 3);
  if (classes.length > 0) return `${tag}.${classes.map(cssEscape).join(".")}`;
  const parent = element.parentElement;
  if (!parent) return tag;
  const siblings = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
  const index = siblings.indexOf(element);
  return siblings.length > 1 ? `${tag}:nth-of-type(${index + 1})` : tag;
}

/** Removes every element matching the selector list `selectors` below `root`. An invalid list removes nothing. */
export function removeMatchingElements(root: ParentNode, selectors: string | null | undefined): number {
  const list = selectors?.trim();
  if (!list) return 0;
  let matches: Element[];
  try {
    matches = Array.from(root.querySelectorAll(list));
  } catch {
    return 0;
  }
  for (const element of matches) element.remove();
  return matches.length;
}

export type RemoveSelectorsInput = { items: string[]; selectors: string | null | undefined };

/**
 * Applies a user remove-selector list to HTML fragments (feed item bodies).
 * Each item is returned unchanged when nothing matches.
 */
export function removeSelectorsFromFragments(input: RemoveSelectorsInput): string[] {
  if (!input.selectors?.trim()) return input.items;
  return input.items.map((html) => {
    if (!html) return html;
    const fragment = JSDOM.fragment(`<div>${html}</div>`);
    const container = fragment.firstElementChild;
    if (!container || removeMatchingElements(container, input.selectors) === 0) return html;
    return container.innerHTML;
  });
}

const plainText = (element: Element) => (element.textContent || "").replace(/\s+/g, " ").trim();

/** Selector / heuristic full-text extraction. Throws on an invalid configured selector. */
export async function extractBySelector(input: SelectorExtractInput): Promise<SelectorExtractOutput> {
  const { url, mode } = input;
  const dom = new JSDOM(input.html, { url });
  try {
    const document = dom.window.document;
    if (mode === "sync") normalizeLazyMedia(document, url);

    document.querySelectorAll(DEFAULT_REMOVE_SELECTORS.join(",")).forEach((n) => n.remove());
    // The user's list (FreshRSS `cssContentFilter`) is applied as ONE selector
    // list (`:is(a, b)` stays intact) and separately, so an invalid one cannot
    // break the extraction.
    removeMatchingElements(document, input.removeSelectors);

    // Resolve relative URLs
    document.querySelectorAll("a[href], img[src]").forEach((node) => {
      const attr = node instanceof dom.window.HTMLImageElement ? "src" : "href";
      const value = node.getAttribute(attr);
      if (!value) return;
      try {
        node.setAttribute(attr, new URL(value, url).toString());
      } catch {
        /* ignore */
      }
    });

    const score = (el: Element, text: string) =>
      text.length + el.querySelectorAll("p").length * 250 - el.querySelectorAll("a").length * 20;
    const pool = (selectors: string[]) =>
      selectors.flatMap((s) => Array.from<Element>(document.querySelectorAll(s))).concat(Array.from<Element>(document.body.children));

    let best: Element | undefined;
    if (input.selector) best = document.querySelector(input.selector) ?? undefined;

    let candidates: Array<SelectorCandidate & { el: Element; score: number }> = [];
    if (mode === "preview") {
      candidates = pool(PREVIEW_CANDIDATE_SELECTORS)
        .map((el) => {
          const text = plainText(el);
          return {
            el,
            selector: selectorFor(el),
            charCount: text.length,
            paragraphCount: el.querySelectorAll("p").length,
            linkCount: el.querySelectorAll("a").length,
            sample: text.slice(0, 220),
            score: score(el, text),
          };
        })
        .filter((c, index, all) => c.charCount > 80 && all.findIndex((other) => other.selector === c.selector) === index)
        .sort((a, b) => b.score - a.score);
      best ??= candidates[0]?.el;
    } else if (!best) {
      best = pool(SYNC_CANDIDATE_SELECTORS)
        .map((el) => ({ el, score: (el.textContent?.trim().length || 0) + el.querySelectorAll("p").length * 250 - el.querySelectorAll("a").length * 20 }))
        .sort((a, b) => b.score - a.score)[0]?.el;
    }

    const top = candidates.slice(0, 5).map(({ selector, charCount, paragraphCount, linkCount, sample }) => ({
      selector,
      charCount,
      paragraphCount,
      linkCount,
      sample,
    }));
    if (!best) return { html: null, plainLength: 0, quality: null, candidates: top };

    const DOMPurify = await getSanitizer();
    const sanitized = DOMPurify.sanitize(best.innerHTML, { ADD_ATTR: ["target", "rel"] }).trim();
    if (mode === "preview") {
      const plain = DOMPurify.sanitize(sanitized, { ALLOWED_TAGS: [] }).replace(/\s+/g, " ").trim();
      return { html: sanitized, plainLength: plain.length, quality: null, candidates: top };
    }
    return { html: sanitized, plainLength: 0, quality: assessExtraction(sanitized), candidates: top };
  } finally {
    dom.window.close();
  }
}

export type SelectorTextInput = { html: string; url: string; selector: string };

export type SelectorTextOutput =
  | { status: "invalid" }
  | { status: "nomatch" }
  | {
      status: "ok";
      /** Plain length of the sanitized element (tags stripped). */
      textLength: number;
      /** Whitespace-collapsed plain text of the element, first 500 chars. */
      excerpt: string;
    };

/** Checks what a CSS selector yields on a page (AI selector proposals). Never throws. */
export async function probeSelectorText(input: SelectorTextInput): Promise<SelectorTextOutput> {
  const dom = new JSDOM(input.html, { url: input.url });
  try {
    let element: Element | null;
    try {
      element = dom.window.document.querySelector(input.selector);
    } catch {
      return { status: "invalid" };
    }
    if (!element) return { status: "nomatch" };
    const DOMPurify = await getSanitizer();
    const sanitized = DOMPurify.sanitize(element.innerHTML);
    const textLength = sanitized.replace(/<[^>]*>?/gm, " ").replace(/\s+/g, " ").trim().length;
    const excerpt = DOMPurify.sanitize(element.innerHTML, { ALLOWED_TAGS: [] }).replace(/\s+/g, " ").trim().slice(0, 500);
    return { status: "ok", textLength, excerpt };
  } finally {
    dom.window.close();
  }
}
