// Linear, streaming scan of a fetched (attacker-controlled) HTML page for feed
// discovery. No DOM tree is built: htmlparser2's Tokenizer (a pure state
// machine, no recursion) emits tag / attribute / text events, and we keep only
// what discovery needs — `<base>`, `<link>`, anchors (+ their text,
// icon alts and whether they sit in header/footer/nav), generator metas, a
// prefix of inline script text, and the first element matching each of a
// fixed set of simple selectors (lib/feed-adapters/registry.ts). Input and
// every collected value are capped, so time and memory stay linear in the
// (capped) input whatever the markup looks like: deep nesting, thousands of
// unclosed tags, huge attributes.

import { QuoteType, Tokenizer } from "htmlparser2";

/** Characters of HTML scanned at most (discovery reads ≤ 1 MiB; feed hints live near the top). */
export const HTML_SCAN_MAX_CHARS = 512 * 1024;
/** Inline-script text kept for adapter fingerprints / install-base patterns. */
export const SCRIPT_TEXT_CAP = 64 * 1024;
const ATTR_VALUE_CAP = 2048;
const ANCHOR_TEXT_CAP = 300;
const MAX_ANCHORS = 2000;
const MAX_LINKS = 500;
const MAX_GENERATORS = 10;

export type ScannedElement = { tag: string; attrs: Record<string, string> };

export type ScannedAnchor = {
  href: string;
  title: string;
  ariaLabel: string;
  className: string;
  /** Text content (whitespace-collapsed, capped), including inline SVG `<title>` text. */
  text: string;
  imgAlts: string[];
  /** Inside header / footer / nav / aside / [role=contentinfo] / [role=banner]. */
  inChrome: boolean;
};

export type PageScan = {
  baseHref: string | null;
  links: ScannedElement[];
  anchors: ScannedAnchor[];
  generators: string[];
  scriptText: string;
  /** First element matching each requested selector (only selectors that matched). */
  selectorHits: Map<string, ScannedElement>;
  truncated: boolean;
};

/* -------------------------------------------------------------------------- */
/* Simple selectors: tag#id.class[attr op "value"] — no combinators            */
/* -------------------------------------------------------------------------- */

type AttrTest = { name: string; op: "exists" | "=" | "^=" | "*=" | "~="; value: string };
export type SimpleSelector = { tag: string | null; id: string | null; classes: string[]; attrs: AttrTest[] };

/**
 * Compiles a compound simple selector (`meta#data-discourse-setup`,
 * `a[href*="viewforum.php?f="]`, `[data-xf-init]`, `body.ipsApp`). Selectors
 * are trusted registry constants; anything outside this subset throws so a
 * registry typo fails the unit tests instead of silently never matching.
 */
export function compileSelector(selector: string): SimpleSelector {
  const out: SimpleSelector = { tag: null, id: null, classes: [], attrs: [] };
  let rest = selector.trim();
  const tag = /^[a-z][a-z0-9-]*/i.exec(rest);
  if (tag) {
    out.tag = tag[0].toLowerCase();
    rest = rest.slice(tag[0].length);
  }
  while (rest.length) {
    let m: RegExpExecArray | null;
    if ((m = /^#([\w-]+)/.exec(rest))) out.id = m[1];
    else if ((m = /^\.([\w-]+)/.exec(rest))) out.classes.push(m[1]);
    else if ((m = /^\[([\w-]+)\]/.exec(rest))) out.attrs.push({ name: m[1].toLowerCase(), op: "exists", value: "" });
    else if ((m = /^\[([\w-]+)(=|\^=|\*=|~=)"([^"]*)"\]/.exec(rest))) {
      out.attrs.push({ name: m[1].toLowerCase(), op: m[2] as AttrTest["op"], value: m[3] });
    } else throw new Error(`Unsupported selector: ${selector}`);
    rest = rest.slice(m[0].length);
  }
  return out;
}

function matches(sel: SimpleSelector, tag: string, attrs: Record<string, string>): boolean {
  if (sel.tag && sel.tag !== tag) return false;
  if (sel.id !== null && attrs.id !== sel.id) return false;
  if (sel.classes.length) {
    const classes = (attrs.class ?? "").split(/\s+/);
    if (!sel.classes.every((c) => classes.includes(c))) return false;
  }
  for (const t of sel.attrs) {
    const v = attrs[t.name];
    if (v === undefined) return false;
    if (t.op === "=" && v !== t.value) return false;
    if (t.op === "^=" && !v.startsWith(t.value)) return false;
    if (t.op === "*=" && !v.includes(t.value)) return false;
    if (t.op === "~=" && !v.split(/\s+/).includes(t.value)) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Scan                                                                        */
/* -------------------------------------------------------------------------- */

const CHROME_TAGS = new Set(["header", "footer", "nav", "aside"]);
const CHROME_ROLES = new Set(["contentinfo", "banner"]);
/** Elements that never have children (no close tag to wait for). */
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** Open-element bookkeeping limits: deeper nesting is counted, not stored; a close tag searches at most this far. */
const MAX_STACK = 4096;
const CLOSE_SEARCH = 64;
const MAX_ATTRS = 64;

function capAttrs(attribs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attribs)) out[k] = v.length > ATTR_VALUE_CAP ? v.slice(0, ATTR_VALUE_CAP) : v;
  return out;
}

export function scanHtml(html: string, options: { selectors?: string[] } = {}): PageScan {
  const truncated = html.length > HTML_SCAN_MAX_CHARS;
  const input = truncated ? html.slice(0, HTML_SCAN_MAX_CHARS) : html;
  const compiled = (options.selectors ?? []).map((s) => [s, compileSelector(s)] as const);
  const pending = new Set(compiled.map(([s]) => s));

  const scan: PageScan = {
    baseHref: null,
    links: [],
    anchors: [],
    generators: [],
    scriptText: "",
    selectorHits: new Map(),
    truncated,
  };

  // Open elements: explicit, bounded stack (tag + whether it is site chrome).
  const stack: Array<{ tag: string; chrome: boolean }> = [];
  let overflow = 0;
  let chromeDepth = 0;
  let anchor: (ScannedAnchor & { depth: number }) | null = null;
  let inInlineScript = false;

  const finishAnchor = () => {
    if (!anchor) return;
    const { depth: _depth, ...a } = anchor;
    a.text = a.text.replace(/\s+/g, " ").trim();
    scan.anchors.push(a);
    anchor = null;
  };
  const popTo = (len: number) => {
    while (stack.length > len) {
      const el = stack.pop()!;
      if (el.chrome) chromeDepth--;
      if (anchor && stack.length < anchor.depth) finishAnchor();
    }
  };

  const openElement = (name: string, attribs: Record<string, string>, selfClosing: boolean) => {
    if (pending.size) {
      for (const [s, sel] of compiled) {
        if (pending.has(s) && matches(sel, name, attribs)) {
          scan.selectorHits.set(s, { tag: name, attrs: capAttrs(attribs) });
          pending.delete(s);
        }
      }
    }
    switch (name) {
      case "base":
        if (scan.baseHref === null && attribs.href) scan.baseHref = attribs.href.slice(0, ATTR_VALUE_CAP);
        break;
      case "link":
        if (scan.links.length < MAX_LINKS) scan.links.push({ tag: name, attrs: capAttrs(attribs) });
        break;
      case "meta":
        if ((attribs.name ?? "").trim().toLowerCase() === "generator" && scan.generators.length < MAX_GENERATORS) {
          const v = (attribs.content ?? "").trim().slice(0, 200);
          if (v) scan.generators.push(v);
        }
        break;
      case "img":
        if (anchor && attribs.alt && anchor.imgAlts.length < 5) anchor.imgAlts.push(attribs.alt.slice(0, ANCHOR_TEXT_CAP));
        break;
      case "script":
        inInlineScript = !selfClosing && attribs.src === undefined;
        break;
    }
    if (VOID_TAGS.has(name) || selfClosing) return;
    if (name === "a") finishAnchor(); // an `<a>` never nests: a new one ends the previous
    if (stack.length >= MAX_STACK) {
      overflow++;
      return;
    }
    const chrome = CHROME_TAGS.has(name) || CHROME_ROLES.has((attribs.role ?? "").toLowerCase());
    stack.push({ tag: name, chrome });
    if (chrome) chromeDepth++;
    if (name === "a" && attribs.href !== undefined && scan.anchors.length < MAX_ANCHORS) {
      anchor = {
        href: attribs.href.slice(0, ATTR_VALUE_CAP),
        title: (attribs.title ?? "").slice(0, ANCHOR_TEXT_CAP),
        ariaLabel: (attribs["aria-label"] ?? "").slice(0, ANCHOR_TEXT_CAP),
        className: (attribs.class ?? "").slice(0, ANCHOR_TEXT_CAP),
        text: "",
        imgAlts: [],
        inChrome: chromeDepth > 0,
        depth: stack.length,
      };
    }
  };

  const closeElement = (name: string) => {
    if (name === "script" && inInlineScript) {
      inInlineScript = false;
      if (scan.scriptText.length < SCRIPT_TEXT_CAP) scan.scriptText += "\n";
    }
    if (overflow > 0) {
      overflow--;
      return;
    }
    // Bounded search from the top: an unmatched close tag is ignored.
    for (let i = stack.length - 1, n = 0; i >= 0 && n < CLOSE_SEARCH; i--, n++) {
      if (stack[i].tag === name) {
        popTo(i);
        return;
      }
    }
  };

  const appendText = (text: string) => {
    if (inInlineScript) {
      if (scan.scriptText.length < SCRIPT_TEXT_CAP) scan.scriptText += text.slice(0, SCRIPT_TEXT_CAP - scan.scriptText.length);
      return;
    }
    if (anchor && anchor.text.length < ANCHOR_TEXT_CAP) anchor.text += text.slice(0, ANCHOR_TEXT_CAP - anchor.text.length);
  };

  // Tokenizer state for the tag being read.
  let tagName = "";
  let attribs: Record<string, string> = {};
  let attrCount = 0;
  let attrName = "";
  let attrValue = "";
  const fromCodePoint = (cp: number) => {
    try {
      return String.fromCodePoint(cp);
    } catch {
      return "\uFFFD";
    }
  };

  const tokenizer = new Tokenizer(
    { decodeEntities: true, recognizeSelfClosing: false },
    {
      onopentagname(start, end) {
        tagName = input.slice(start, end).toLowerCase();
        attribs = {};
        attrCount = 0;
      },
      onattribname(start, end) {
        attrName = input.slice(start, end).toLowerCase();
        attrValue = "";
      },
      onattribdata(start, end) {
        if (attrValue.length < ATTR_VALUE_CAP) attrValue += input.slice(start, Math.min(end, start + ATTR_VALUE_CAP - attrValue.length));
      },
      onattribentity(cp) {
        if (attrValue.length < ATTR_VALUE_CAP) attrValue += fromCodePoint(cp);
      },
      onattribend(_quote: QuoteType) {
        // First occurrence wins (HTML semantics); bounded attribute count.
        if (attrCount < MAX_ATTRS && !(attrName in attribs)) {
          attribs[attrName] = attrValue;
          attrCount++;
        }
      },
      onopentagend() {
        openElement(tagName, attribs, false);
      },
      onselfclosingtag() {
        // `<x/>` in HTML is an open tag (void or not); foreign `<svg/>` closes itself.
        openElement(tagName, attribs, tagName === "svg" || tagName === "path" || tagName === "use");
      },
      onclosetag(start, end) {
        closeElement(input.slice(start, end).toLowerCase());
      },
      ontext(start, end) {
        appendText(input.slice(start, end));
      },
      ontextentity(cp) {
        appendText(fromCodePoint(cp));
      },
      oncdata() {},
      oncomment() {},
      ondeclaration() {},
      onprocessinginstruction() {},
      onend() {},
    },
  );
  tokenizer.write(input);
  tokenizer.end();
  popTo(0);
  finishAnchor();
  return scan;
}
