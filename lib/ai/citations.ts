// Citation-checked model output (K2, shared with K4). The model only ever sees
// short aliases (s1…s30) for the stories of THIS request; its output is parsed
// line by line while streaming, every citation is resolved through the alias
// table, and only validated plain-text items leave the server. Unknown
// citations (hallucinated, or ids injected by article text) are removed and
// counted; a line left without a valid citation is dropped.

/** Removed from untrusted (feed) text before it enters a prompt. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const BIDI = /[‪-‮⁦-⁩‎‏؜]/g;
const ZERO_WIDTH = /[​-‍⁠-⁤﻿­]/g;

export interface AliasMap<T> {
  /** alias ("s3") → value */
  byAlias: Map<string, T>;
  aliases: string[];
}

export function buildAliasMap<T>(values: T[], prefix = "s"): AliasMap<T> {
  const byAlias = new Map<string, T>();
  const aliases: string[] = [];
  values.forEach((value, i) => {
    const alias = `${prefix}${i + 1}`;
    byAlias.set(alias, value);
    aliases.push(alias);
  });
  return { byAlias, aliases };
}

/**
 * Untrusted text → prompt-safe single line: no `<`/`>` (cannot open or close a
 * `<story>` block), no `[[`/`]]` (cannot forge a citation), no control, bidi
 * or zero-width characters; whitespace collapsed.
 */
export function escapeUntrusted(text: string): string {
  return text
    .replace(/[<>]/g, " ")
    .replace(/\[\[|\]\]/g, " ")
    .replace(/["]/g, "'")
    .replace(CONTROL, " ")
    .replace(BIDI, "")
    .replace(ZERO_WIDTH, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const MAX_ITEM_CHARS = 300;

/**
 * Model text → plain text for rendering: HTML tags and markdown markers
 * stripped, URLs removed, control/bidi/zero-width characters removed,
 * whitespace collapsed, capped at `maxChars` (default 300).
 */
export function sanitizeOutputText(text: string, maxChars = MAX_ITEM_CHARS): string {
  let out = text
    .replace(/<[^>]*>?/g, " ")
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    .replace(/[*_`#>]+/g, "")
    .replace(/[<]/g, "")
    .replace(CONTROL, " ")
    .replace(/[\n\r\t]/g, " ")
    .replace(BIDI, "")
    .replace(ZERO_WIDTH, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-–—:;,.\s]+/, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1).trimEnd()}…`;
  return out;
}

/** Caps of the model output that reaches the digest mail. */
export const DIGEST_SUMMARY_MAX_CHARS = 2_000;
export const DIGEST_SUBJECT_MAX_CHARS = 120;

// Removed outright: scheme URLs (`https://…`, `ftp://…`), e-mail addresses and `www.` tokens.
const SCHEME_URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const WWW = /\bwww\.\S+/gi;
// Domain-like tokens (`evil-login.com`, `a.b.example`, `bank.xn--p1ai`): labels separated by dots,
// ending in a TLD of 2+ letters (or punycode). Numbers such as `4.5` or `v1.2` never match.
const LABEL = "[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?";
// Dots include the full-width / ideographic forms some clients also accept as separators.
const DOT = "[.\\u3002\\uFF0E\\uFF61]";
const DOMAIN_LIKE = new RegExp(`(?<![\\p{L}\\p{N}_@.-])${LABEL}(?:${DOT}${LABEL})*${DOT}(?:\\p{L}{2,}|xn--[a-z0-9-]+)(?![\\p{L}\\p{N}_-])`, "giu");

/**
 * N14: makes model output safe for a mail client that auto-links anything
 * that looks like an address. Scheme URLs, e-mail addresses and `www.` tokens
 * are removed; every other domain-like token is DEFANGED (`evil-login[.]com`)
 * rather than deleted, so ordinary text such as "Node.js/Deno" stays readable
 * ("Node[.]js/Deno") and numbers ("rated 4.5/5") are untouched.
 */
export function neutralizeLinks(text: string): string {
  return text
    .replace(SCHEME_URL, " ")
    .replace(EMAIL, " ")
    .replace(WWW, " ")
    .replace(DOMAIN_LIKE, (token) => token.replace(new RegExp(DOT, "gu"), "[.]"));
}

/**
 * Model output → digest-mail-safe plain text (N14): links neutralised
 * (`neutralizeLinks`), then per paragraph through `sanitizeOutputText` (no
 * HTML/markdown, no control/bidi chars); paragraphs kept (the mail renders
 * `pre-wrap`), total capped.
 */
export function sanitizeDigestSummary(text: string): string {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map(neutralizeLinks)
    .map((p) => sanitizeOutputText(p, DIGEST_SUMMARY_MAX_CHARS))
    .filter(Boolean);
  const out = paragraphs.join("\n\n");
  return out.length > DIGEST_SUMMARY_MAX_CHARS ? `${out.slice(0, DIGEST_SUMMARY_MAX_CHARS - 1).trimEnd()}…` : out;
}

/** Model output → one-line subject: sanitised, quotes stripped, capped. */
export function sanitizeDigestSubject(text: string): string {
  return sanitizeOutputText(neutralizeLinks(text).replace(/["'«»“”„]/g, ""), DIGEST_SUBJECT_MAX_CHARS);
}

export type Section = "what" | "why" | "brief";
export const SECTION_CAPS: Record<Section, number> = { what: 5, why: 3, brief: 6 };

const HEADER = /^\s*(?:#{1,6}\s*|\*\*\s*)?(what|why|brief|was|warum|kurz)\b(?:\s*\*\*)?\s*:?\s*$/i;
const SECTION_OF: Record<string, Section> = { what: "what", was: "what", why: "why", warum: "why", brief: "brief", kurz: "brief" };
const ITEM = /^\s*(?:[-*•–]|\d+[.)])\s+(.+)$/;
/** `[[s3]]`, `[[ S3 ]]`, `[s3]`, `[[s1, s4]]` */
const CITATION = /\[{1,2}\s*([sS]\d{1,3}(?:\s*,\s*[sS]\d{1,3})*)\s*\]{1,2}/g;
/** Anything else in double brackets (forged ids, cuids, prose) is an unknown citation. */
const OTHER_BRACKET = /\[\[[^\]\n]{0,80}\]\]/g;

export interface ValidatedLine<T> {
  text: string;
  cited: T[];
  /** Unknown citations removed from this line. */
  unknown: number;
}

/** One item line → validated text + resolved citations (deduped, in order). `null` = not an item line. */
export function validateLine<T>(line: string, aliases: AliasMap<T>): ValidatedLine<T> | null {
  const m = ITEM.exec(line);
  if (!m) return null;
  let body = m[1];
  const cited: T[] = [];
  const seen = new Set<string>();
  let unknown = 0;
  body = body.replace(CITATION, (_all, list: string) => {
    for (const raw of list.split(",")) {
      const alias = raw.trim().toLowerCase();
      const value = aliases.byAlias.get(alias);
      if (value === undefined) unknown++;
      else if (!seen.has(alias)) {
        seen.add(alias);
        cited.push(value);
      }
    }
    return " ";
  });
  body = body.replace(OTHER_BRACKET, () => {
    unknown++;
    return " ";
  });
  return { text: sanitizeOutputText(body), cited, unknown };
}

// ─── Grounding guard ────────────────────────────────────────────────────────
// A validated citation proves the alias exists, not that the line is about
// that story. A line must share at least one content word with the title /
// excerpt of one of the stories it cites, else it is dropped (catches lines
// that hang a fabricated claim on a real alias).

const STOPWORDS = new Set(
  (
    "the and for with from that this these those are was were has have had will would can could should into onto over under after before about more most than then its it's their there they them our your you his her not but also just only very what when where which who whom why how all any some such been being does did out off per via new news " +
    "der die das den dem des und oder mit von vom für fur ein eine einer eines einem einen sich auf ist sind war waren wird werden wurde wurden nach bei aus auch wie als zum zur über uber unter dass nicht noch nur schon sehr mehr hat haben hatte kann können konnen soll sollen will diese dieser dieses diesem diesen jetzt heute neue neuer neues neuen einem gegen ohne seit beim durch weil wenn aber doch man sie ihr ihre ihren wir uns"
  ).split(/\s+/),
);

/** Normalized content words: lowercased, ≥ 3 letters (or ≥ 2 digits), no stopwords, cut to a 5-char stem. */
export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u)) {
    if (!word || STOPWORDS.has(word)) continue;
    if (/^\p{N}+$/u.test(word) ? word.length < 2 : word.length < 3) continue;
    out.add(word.slice(0, 5));
  }
  return out;
}

/** Whether `text` shares ≥ 1 content token with at least one of `sources`. */
export function isGrounded(text: string, sources: string[]): boolean {
  const words = contentTokens(text);
  if (words.size === 0) return false;
  return sources.some((source) => {
    for (const token of contentTokens(source)) if (words.has(token)) return true;
    return false;
  });
}

export interface ParsedItem<T> {
  section: Section;
  text: string;
  cited: T[];
}

export interface ParseResult<T> {
  items: ParsedItem<T>[];
  dropped: number;
  counts: Record<Section, number>;
}

/**
 * Line-buffered output validator: feed it stream chunks (`push`), get the
 * items validated so far; `end()` flushes the last partial line. A citation
 * split across chunks (`[[s` | `1]]`) is reassembled because only complete
 * lines are ever parsed.
 */
export class CitedOutputParser<T> {
  private buffer = "";
  private section: Section | null = null;
  private texts = new Set<string>();
  readonly counts: Record<Section, number> = { what: 0, why: 0, brief: 0 };
  dropped = 0;

  /**
   * `groundingText`: the source text of a cited value (title + excerpt). When
   * set, a line that shares no content word with any of its cited values is
   * dropped (see `isGrounded`).
   */
  constructor(
    private readonly aliases: AliasMap<T>,
    private readonly o: { groundingText?: (value: T) => string } = {},
  ) {}

  push(chunk: string): ParsedItem<T>[] {
    this.buffer += chunk;
    const out: ParsedItem<T>[] = [];
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      const item = this.line(this.buffer.slice(0, nl));
      if (item) out.push(item);
      this.buffer = this.buffer.slice(nl + 1);
      nl = this.buffer.indexOf("\n");
    }
    // A runaway line without newline can never become valid output: bound memory.
    if (this.buffer.length > 4000) this.buffer = this.buffer.slice(-4000);
    return out;
  }

  end(): ParsedItem<T>[] {
    const rest = this.buffer;
    this.buffer = "";
    const item = rest ? this.line(rest) : null;
    return item ? [item] : [];
  }

  private line(raw: string): ParsedItem<T> | null {
    const header = HEADER.exec(raw);
    if (header) {
      this.section = SECTION_OF[header[1].toLowerCase()];
      return null;
    }
    if (!this.section) return null; // preamble before the first header
    const v = validateLine(raw, this.aliases);
    if (!v) return null;
    this.dropped += v.unknown;
    if (v.cited.length === 0 || !v.text) {
      this.dropped++;
      return null;
    }
    const groundingText = this.o.groundingText;
    if (groundingText && !isGrounded(v.text, v.cited.map(groundingText))) {
      this.dropped++;
      return null;
    }
    const key = v.text.toLowerCase();
    if (this.texts.has(key) || this.counts[this.section] >= SECTION_CAPS[this.section]) return null;
    this.texts.add(key);
    this.counts[this.section]++;
    return { section: this.section, text: v.text, cited: v.cited };
  }
}

/** Whole-text convenience (tests, non-streamed output). */
export function parseCitedLines<T>(text: string, aliases: AliasMap<T>, o: { groundingText?: (value: T) => string } = {}): ParseResult<T> {
  const parser = new CitedOutputParser(aliases, o);
  const items = [...parser.push(text), ...parser.end()];
  return { items, dropped: parser.dropped, counts: parser.counts };
}

export type OutputStatus = "ok" | "partial" | "invalid_output";

export function outputStatus(counts: Record<Section, number>): OutputStatus {
  if (counts.what >= 2) return "ok";
  if (counts.what + counts.why >= 2) return "partial";
  return "invalid_output";
}
