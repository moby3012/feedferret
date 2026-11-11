// K3: deterministic, no-AI enrichment heuristics. Run once per NEW article at
// sync time (never on updates, never against existing rows), cost a few regexes
// on ≤ ~1.2k chars. They only ever say "true": a heuristic can mark an article
// sponsored/clickbait, never claim it is clean — "unknown" stays null so the AI
// pass (lib/article-enrichment.ts) can still decide.
//
// Precision over recall: German "Anzeige" also means "criminal complaint" and
// "Werbung" is an ordinary noun, so the ambiguous words only count in
// *label position* (start of the title/text, in brackets, or after a separator)
// — "[Anzeige] Neue Laptops" is sponsored, "Anzeige gegen Minister erstattet"
// is not. Unambiguous markers (advertorial, "sponsored post", …) match anywhere
// in the title or the first 300 characters of text.

import { iterOpenTags } from "@/lib/linear-text";
const MAX_TEXT_CHARS = 300;

// Words that only mean "this is an ad" when used as a label. Split by how
// ambiguous they are in news headlines:
//  - AMBIGUOUS: "Anzeige" (also: criminal complaint) / "Werbung" (ordinary noun) /
//    "in Kooperation mit …" (ordinary phrase). Only count as [bracketed], as a
//    trailing "– Anzeige" label, or as a leading label followed by a `|`
//    separator ("Anzeige | …") or standing alone. The leading `Anzeige: …` and
//    `Werbung – …` forms are deliberately NOT matched: "Anzeige: Polizei ermittelt"
//    and "Werbung – Neue Regeln für Influencer" are ordinary headlines.
//  - CLEAR: unambiguous ad words; may also lead with a colon ("Sponsored: …").
const AMBIGUOUS_LABELS = "anzeige|werbung|in kooperation mit|mit freundlicher unterst[üu]tzung";
const CLEAR_LABELS =
  "sponsored|gesponsert(?:er (?:beitrag|inhalt))?|promoted|bezahlte[rn]? (?:beitrag|inhalt|partnerschaft)";
const LABEL_WORDS = `${AMBIGUOUS_LABELS}|${CLEAR_LABELS}`;
const SEP_CHARS = "[|–—\\-/·•]";

// [Anzeige] / (Werbung) anywhere
const BRACKETED = new RegExp(`[\\[(]\\s*(?:${LABEL_WORDS})\\s*[\\])]`, "i");
// "Anzeige | …" / lone "Werbung" at the very start; "Sponsored: …" / "Sponsored | …" for clear words
const LEADING = new RegExp(
  `^\\W{0,3}(?:(?:${AMBIGUOUS_LABELS})(?:\\s+\\|(?:\\s|$)|\\s*$)|(?:${CLEAR_LABELS})(?::|\\s+${SEP_CHARS}|\\s*$))`,
  "i",
);
// "… | Anzeige", "… – Sponsored" at the very end
const TRAILING = new RegExp(`\\s${SEP_CHARS}\\s*(?:${LABEL_WORDS})\\W{0,3}$`, "i");

// Unambiguous anywhere (word boundaries keep "Anzeigenhauptmann"-style compounds out).
const STRONG_MARKERS = new RegExp(
  "(?<![\\p{L}\\p{N}])(?:" +
    [
      "advertorial",
      "affiliate[- ]links?",
      "sponsored (?:post|content|article)",
      "paid (?:post|content|partnership|promotion)",
      "partner(?:inhalt|[- ]?content|beitrag)",
      "(?:un)?bezahlte werbung",
      "werbung/anzeige",
      "anzeige/werbung",
      "enth[äa]lt werbung",
      "enth[äa]lt affiliate[- ]links?",
    ].join("|") +
    ")(?![\\p{L}\\p{N}])",
  "iu",
);

const SPONSORED_REL = /\brel\s*=\s*["'][^"']*\bsponsored\b[^"']*["']/i;
// Only mediums that actually say "paid". `native`/`partner`/`advertorial` are
// too common in organic campaign tagging to flag on.
const SPONSORED_UTM = /[?&]utm_medium=(?:sponsored|affiliate|paid)(?:[&#"'\s]|$)/i;
const MAX_HTML_SCAN_CHARS = 60_000;

/** A rel="sponsored" link within this many leading HTML chars counts on its own (an intro-level disclosure). */
const LEAD_HTML_CHARS = 600;
/** Beyond the lead, this many sponsored links are needed ("a link roundup of affiliate deals"). */
const MIN_SPONSORED_LINKS = 2;

/**
 * Body-link rule (documented so it can be tuned in one place): an article is NOT
 * flagged for a single affiliate link buried in a long text — that is normal for
 * ordinary journalism. It is flagged when a sponsored link (rel="sponsored" or
 * utm_medium=sponsored|affiliate|paid) sits in the first {@link LEAD_HTML_CHARS}
 * characters of the body, or when there are ≥ {@link MIN_SPONSORED_LINKS} of them.
 */
function hasSponsoredLinks(html: string): boolean {
  const scanned = html.slice(0, MAX_HTML_SCAN_CHARS);
  let count = 0;
  for (const tag of iterOpenTags(scanned, "a")) {
    const text = scanned.slice(tag.start, tag.end);
    if (!SPONSORED_REL.test(text) && !SPONSORED_UTM.test(text)) continue;
    if (tag.start < LEAD_HTML_CHARS) return true;
    count += 1;
    if (count >= MIN_SPONSORED_LINKS) return true;
  }
  return false;
}

function hasLabel(text: string): boolean {
  return LEADING.test(text) || BRACKETED.test(text) || TRAILING.test(text) || STRONG_MARKERS.test(text);
}

export interface HeuristicInput {
  title: string;
  /** Plain text of the body or excerpt; only the first 300 chars are inspected. */
  text?: string | null;
  /** Article link (checked for utm_medium=sponsored|affiliate|paid). */
  link?: string | null;
  /** Sanitized or raw HTML; sponsored links are checked per {@link hasSponsoredLinks}. */
  html?: string | null;
}

export function detectSponsored(input: HeuristicInput): boolean {
  const title = (input.title ?? "").trim();
  const text = (input.text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
  if (hasLabel(title) || (text && hasLabel(text))) return true;
  if (input.link && SPONSORED_UTM.test(input.link)) return true;
  if (input.html && hasSponsoredLinks(input.html)) return true;
  return false;
}

// de/en curiosity-gap and listicle-teaser phrases. Deliberately conservative:
// auto-read rules may act on `is:clickbait`, so a false positive costs more than a miss.
const CLICKBAIT_PHRASES = new RegExp(
  [
    "you won'?t believe",
    "here'?s why",
    "this one (?:trick|thing|simple)",
    "what happens next",
    "will (?:blow|shock|surprise) you",
    "doctors hate",
    "das passiert,? wenn",
    "dieser (?:einfache )?trick",
    "so einfach (?:geht|klappt|kannst|können)",
    "nummer \\d+ wird",
    "das steckt dahinter",
    "was dann passiert",
    "du wirst (?:es )?nicht glauben",
    "sie werden (?:es )?nicht glauben",
    "was (?:keiner|niemand) (?:weiß|wei(?:ss|ß))",
  ].join("|"),
  "iu",
);

// "?!" / "!!" / "?!?" endings and ≥2 shouted words (5+ letters, so "NASA"/"EZB"/"USA" never count).
const SHOUT_ENDING = /(?:\?!|!\?|!!)$/; // tested against trimmed text (a `\s*$` tail here was quadratic on whitespace runs)
const SHOUT_WORD = /(?<![\p{L}])\p{Lu}{5,}(?![\p{L}])/gu;

export function detectClickbait(title: string): boolean {
  const t = (title ?? "").trim();
  if (!t) return false;
  if (CLICKBAIT_PHRASES.test(t)) return true;
  if (SHOUT_ENDING.test(t.trimEnd())) return true;
  const shouted = t.match(SHOUT_WORD);
  return !!shouted && shouted.length >= 2;
}

export interface HeuristicEnrichment {
  isSponsored?: true;
  isClickbait?: true;
  enrichSource?: "heuristic";
}

/** Only ever returns `true` flags (or `{}`), ready to spread into a create payload. */
export function computeHeuristicEnrichment(input: HeuristicInput): HeuristicEnrichment {
  const out: HeuristicEnrichment = {};
  if (detectSponsored(input)) out.isSponsored = true;
  if (detectClickbait(input.title)) out.isClickbait = true;
  if (out.isSponsored || out.isClickbait) out.enrichSource = "heuristic";
  return out;
}
