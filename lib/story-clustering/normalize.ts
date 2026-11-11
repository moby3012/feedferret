import { createHash } from "node:crypto";
import { normalizeArticleUrl } from "../content-hash";
import { ENTITY_ALIASES, EXCLUDE_TITLE_RE, PREFIX_RE, STOPWORDS, STOPWORDS_DE, STOPWORDS_EN, SYNONYMS } from "./stopwords";
import type { StorySig } from "./types";
import { findLastPaddedSeparator } from "@/lib/linear-text";

// Pure text normalization for story clustering: title → tokens / entities /
// outbound-link hashes. No I/O, no clock, deterministic.

export const MAX_TOKENS = 16;
export const MAX_ENTITIES = 8;
export const MAX_LINKS = 8;
const CONTENT_SCAN_BYTES = 20_000;
const SIG_VERSION = 1 as const;

// ------------------------------------------------------------------ folding
const DIACRITIC_RE = /[̀-ͯ]/g;

/** NFKC, lowercase, German transliteration (ä→ae, ß→ss…), other diacritics dropped. */
export function foldText(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .normalize("NFD")
    .replace(DIACRITIC_RE, "")
    .replace(/[’‘`´]/g, "'");
}

// ------------------------------------------------------------- site suffix
function hostLabel(host: string | null | undefined): string {
  if (!host) return "";
  const parts = host.toLowerCase().replace(/^www\./, "").split(".");
  if (parts.length <= 1) return parts[0] ?? "";
  // "bbc.co.uk" → bbc, "spiegel.de" → spiegel
  const sld = parts[parts.length - 2];
  return ["co", "com", "org", "net", "ac", "gov"].includes(sld) && parts.length >= 3 ? parts[parts.length - 3] : sld;
}

function squash(s: string): string {
  return foldText(s).replace(/[^a-z0-9]+/g, "");
}

export interface TitleContext {
  feedName?: string | null;
  /** Article link host (e.g. "www.spiegel.de"). */
  host?: string | null;
}

/**
 * Drops a trailing " - SPIEGEL" / " | tagesschau.de" site suffix when the tail
 * is the feed name or host label (or ≤3 words containing the host label).
 * Operates on the original-case title so entity extraction still sees case.
 */
export function stripSiteSuffix(title: string, ctx: TitleContext = {}): string {
  // The whitespace-padded separator that is the LAST separator char (linear form of /\s+[-|–—·:]\s+(?=[^-|–—·:]*$)/).
  const m = findLastPaddedSeparator(title);
  if (!m) return title.trim();
  const head = title.slice(0, m.index).trim();
  const tail = title.slice(m.index + m.length).trim();
  if (!head || !tail) return title.trim();
  const tailKey = squash(tail);
  if (!tailKey) return title.trim();
  const feedKey = ctx.feedName ? squash(ctx.feedName) : "";
  const label = squash(hostLabel(ctx.host));
  const matchesFeed = feedKey.length > 0 && (tailKey === feedKey || feedKey.includes(tailKey) || tailKey.includes(feedKey));
  const matchesHost = label.length > 0 && (tailKey === label || tailKey.includes(label) || label.includes(tailKey));
  const shortTail = tail.split(/\s+/).length <= 3;
  if (matchesFeed || (shortTail && matchesHost)) return head;
  return title.trim();
}

/** "Eilmeldung: …", "Breaking – …" → "…". */
export function stripPrefix(title: string): string {
  return title.replace(PREFIX_RE, "").trim();
}

/** Site-suffix + format-prefix stripped title (original case). */
export function cleanTitle(title: string, ctx: TitleContext = {}): string {
  return stripPrefix(stripSiteSuffix(title.replace(/\s+/g, " "), ctx));
}

/** Folded, punctuation-light variant used for display-independent comparisons. */
export function normalizeTitle(title: string, ctx: TitleContext = {}): string {
  return foldText(cleanTitle(title, ctx))
    .replace(/(\d)[,](\d)/g, "$1.$2")
    .replace(/[^\p{L}\p{N}.\- ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------- language
export function detectLang(text: string): "de" | "en" {
  const folded = foldText(text);
  let de = 0;
  let en = 0;
  for (const w of folded.split(/[^a-z0-9']+/)) {
    if (!w) continue;
    const inDe = STOPWORDS_DE.has(w);
    const inEn = STOPWORDS_EN.has(w);
    if (inDe && !inEn) de++;
    else if (inEn && !inDe) en++;
  }
  if (de !== en) return de > en ? "de" : "en";
  // No stopword signal (short titles): German morphology as tie-break — umlauts / ß,
  // typical suffixes, long compounds ("Friedensnobelpreis"), gendered "-in/-innen" nouns.
  let hints = /[äöüß]/i.test(text) ? 1 : 0;
  for (const w of folded.split(/[^a-z]+/)) {
    if (/(ung|ungen|keit|heit|schaft|lich|isch|ierung|schen|nis)$/.test(w) && w.length > 6) hints++;
    if (w.length >= 13) hints++;
  }
  return hints > 0 ? "de" : "en";
}

// -------------------------------------------------------------- tokenizing
const YEAR_RE = /^(?:19|20)\d\d$/;
const CVE_RE = /cve-\d{4}-\d{3,7}/g;
const NUM_SEP = "\u0001";

function protectNumbers(folded: string): { text: string; special: string[] } {
  const special: string[] = [];
  let text = folded.replace(CVE_RE, (m) => {
    special.push(m);
    return " ";
  });
  // 0,25 / 2.0 / 26.1 → one token (comma folded to dot); thousands "1.000" stay one token.
  text = text.replace(/(\d)[.,](?=\d)/g, `$1${NUM_SEP}`);
  return { text, special };
}

function rawWords(text: string): string[] {
  return text
    .split(/[^\p{L}\p{N}\u0001]+/u)
    .filter(Boolean)
    .map((w) => w.replace(/\u0001/g, "."));
}

const isNumeric = (w: string) => /^\d+(?:\.\d+)?$/.test(w);

const DE_SUFFIXES = ["ungen", "ung", "en", "er", "es", "e", "n"];
const EN_SUFFIXES = ["ing", "ed", "es", "s"];

/** Light, deterministic suffix stemmer. Keeps stems ≥ 4 chars; leaves numbers / mixed tokens alone. */
export function stem(word: string, lang: "de" | "en"): string {
  if (word.length < 5 || /\d/.test(word)) return word;
  const suffixes = lang === "de" ? DE_SUFFIXES : EN_SUFFIXES;
  for (const suf of suffixes) {
    if (word.endsWith(suf) && word.length - suf.length >= 4) {
      const base = word.slice(0, -suf.length);
      return lang === "en" && base.length >= 5 && base.endsWith("e") ? base.slice(0, -1) : base;
    }
  }
  return lang === "en" && word.length >= 6 && word.endsWith("e") ? word.slice(0, -1) : word;
}

// ----------------------------------------------------------------- aliases
const ALIAS_PATTERNS: Array<{ canonical: string; re: RegExp }> = ENTITY_ALIASES.map(([canonical, forms]) => ({
  canonical,
  re: new RegExp(
    `(?<![a-z0-9])(?:${forms
      .map((f) => foldText(f).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"))
      .join("|")})(?![a-z0-9])`,
    "g",
  ),
}));

/** Replaces known long/short forms with one canonical id (`ezb`, `europäische zentralbank` → `ecb`). */
export function applyAliases(folded: string): { text: string; canonical: string[] } {
  let text = folded;
  const canonical: string[] = [];
  for (const { canonical: id, re } of ALIAS_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) {
      re.lastIndex = 0;
      text = text.replace(re, ` ${id} `);
      canonical.push(id);
    }
  }
  return { text, canonical };
}

/** Content tokens of a title (stopwords out, stemmed, deduped, ≤ 16). */
export function tokenize(title: string, lang: "de" | "en" = detectLang(title)): string[] {
  const aliased = applyAliases(foldText(title)).text;
  const { text, special } = protectNumbers(aliased);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  for (const w of rawWords(text)) {
    if (STOPWORDS.has(w)) continue;
    const numeric = isNumeric(w);
    if (!numeric && w.length < 2) continue;
    push(numeric ? w : (SYNONYMS[w] ?? stem(w, lang)));
  }
  for (const s of special) push(s);
  return out.slice(0, MAX_TOKENS);
}

// ---------------------------------------------------------------- entities
const ALL_CAPS_RE = /^\p{Lu}{2,6}$/u;
const MIXED_CASE_RE = /^(?:\p{Ll}+\p{Lu}|\p{Lu}\p{Ll}+\p{Lu})/u;
const CAPITALIZED_RE = /^\p{Lu}\p{Ll}+$/u;

/**
 * Entity heuristics (no NER) on the original-case title (+ optional excerpt):
 * (a) ALL-CAPS 2–6 letters, (b) letter+digit tokens, decimals and ≥3-digit
 * non-year numbers, brand+number bigrams ("iPhone 17" → iphone17), (c) mixed
 * case (OpenAI, iOS), (d) English only: capitalized non-initial words.
 * Known aliases are mapped to a canonical id. Lowercased, ≤ 8.
 */
export function extractEntities(title: string, excerpt: string | null | undefined, lang: "de" | "en"): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (e: string) => {
    const k = foldText(e);
    if (k.replace(/^~/, "").length >= 2 && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  };

  for (const src of [title, excerpt ? excerpt.slice(0, 300) : ""]) {
    if (!src) continue;
    const text = src
      .replace(CVE_RE_ORIG, (m) => {
        add(m);
        return " ";
      })
      .replace(/(\d)[.,](?=\d)/g, `$1${NUM_SEP}`); // 0,25 → one token
    const words = text.split(/[^\p{L}\p{N}\u0001]+/u).filter(Boolean);
    const letterWords = words.filter((w) => /\p{L}/u.test(w));
    const capsRatio = letterWords.length ? letterWords.filter((w) => ALL_CAPS_RE.test(w)).length / letterWords.length : 0;
    const content = letterWords.filter((w) => !STOPWORDS.has(foldText(w)));
    // "Apple Unveils New Phone": Title Case carries no signal for rule (d).
    const titleCase = content.length >= 4 && content.filter((w) => /^\p{Lu}/u.test(w)).length / content.length >= 0.8;
    // A word right after the text start or a clause separator is "initial".
    const initialAt = new Set<number>();
    {
      let prevEnd = -1;
      let wi = 0;
      for (const m of text.matchAll(/[\p{L}\p{N}\u0001]+/gu)) {
        const gap = prevEnd < 0 ? "" : text.slice(prevEnd, m.index);
        if (prevEnd < 0 || /[:|–—!?]|\s[-.]\s|\.\s/.test(gap)) initialAt.add(wi);
        prevEnd = (m.index ?? 0) + m[0].length;
        wi++;
      }
    }
    for (let i = 0; i < words.length; i++) {
      const clean = words[i].replace(/\u0001/g, ".");
      const next = words[i + 1]?.replace(/\u0001/g, ".");
      const initial = initialAt.has(i);
      if (/^\d+\.\d+(?:\.\d+)*$/.test(clean)) {
        add(clean); // decimals: 0.25, 2.0, 26.1
        continue;
      }
      if (/^\d+$/.test(clean)) {
        if (clean.length >= 3 && !YEAR_RE.test(clean)) add(clean);
        continue;
      }
      if (/\d/.test(clean) && /\p{L}/u.test(clean)) {
        add(clean); // A19, GPT5, 5G
        continue;
      }
      if (STOPWORDS.has(foldText(clean))) continue;
      const mixed = MIXED_CASE_RE.test(clean);
      if (ALL_CAPS_RE.test(clean)) {
        if (capsRatio < 0.6) add(clean);
        continue;
      }
      if (mixed) add(clean);
      else if (lang === "en" && !titleCase && !initial && CAPITALIZED_RE.test(clean)) add(`~${clean}`);
      // brand + number bigram: "iPhone 17", "iOS 26.1", "Gemini 3" — not "in 2026"
      if (next && /^\d+(?:\.\d+)?$/.test(next) && !YEAR_RE.test(next) && (lang === "en" ? /^\p{Lu}|^\p{Ll}+\p{Lu}/u.test(clean) : mixed) && (next.length <= 3 || next.includes("."))) {
        add(`${clean}${next}`);
      }
    }
  }

  // Alias canonicalization on the whole title: "EZB", "Europäische Zentralbank" → ecb.
  const mapped: string[] = [];
  const mappedSeen = new Set<string>();
  const put = (v: string) => {
    if (!mappedSeen.has(v)) {
      mappedSeen.add(v);
      mapped.push(v);
    }
  };
  for (const c of applyAliases(foldText(title)).canonical) put(c);
  for (const e of out) {
    const hit = ENTITY_ALIASES.find(([, forms]) => forms.some((f) => foldText(f) === e.replace(/^~/, "")));
    put(hit ? hit[0] : e);
  }
  return mapped.slice(0, MAX_ENTITIES);
}

const CVE_RE_ORIG = /CVE-\d{4}-\d{3,7}/gi;

// -------------------------------------------------------------------- links
const LINK_HOST_BLOCKLIST = new Set(
  (
    "twitter.com x.com t.co facebook.com fb.com fb.me linkedin.com lnkd.in bit.ly ow.ly buff.ly tinyurl.com goo.gl instagram.com youtube.com youtu.be " +
    "whatsapp.com wa.me telegram.me t.me reddit.com redd.it pinterest.com tiktok.com flipboard.com getpocket.com play.google.com apps.apple.com " +
    "google.com bing.com amazon.com amzn.to mastodon.social bsky.app threads.net feedburner.com feeds.feedburner.com doubleclick.net"
  ).split(" "),
);

function registrableHost(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  const sld = parts[parts.length - 2];
  return ["co", "com", "org", "net", "ac", "gov"].includes(sld) ? parts.slice(-3).join(".") : parts.slice(-2).join(".");
}

const HREF_RE = /href\s*=\s*["']([^"'#][^"']*)["']/gi;

/**
 * Outbound link hashes of a body (first 20 KB): external hosts only, no social
 * / shortener hosts, no homepages. sha1-12 of the normalized URL, deduped, ≤ 8.
 */
export function extractOutboundLinks(content: string | null | undefined, articleLink: string | null | undefined): string[] {
  if (!content) return [];
  let ownHost = "";
  try {
    ownHost = articleLink ? registrableHost(new URL(articleLink).hostname) : "";
  } catch {
    /* no own host */
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const body = content.length > CONTENT_SCAN_BYTES ? content.slice(0, CONTENT_SCAN_BYTES) : content;
  HREF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HREF_RE.exec(body)) && out.length < MAX_LINKS) {
    let url: URL;
    try {
      url = new URL(m[1].replace(/&amp;/g, "&"));
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const reg = registrableHost(host);
    if (reg === ownHost || LINK_HOST_BLOCKLIST.has(host) || LINK_HOST_BLOCKLIST.has(reg)) continue;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length === 0 || (segments.length === 1 && segments[0].length < 20)) continue;
    const hash = createHash("sha1").update(normalizeArticleUrl(url.toString())).digest("hex").slice(0, 12);
    if (!seen.has(hash)) {
      seen.add(hash);
      out.push(hash);
    }
  }
  return out;
}

// ---------------------------------------------------------------- signature
export interface SigInput {
  title: string;
  excerpt?: string | null;
  /** Body (HTML or Markdown) — only scanned for outbound links. */
  content?: string | null;
  link?: string | null;
  feedName?: string | null;
  feedPriority?: string | null;
  imageUrl?: string | null;
  readMinutes?: number | null;
  isDuplicate?: boolean;
}

const PRIORITY_W: Record<string, number> = { important: 3, main: 2, category: 1, feed: 1 };

function safeHost(link: string | null | undefined): string | null {
  if (!link) return null;
  try {
    return new URL(link).hostname;
  } catch {
    return null;
  }
}

export function computeStorySig(input: SigInput): StorySig {
  const host = safeHost(input.link);
  const cleaned = cleanTitle(input.title ?? "", { feedName: input.feedName, host });
  const lang = detectLang(`${cleaned} ${input.excerpt ? input.excerpt.slice(0, 120) : ""}`.trim() || cleaned);
  const t = tokenize(cleaned, lang);
  const e = extractEntities(cleaned, input.excerpt, lang);
  const l = extractOutboundLinks(input.content, input.link);
  const q =
    (PRIORITY_W[input.feedPriority ?? "main"] ?? 0) +
    (input.imageUrl ? 0.5 : 0) +
    ((input.readMinutes ?? 0) >= 2 ? 0.5 : 0) +
    0.3;
  const sig: StorySig = { v: SIG_VERSION, t, e, l, g: lang, q };
  if (
    t.length < 3 ||
    EXCLUDE_TITLE_RE.test(input.title ?? "") ||
    input.feedPriority === "hidden" ||
    input.isDuplicate
  ) {
    sig.x = 1;
  }
  return sig;
}

export function serializeSig(sig: StorySig): string {
  return JSON.stringify(sig);
}

export function parseSig(raw: string | null | undefined): StorySig | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as StorySig;
    return v && v.v === SIG_VERSION && Array.isArray(v.t) && Array.isArray(v.e) && Array.isArray(v.l) ? v : null;
  } catch {
    return null;
  }
}
