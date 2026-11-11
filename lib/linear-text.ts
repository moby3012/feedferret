// Linear-time replacements for the regexes that used to run over untrusted
// text (feed item HTML, fetched pages, e-mail headers, AI output, log lines).
//
// Why this file exists: Node has a single event loop, and V8's backtracking
// engine is super-linear on patterns such as `/<[^>]*>/g` ("<<<<<…" without a
// ">" re-scans to the end of the string from every "<": O(n²)), `/\/+$/`
// ("////…x" re-scans the run from every "/") or `/\s+(?=x)/` on long
// whitespace runs. A hostile 1 MiB feed item then freezes the whole instance
// for minutes. Every helper below is O(n) in the input length and matches
// exactly what the regex it replaces matched (see tests/lib/linear-text.test.ts,
// which diffs each helper against its legacy regex on random inputs).
//
// Rule of thumb for new code: don't put `[^>]*`, `\s*`/`\s+` followed by
// something that can fail, `X+$`, or lazy `[\s\S]*?` on text that comes from
// the network or a user. Use these helpers, a DOM parser, or cap the input.

const CH_LT = 0x3c; // <
const CH_GT = 0x3e; // >

function isWordCode(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

const WS_RE = /\s/;
function isWs(ch: string): boolean {
  return WS_RE.test(ch);
}

/** ASCII-case-insensitive compare of `s` at `pos` with the lowercase ASCII `lower`. */
function matchLowerAt(s: string, pos: number, lower: string): boolean {
  if (pos + lower.length > s.length) return false;
  for (let k = 0; k < lower.length; k++) {
    let c = s.charCodeAt(pos + k);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== lower.charCodeAt(k)) return false;
  }
  return true;
}

/** ASCII-case-insensitive `indexOf` for a needle that starts with "<". */
function indexOfTagCI(s: string, lowerNeedle: string, from: number): number {
  let i = from;
  while ((i = s.indexOf("<", i)) !== -1) {
    if (matchLowerAt(s, i, lowerNeedle)) return i;
    i++;
  }
  return -1;
}

// --------------------------------------------------------------------- tags

/** Linear `html.replace(/<[^>]*>/g, replacement)`. */
export function stripTags(html: string, replacement = " "): string {
  return replaceTagSpans(html, replacement, 0);
}

/** Linear `html.replace(/<[^>]+>/g, replacement)` (a `<>` pair is not a tag). */
export function stripTagsNonEmpty(html: string, replacement = " "): string {
  return replaceTagSpans(html, replacement, 1);
}

function replaceTagSpans(html: string, replacement: string, minInner: number): string {
  let lt = html.indexOf("<");
  if (lt === -1) return html;
  let out = "";
  let last = 0;
  while (lt !== -1) {
    const gt = html.indexOf(">", lt + 1);
    // No ">" anywhere after this "<" ⇒ none after any later "<" either.
    if (gt === -1) break;
    if (gt - lt - 1 >= minInner) {
      out += html.slice(last, lt) + replacement;
      last = gt + 1;
      lt = html.indexOf("<", gt + 1);
    } else {
      lt = html.indexOf("<", lt + 1);
    }
  }
  return out + html.slice(last);
}

export interface OpenTag {
  /** Index of "<". */
  start: number;
  /** Index just after ">". */
  end: number;
}

/**
 * Linear equivalent of iterating `/<name\b[^>]*>/gi` (or `/<name[^>]*>/gi` with
 * `boundary: false`) over `html`. `name` must be lowercase ASCII.
 */
export function* iterOpenTags(html: string, name: string, boundary = true): Generator<OpenTag> {
  let i = 0;
  while ((i = html.indexOf("<", i)) !== -1) {
    const nameEnd = i + 1 + name.length;
    if (matchLowerAt(html, i + 1, name) && (!boundary || !isWordCode(html.charCodeAt(nameEnd)))) {
      const gt = html.indexOf(">", nameEnd);
      if (gt === -1) return;
      yield { start: i, end: gt + 1 };
      i = gt + 1;
    } else {
      i++;
    }
  }
}

/** Linear `html.match(/<name\b[^>]*>/gi) ?? []`. */
export function matchOpenTags(html: string, name: string, boundary = true): string[] {
  const out: string[] = [];
  for (const t of iterOpenTags(html, name, boundary)) out.push(html.slice(t.start, t.end));
  return out;
}

/** Linear `html.replace(/<!--[\s\S]*?-->/g, replacement)`: unterminated comments are left alone. */
export function replaceComments(html: string, replacement = " "): string {
  let out = "";
  let last = 0;
  let i = 0;
  while ((i = html.indexOf("<!--", i)) !== -1) {
    const end = html.indexOf("-->", i + 4);
    if (end === -1) break; // no terminator left for any later "<!--" either
    out += html.slice(last, i) + replacement;
    last = end + 3;
    i = last;
  }
  return out + html.slice(last);
}

/**
 * Linear `html.replace(/<\/?(?:n1|n2|…)\b[^>]*>/gi, replacement)`: replaces every
 * opening or closing tag whose name is in `names` (lowercase ASCII, any case in
 * the input) with `replacement`.
 */
export function replaceTagsNamed(html: string, names: ReadonlySet<string>, replacement: string): string {
  let out = "";
  let last = 0;
  let i = 0;
  while ((i = html.indexOf("<", i)) !== -1) {
    let p = i + 1;
    if (html.charCodeAt(p) === 0x2f) p++;
    let q = p;
    while (q < html.length && isWordCode(html.charCodeAt(q))) q++;
    if (q > p && names.has(html.slice(p, q).toLowerCase())) {
      const gt = html.indexOf(">", q);
      if (gt === -1) break;
      out += html.slice(last, i) + replacement;
      last = gt + 1;
      i = gt + 1;
    } else {
      i++;
    }
  }
  return out + html.slice(last);
}

export interface RemoveElementsOptions {
  /** Require a word boundary after the tag name (`<style\b`). Default true. */
  boundary?: boolean;
  /** Accept `</name  >` (whitespace before ">") as the closing tag. Default false. */
  closeTagWhitespace?: boolean;
  /** An element without closing tag swallows the rest of the input (the `|$` form). Default false. */
  unclosedToEnd?: boolean;
  /** Replace only the first `limit` elements (non-global regex). Default: all. */
  limit?: number;
}

/**
 * Linear equivalent of
 * `html.replace(/<(a|b|c)\b[^>]*>[\s\S]*?<\/\1>/gi, replacement)` for lowercase
 * ASCII `names` (variants via `options`).
 */
export function replaceElements(
  html: string,
  names: readonly string[],
  replacement: string,
  options: RemoveElementsOptions = {},
): string {
  const { boundary = true, closeTagWhitespace = false, unclosedToEnd = false, limit = Infinity } = options;
  let replaced = 0;
  const noClose = new Set<string>();
  let out = "";
  let last = 0;
  let i = 0;
  while ((i = html.indexOf("<", i)) !== -1) {
    let hit: string | null = null;
    for (const n of names) {
      if (noClose.has(n)) continue;
      if (!matchLowerAt(html, i + 1, n)) continue;
      if (boundary && isWordCode(html.charCodeAt(i + 1 + n.length))) continue;
      hit = n;
      break;
    }
    if (hit === null) {
      i++;
      continue;
    }
    const gt = html.indexOf(">", i + 1 + hit.length);
    if (gt === -1) break; // no ">" left: no later open tag can complete either
    const closeAt = findClose(html, hit, gt + 1, closeTagWhitespace);
    if (closeAt === null) {
      if (unclosedToEnd) {
        out += html.slice(last, i) + replacement;
        return out;
      }
      noClose.add(hit);
      if (noClose.size === names.length) break;
      i++;
      continue;
    }
    out += html.slice(last, i) + replacement;
    last = closeAt;
    i = closeAt;
    if (++replaced >= limit) break;
  }
  return out + html.slice(last);
}

function findClose(html: string, name: string, from: number, allowWs: boolean): number | null {
  const needle = `</${name}`;
  let at = from;
  while ((at = indexOfTagCI(html, needle, at)) !== -1) {
    let p = at + needle.length;
    if (allowWs) while (p < html.length && isWs(html[p])) p++;
    if (html.charCodeAt(p) === CH_GT) return p + 1;
    at++;
  }
  return null;
}

/**
 * Linear equivalent of `/<name\b[^>]*>([\s\S]*?)<\/name>/gi` matchAll: yields
 * the inner HTML of each element, in order.
 */
export function* iterElementInners(html: string, name: string): Generator<string> {
  const close = `</${name}`;
  let i = 0;
  while ((i = html.indexOf("<", i)) !== -1) {
    if (!matchLowerAt(html, i + 1, name) || isWordCode(html.charCodeAt(i + 1 + name.length))) {
      i++;
      continue;
    }
    const gt = html.indexOf(">", i + 1 + name.length);
    if (gt === -1) return;
    const innerEnd = findCloseStart(html, close, gt + 1);
    if (innerEnd === -1) return;
    yield html.slice(gt + 1, innerEnd);
    i = innerEnd + close.length + 1;
  }
}

function findCloseStart(html: string, closeNoGt: string, from: number): number {
  let at = from;
  while ((at = indexOfTagCI(html, closeNoGt, at)) !== -1) {
    if (html.charCodeAt(at + closeNoGt.length) === CH_GT) return at;
    at++;
  }
  return -1;
}

/**
 * Linear equivalent of `html.search(/<[a-z]+\b[^>]*\brole\s*=\s*["']?main\b/i) >= 0`
 * (the first tag whose attributes contain `role=main`).
 */
export function findRoleMainTag(html: string): number {
  const ROLE_MAIN = /\brole\s*=\s*["']?main\b/i;
  let i = 0;
  while ((i = html.indexOf("<", i)) !== -1) {
    let p = i + 1;
    while (p < html.length && /[a-zA-Z]/.test(html[p])) p++;
    // `[a-z]+\b`: at least one letter, then a word boundary (next is not a word char).
    if (p > i + 1 && !isWordCode(html.charCodeAt(p))) {
      const gt = html.indexOf(">", p);
      const segment = html.slice(p, gt === -1 ? html.length : gt);
      if (ROLE_MAIN.test(segment)) return i;
      // Any later "<" before this segment's end sees a suffix of the same segment.
      if (gt === -1) return -1;
      i = gt + 1;
    } else {
      i++;
    }
  }
  return -1;
}

/**
 * Linear equivalent of `html.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] ?? null`:
 * the src value of the first `<img … src="…">` whose value is terminated.
 */
export function firstImgSrc(html: string): string | null {
  const SRC = /src=["']/gi;
  const VALUE = /[^"']+["']/y;
  let i = 0;
  for (;;) {
    i = indexOfTagCI(html, "<img", i);
    if (i === -1) return null;
    const segStart = i + 4; // `[^>]+` needs ≥ 1 char between "<img" and "src="
    const gt = html.indexOf(">", segStart);
    const segEnd = gt === -1 ? html.length : gt;
    // `src=` + quote can only sit inside the "<img …" segment (no ">" before it).
    const segment = html.slice(segStart + 1, segEnd);
    SRC.lastIndex = 0;
    for (let m = SRC.exec(segment); m !== null; m = SRC.exec(segment)) {
      VALUE.lastIndex = segStart + 1 + m.index + m[0].length;
      const v = VALUE.exec(html);
      if (v) return v[0].slice(0, -1);
    }
    // Later "<img" inside this segment would only see a suffix of it.
    if (gt === -1) return null;
    i = gt + 1;
  }
}

// -------------------------------------------------------------- trailing runs

/** Linear `s.replace(/X+$/, "")` where X is a set of single UTF-16 units. */
export function trimEndWhile(s: string, pred: (ch: string) => boolean): string {
  let end = s.length;
  while (end > 0 && pred(s[end - 1])) end--;
  return end === s.length ? s : s.slice(0, end);
}

/** Linear `s.replace(new RegExp(`[${chars}]+$`), "")` for literal `chars`. */
export function trimEndChars(s: string, chars: string): string {
  return trimEndWhile(s, (ch) => chars.includes(ch));
}

/** Linear `s.replace(/\/+$/, "")`. */
export function trimTrailingSlashes(s: string): string {
  return trimEndChars(s, "/");
}

/** Linear `s.replace(/\s+$/, "")` (same as `String#trimEnd`). */
export function trimEndWs(s: string): string {
  return s.trimEnd();
}

// ------------------------------------------------------------------ e-mail

const ADDRESS_SEPARATORS = /[\s<>"',;:()[\]]+/;

/**
 * Linear equivalent of `text.match(/[^\s<>"',;:()[\]]+@[^\s<>"',;:()[\]]+/g)`:
 * maximal runs of address characters that contain an "@" with at least one
 * character on each side. (The regex's leftmost-greedy match is always the whole
 * run, so splitting on the separators is exact.)
 */
export function matchAddressRuns(text: string): string[] {
  return text.split(ADDRESS_SEPARATORS).filter(isAddressRun);
}

/** Same, with the narrower separator set `[\s<>"'(),;:]` (brackets allowed). */
export function matchAddressRunsLoose(text: string): string[] {
  return text.split(/[\s<>"'(),;:]+/).filter(isAddressRun);
}

/** `run` is a maximal separator-free run: does `/^.+@.+$/` hold with "@" strictly inside? */
export function isAddressRun(run: string): boolean {
  const at = run.indexOf("@", 1);
  return at !== -1 && at <= run.length - 2;
}

/** Replace each address run (loose separators) via `fn`; linear. */
export function replaceAddressRunsLoose(text: string, fn: (run: string) => string): string {
  return text.replace(/[^\s<>"'(),;:]+/g, (run) => (isAddressRun(run) ? fn(run) : run));
}

/** Linear `/[^\s@]+@[^\s@]+\.[^\s@]+/.test(text)`. */
export function looksLikeEmail(text: string): boolean {
  for (const token of text.split(/\s+/)) {
    const parts = token.split("@");
    for (let k = 0; k + 1 < parts.length; k++) {
      if (parts[k].length === 0) continue;
      const host = parts[k + 1];
      const dot = host.indexOf(".", 1);
      if (dot !== -1 && dot <= host.length - 2) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- markdown

/**
 * Linear `md.replace(/!?\[([^\]]*)\]\([^)]*\)/g, (_, text) => fn(text))` —
 * `image: true` matches only `![…](…)`, `false` only `[…](…)` (a leading "!"
 * is then not special, exactly like the regex).
 */
export function replaceMarkdownLinks(md: string, image: boolean, fn: (text: string) => string): string {
  const open = image ? "![" : "[";
  let out = "";
  let last = 0;
  let i = 0;
  for (;;) {
    const lb = md.indexOf(open, i);
    if (lb === -1) break;
    const textStart = lb + open.length;
    const rb = md.indexOf("]", textStart);
    if (rb === -1) break; // no "]" left: no later "[" can close either
    if (md.charCodeAt(rb + 1) !== 0x28) {
      i = rb + 1; // every "[" before this "]" shares it and fails the same way
      continue;
    }
    const rp = md.indexOf(")", rb + 2);
    if (rp === -1) break; // no ")" left: no later link can close either
    out += md.slice(last, lb) + fn(md.slice(textStart, rb));
    last = rp + 1;
    i = rp + 1;
  }
  return out + md.slice(last);
}

// ------------------------------------------------------------ URLs in text

function isSchemeChar(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46;
}
function isAsciiLetter(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
}

/**
 * Linear `text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, replacement)`:
 * removes `scheme://…` up to the next whitespace.
 */
export function replaceSchemeUrls(text: string, replacement: string): string {
  let out = "";
  let last = 0;
  let from = 0;
  for (;;) {
    const sep = text.indexOf("://", from);
    if (sep === -1) break;
    // Scheme run directly left of "://", not reaching into the previous match.
    let runStart = sep;
    while (runStart > last && isSchemeChar(text.charCodeAt(runStart - 1))) runStart--;
    // Leftmost letter in the run that starts at a word boundary.
    let start = -1;
    for (let k = runStart; k < sep; k++) {
      if (isAsciiLetter(text.charCodeAt(k)) && (k === 0 || !isWordCode(text.charCodeAt(k - 1)))) {
        start = k;
        break;
      }
    }
    const urlEnd = sep + 3;
    if (start === -1 || urlEnd >= text.length || isWs(text[urlEnd])) {
      from = sep + 1;
      continue;
    }
    let end = urlEnd;
    while (end < text.length && !isWs(text[end])) end++;
    out += text.slice(last, start) + replacement;
    last = end;
    from = end;
  }
  return out + text.slice(last);
}

// ------------------------------------------------------------ log redaction

const REDACT_PARAM_KEY = /(?:key|token|secret|passw(?:or)?d|pwd|auth|sig(?:nature)?)%3d/iy;
const HEX = /[0-9a-f]/i;

/**
 * Linear equivalent of
 * `text.replace(/((?:%3f|%26|%23|%3b)(?:[\w.-]|%[0-9a-f]{2})*?(?:key|token|secret|passw(?:or)?d|pwd|auth|sig(?:nature)?)%3d)(?:(?!%26|%23|%3b)[^&#\s"'])*\/gi, "$1***")`
 * — masks percent-encoded query values (`…%26api_key%3Dxyz`). The lazy prefix
 * is walked once per marker run instead of being re-scanned from every marker.
 */
export function redactEncodedParamValues(text: string): string {
  const MARKER = /%3f|%26|%23|%3b/gi;
  let out = "";
  let last = 0;
  MARKER.lastIndex = 0;
  for (let m = MARKER.exec(text); m !== null; m = MARKER.exec(text)) {
    let t = m.index + 3;
    let keyEnd = -1;
    for (;;) {
      REDACT_PARAM_KEY.lastIndex = t;
      const k = REDACT_PARAM_KEY.exec(text);
      if (k) {
        keyEnd = t + k[0].length;
        break;
      }
      const c = text.charCodeAt(t);
      if (c === 0x25 /* % */) {
        if (t + 2 < text.length && HEX.test(text[t + 1] ?? "") && HEX.test(text[t + 2] ?? "")) t += 3;
        else break;
      } else if (isWordCode(c) || c === 0x2e || c === 0x2d) {
        t++;
      } else {
        break;
      }
    }
    if (keyEnd === -1) {
      // Markers inside this token run would only see a suffix of it.
      MARKER.lastIndex = Math.max(t, m.index + 1);
      continue;
    }
    // Value: anything up to "&", "#", whitespace, a quote, or an encoded delimiter.
    let v = keyEnd;
    while (v < text.length) {
      const c = text[v];
      if (c === "&" || c === "#" || c === '"' || c === "'" || isWs(c)) break;
      if (c === "%" && /^%(?:26|23|3b)/i.test(text.slice(v, v + 3))) break;
      v++;
    }
    out += text.slice(last, keyEnd) + "***";
    last = v;
    MARKER.lastIndex = v;
  }
  return out + text.slice(last);
}

/**
 * Linear `text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/gi, "$1***@")` —
 * masks `scheme://user:pass@host` credentials.
 */
export function redactUrlUserinfo(text: string): string {
  let out = "";
  let last = 0;
  let from = 0;
  for (;;) {
    const sep = text.indexOf("://", from);
    if (sep === -1) break;
    let runStart = sep;
    while (runStart > last && isSchemeChar(text.charCodeAt(runStart - 1))) runStart--;
    let start = -1;
    for (let k = runStart; k < sep; k++) {
      if (isAsciiLetter(text.charCodeAt(k))) {
        start = k;
        break;
      }
    }
    if (start === -1) {
      from = sep + 1;
      continue;
    }
    // `[^\s/?#]+@`: userinfo runs to the first whitespace, "/", "?" or "#".
    const infoStart = sep + 3;
    let infoEnd = infoStart;
    while (infoEnd < text.length) {
      const c = text[infoEnd];
      if (c === "/" || c === "?" || c === "#" || isWs(c)) break;
      infoEnd++;
    }
    // Last "@" inside the userinfo segment (bounded: a plain lastIndexOf would walk back to the string start).
    let at = infoEnd - 1;
    while (at >= infoStart + 1 && text.charCodeAt(at) !== 0x40) at--;
    if (at < infoStart + 1) {
      from = sep + 1;
      continue;
    }
    out += text.slice(last, infoStart) + "***@";
    last = at + 1;
    from = at + 1;
  }
  return out + text.slice(last);
}

// --------------------------------------------------------------- misc text

/** Linear `s.replace(/\s+([.,;:!?])/g, "$1")`: drop whitespace in front of punctuation. */
export function removeSpaceBeforePunctuation(s: string): string {
  return s.replace(/\s+/g, (run, offset: number) => (".,;:!?".includes(s[offset + run.length] ?? "\0") ? "" : run));
}

/** Linear form of replacing `\s*\n\s*` with a space: whitespace runs that contain a newline become one space. */
export function collapseNewlineWhitespace(s: string): string {
  return s.replace(/\s+/g, (run) => (run.includes("\n") ? " " : run));
}

/**
 * Linear `/\s+[-|–—·:]\s+(?=[^-|–—·:]*$)/.exec(title)`: the whitespace-padded
 * separator that is the LAST separator character of `title`.
 */
export function findLastPaddedSeparator(title: string): { index: number; length: number } | null {
  let sep = -1;
  for (let k = title.length - 1; k >= 0; k--) {
    if ("-|–—·:".includes(title[k])) {
      sep = k;
      break;
    }
  }
  if (sep <= 0 || sep >= title.length - 1) return null;
  if (!isWs(title[sep - 1]) || !isWs(title[sep + 1])) return null;
  let start = sep;
  while (start > 0 && isWs(title[start - 1])) start--;
  let end = sep + 1;
  while (end < title.length && isWs(title[end])) end++;
  return { index: start, length: end - start };
}

// -------------------------------------------------------------- CSS values

/**
 * Linear `[...value.matchAll(/([a-z0-9_-]*)\s*\(/gi)].map((m) => m[1])`: the
 * (possibly empty) identifier in front of every "(" — i.e. the CSS function
 * names used in a value.
 */
export function cssFunctionNames(value: string): string[] {
  const names: string[] = [];
  let open = value.indexOf("(");
  while (open !== -1) {
    let end = open;
    while (end > 0 && isWs(value[end - 1])) end--;
    let start = end;
    while (start > 0) {
      const c = value.charCodeAt(start - 1);
      if (isWordCode(c) || c === 0x2d) start--;
      else break;
    }
    names.push(value.slice(start, end));
    open = value.indexOf("(", open + 1);
  }
  return names;
}

// ---------------------------------------------------------------- AI output

/**
 * Linear `text.replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu, replacement)`.
 * A start inside a local-part run reaches the same "@" as the run's first
 * character and can only match if that one does, so only run starts are tried
 * (lookbehind) — plus the position right after a previous match, which the
 * lookbehind would wrongly block (checked with a sticky regex).
 */
export function replaceEmailAddresses(text: string, replacement: string): string {
  let out = "";
  let last = 0;
  let pos = 0;
  for (;;) {
    EMAIL_AT_RUN_START.lastIndex = pos;
    const m = EMAIL_AT_RUN_START.exec(text);
    if (!m) break;
    let end = m.index + m[0].length;
    out += text.slice(last, m.index) + replacement;
    for (;;) {
      EMAIL_STICKY.lastIndex = end;
      const next = EMAIL_STICKY.exec(text);
      if (!next) break;
      out += replacement;
      end += next[0].length;
    }
    last = end;
    pos = end;
  }
  return out + text.slice(last);
}
const EMAIL_BODY = "[\\p{L}\\p{N}._%+-]+@[\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)+";
const EMAIL_AT_RUN_START = new RegExp(`(?<![\\p{L}\\p{N}._%+-])${EMAIL_BODY}`, "gu");
const EMAIL_STICKY = new RegExp(EMAIL_BODY, "uy");

/**
 * Linear `s.replace(/#.*$/, "")`: drops the first "#" that has no line
 * terminator after it, together with everything behind it.
 */
export function stripFragment(s: string): string {
  let lastBreak = -1;
  for (let k = s.length - 1; k >= 0; k--) {
    const c = s.charCodeAt(k);
    if (c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029) {
      lastBreak = k;
      break;
    }
  }
  const hash = s.indexOf("#", lastBreak + 1);
  return hash === -1 ? s : s.slice(0, hash);
}
