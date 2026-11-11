// Cheap, linear pre-parse guard for attacker-controlled HTML (fetched pages,
// feed item bodies, newsletter mails) before it reaches a DOM parser.
//
// jsdom/parse5 (and DOMPurify, which parses through jsdom) cost roughly
// O(elements × nesting depth): 50 000 elements under 200 open `<div>`s take
// ~3.7 s, 3 000 unclosed `<div>`s overflow the stack (RangeError) and 1 MiB of
// them run for minutes. The worker pool (lib/html-worker) bounds the wall time
// of every parse, but the input should already be bounded before it gets
// there, so legitimate-but-huge pages degrade to "parse a prefix" instead of
// "time out".
//
// The guard walks the input once with htmlparser2's Tokenizer (a flat state
// machine, no recursion, no DOM), keeps an ESTIMATE of the open-element stack
// (void elements, raw-text elements and the common implied end tags are
// modelled; everything else is assumed to nest, which over- rather than
// under-estimates depth) and stops at the first tag that would exceed a
// limit. Everything before that tag is returned; the parser closes whatever
// is still open, so a truncated document is still well-formed HTML.
//
// Every operation is O(1) amortized per token: unmatched close tags are
// detected through per-tag open counts (no stack search) and every pushed
// element is popped at most once.

import { Tokenizer } from "htmlparser2";

export type HtmlGuardLimits = {
  /** Characters kept at most (the fetchers already cap bodies at 2 MiB). */
  maxChars: number;
  /** Estimated open-element depth at most. */
  maxDepth: number;
  /** Elements at most. */
  maxElements: number;
  /**
   * Parse "work" at most: the sum of the estimated depth at every element
   * open — what the DOM parsers' cost actually scales with.
   */
  maxWork: number;
  /**
   * XML mode (OPML, XML+XPath sources): `<x/>` closes itself and there are
   * no void elements or implied end tags.
   */
  xml: boolean;
};

/**
 * Defaults, calibrated on the page-feed / full-text fixture corpus (62
 * real and synthetic pages: deepest nesting 43, most elements ~7 500, most
 * work ~106 000 units — see tests/lib/html-guard.test.ts) with a margin of
 * 3–4.7×: a legitimate page never gets close. Not only the parse is bounded
 * by them: the extractors that run on the DOM afterwards (Readability,
 * Defuddle, the quality gate) are superlinear in depth and element count too
 * (512 nested `<div>`s kept the full-text ensemble busy for > 20 s, 5 000
 * paragraphs under 150 `<div>`s for 11 s). What still gets through is cut
 * off by the worker's task timeout (lib/html-worker/pool.ts).
 */
export const DEFAULT_HTML_GUARD_LIMITS: HtmlGuardLimits = {
  maxChars: 2 * 1024 * 1024,
  maxDepth: 128,
  maxElements: 30_000,
  maxWork: 500_000,
  xml: false,
};

export type HtmlGuardReason = "size" | "depth" | "elements" | "work";

export type HtmlGuardResult = {
  /** The input, or the prefix before the first tag that exceeded a limit. */
  html: string;
  /** Why the input was cut; null when it passed unchanged. */
  truncatedBy: HtmlGuardReason | null;
  stats: { chars: number; elements: number; maxDepth: number; work: number };
};

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr",
  "basefont", "bgsound", "frame", "image", "isindex", "menuitem",
]);

// Elements whose start tag closes an open `<p>` (HTML "close a p element").
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "center", "details", "dialog", "dir", "div", "dl", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main",
  "menu", "nav", "ol", "p", "pre", "section", "summary", "table", "ul", "li", "dd", "dt", "listing", "plaintext", "xmp",
]);

// A start tag of the key closes the nearest open element of one of the listed
// tags, unless one of the `stop` tags is open above it (a nested list/table).
const IMPLIED_END: Record<string, { close: string[]; stop: string[] }> = {
  li: { close: ["li"], stop: ["ul", "ol", "menu"] },
  dt: { close: ["dt", "dd"], stop: ["dl"] },
  dd: { close: ["dt", "dd"], stop: ["dl"] },
  option: { close: ["option"], stop: ["select", "datalist"] },
  optgroup: { close: ["option", "optgroup"], stop: ["select"] },
  tr: { close: ["tr"], stop: ["table"] },
  td: { close: ["td", "th"], stop: ["tr", "table"] },
  th: { close: ["td", "th"], stop: ["tr", "table"] },
  thead: { close: ["thead", "tbody", "tfoot"], stop: ["table"] },
  tbody: { close: ["thead", "tbody", "tfoot"], stop: ["table"] },
  tfoot: { close: ["thead", "tbody", "tfoot"], stop: ["table"] },
  rb: { close: ["rb", "rt", "rp", "rtc"], stop: ["ruby"] },
  rt: { close: ["rb", "rt", "rp"], stop: ["ruby"] },
  rp: { close: ["rb", "rt", "rp"], stop: ["ruby"] },
  a: { close: ["a"], stop: [] },
};

// Implied-end lookups only look this far down the stack: enough for real
// markup (`<li>` inside a few inline wrappers), and it keeps every token O(1).
const IMPLIED_SCAN = 24;

/**
 * Bounds `html` (see the module comment). Linear in the input; never throws.
 * `limits` overrides individual defaults.
 */
export function guardHtml(html: string, limits: Partial<HtmlGuardLimits> = {}): HtmlGuardResult {
  const lim = { ...DEFAULT_HTML_GUARD_LIMITS, ...limits };
  let input = html;
  let truncatedBy: HtmlGuardReason | null = null;
  if (input.length > lim.maxChars) {
    input = input.slice(0, lim.maxChars);
    truncatedBy = "size";
  }

  const stack: string[] = [];
  const openCount = new Map<string, number>();
  let elements = 0;
  let maxDepth = 0;
  let work = 0;
  let cutAt = -1;
  let tagStart = 0;
  let tagName = "";

  const push = (name: string) => {
    stack.push(name);
    openCount.set(name, (openCount.get(name) ?? 0) + 1);
  };
  const pop = () => {
    const name = stack.pop()!;
    openCount.set(name, openCount.get(name)! - 1);
    return name;
  };
  const popThrough = (name: string) => {
    while (stack.length > 0 && pop() !== name) {
      /* pop until `name` is closed */
    }
  };
  const closeImplied = (name: string) => {
    const rule = IMPLIED_END[name];
    if (rule) {
      for (let i = stack.length - 1, n = 0; i >= 0 && n < IMPLIED_SCAN; i--, n++) {
        if (rule.stop.includes(stack[i])) break;
        if (rule.close.includes(stack[i])) {
          while (stack.length > i) pop();
          break;
        }
      }
    }
    if (CLOSES_P.has(name) && (openCount.get("p") ?? 0) > 0) {
      for (let i = stack.length - 1, n = 0; i >= 0 && n < IMPLIED_SCAN; i--, n++) {
        if (stack[i] === "p") {
          while (stack.length > i) pop();
          break;
        }
      }
    }
  };

  const tokenizer = new Tokenizer(
    { decodeEntities: false, recognizeSelfClosing: false },
    {
      onopentagname(start, end) {
        tagStart = start - 1; // the `<`
        tagName = input.slice(start, end).toLowerCase();
      },
      onattribname() {},
      onattribdata() {},
      onattribentity() {},
      onattribend() {},
      onopentagend() {
        open(false);
      },
      onselfclosingtag() {
        // `<x/>` in HTML is an open tag (void or not); foreign `<svg/>` closes itself.
        open(lim.xml || tagName === "svg" || tagName === "path" || tagName === "use");
      },
      onclosetag(start, end) {
        if (cutAt >= 0) return;
        const name = input.slice(start, end).toLowerCase();
        if ((openCount.get(name) ?? 0) > 0) popThrough(name); // unmatched close tags are ignored
      },
      ontext() {},
      ontextentity() {},
      oncdata() {},
      oncomment() {},
      ondeclaration() {},
      onprocessinginstruction() {},
      onend() {},
    },
  );

  function open(selfClosing: boolean) {
    if (cutAt >= 0) return;
    if (!lim.xml) closeImplied(tagName);
    const depth = stack.length + 1;
    let reason: HtmlGuardReason | null = null;
    if (depth > lim.maxDepth) reason = "depth";
    else if (elements + 1 > lim.maxElements) reason = "elements";
    else if (work + depth > lim.maxWork) reason = "work";
    if (reason) {
      cutAt = tagStart;
      truncatedBy = reason;
      // Nothing after the cut matters: stop feeding the tokenizer events.
      tokenizer.pause();
      return;
    }
    elements++;
    work += depth;
    if (depth > maxDepth) maxDepth = depth;
    if (!selfClosing && (lim.xml || !VOID_TAGS.has(tagName))) push(tagName);
  }

  try {
    tokenizer.write(input);
    if (cutAt < 0) tokenizer.end();
  } catch {
    // htmlparser2's tokenizer does not throw on any input; be defensive anyway.
  }

  return {
    html: cutAt >= 0 ? input.slice(0, cutAt) : input,
    truncatedBy,
    stats: { chars: input.length, elements, maxDepth, work },
  };
}
