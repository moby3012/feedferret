// Generic quality gate for extracted article content.
//
// Every extraction candidate (FTR rule, Defuddle, Readability, extractus,
// JSON-LD, render sidecar, hosted API, AI) is scored the same way, and the
// full-text pipeline only stores a result that is (a) a real article, not a
// consent/paywall/bot wall or a link list, and (b) clearly better than what the
// feed already provides. No host lists: only text structure (length, link
// density, paragraphs) and a small multilingual lexicon of wall phrases whose
// weight only matters when the text around them is short.
//
// Parse-free (no DOM): safe on the main thread. The DOM-based edge trim lives in
// lib/extraction-trim-core.ts (HTML worker only).

import { htmlToPlainText } from "@/lib/article-kind";
import { iterElementInners } from "@/lib/linear-text";

export type QualityVerdict = "good" | "thin" | "wall" | "boilerplate" | "empty";

export type ExtractionQuality = {
    verdict: QualityVerdict;
    /** Comparable score: higher is better. Only meaningful across candidates for the same page. */
    score: number;
    textLength: number;
    words: number;
    linkDensity: number;
    paragraphs: number;
    wallSignals: number;
    leakSignals: number;
    reason: string;
};

/** Below this many characters of plain text an extraction is not worth storing as "full text". */
export const MIN_FULL_TEXT_LENGTH = 400;

// Wall lexicon. Each pattern counts at most once (distinct signals), so a long
// article that merely mentions "cookies" a lot is not a wall; the verdict also
// requires the surrounding text to be short.
const CONSENT_PATTERNS: RegExp[] = [
    /\bcookies?\b/,
    /\bconsent\b|einwillig|zustimm|toestemming|consentement|consentimiento|consenso/,
    /datenschutz(?:einstellungen|erklärung|hinweis|-einstellungen)|privacy (?:settings|policy|center|preferences)/,
    /drittanbieter|third[- ]part(?:y|ies)|\bvendors?\b|\bpartners? \(/,
    /personali[sz]ed (?:ads|advertising|content)|personalisierte (?:anzeigen|werbung|inhalte)/,
    /\baccept all\b|alle akzeptieren|\bakzeptieren\b|tout accepter|aceptar todo|accetta tutto|alles accepteren/,
    /geräte-?kennung|device identifiers?|ip-adressen?|ip address(?:es)?|precise geolocation|genaue standortdaten/,
    /\bgdpr\b|\bdsgvo\b|\btcf\b/,
    /werbe-?cookies|tracking-?cookies|\btracking\b/,
];
const PAYWALL_PATTERNS: RegExp[] = [
    /\bsubscribe\b|\bsubscription\b|\bsubscribers?\b|s'abonner|abonnez|suscr[ií]b|abbonati|abbonamento/,
    /\babonn|\babos?\b|\babo-/,
    /\bpaywall\b|\bpremium\b|\bplus-?artikel\b/,
    /members? only|member-only|for members|nur für (?:abonnenten|mitglieder)/,
    /(?:sign|log) ?in to (?:continue|read)|create (?:a )?(?:free )?account to|kostenlos registrieren|jetzt registrieren/,
    /jetzt (?:abonnieren|testen|weiterlesen|freischalten)|weiterlesen mit|zugang (?:sichern|freischalten)|unlock (?:this|the) (?:article|story)/,
    /continue reading|keep reading|read the full (?:story|article)|to read (?:the|this) (?:full|rest)/,
    /already (?:a )?(?:subscriber|member)|bereits (?:abonnent|\S+-?leser)|hier anmelden/,
];
const BOT_PATTERNS: RegExp[] = [
    /enable javascript|javascript (?:is )?(?:disabled|required)|aktivieren sie javascript|activez javascript/,
    /captcha/,
    /are you a (?:human|robot)|not a robot|verify (?:you are|that you(?:'|’)re) (?:a )?human|checking your browser|unusual traffic|access denied|zugriff verweigert/,
];

// Script/state leaking into extracted text, e.g. "showPaywall: false isSubscriber: false".
const LEAK_PATTERN = /\b[a-z][a-zA-Z0-9_]{2,}\s*[:=]\s*(?:true|false|null|undefined)\b/g;
export const LEAK_TEST = new RegExp(LEAK_PATTERN.source);

function countDistinct(text: string, patterns: RegExp[]): number {
    let hits = 0;
    for (const pattern of patterns) if (pattern.test(text)) hits++;
    return hits;
}

/** Plain text of the link bodies in an HTML fragment (cheap regex, no DOM). */
function linkTextLength(html: string): number {
    let total = 0;
    for (const inner of iterElementInners(html, "a")) {
        total += htmlToPlainText(inner).length;
    }
    return total;
}

function substantialParagraphs(html: string): number {
    let count = 0;
    for (const inner of iterElementInners(html, "p")) {
        if (htmlToPlainText(inner).length >= 80) count++;
    }
    return count;
}

function countWords(text: string): number {
    if (!text) return 0;
    // CJK and similar scripts have no spaces: approximate a "word" per 2 chars.
    const cjk = (text.match(/[぀-ヿ㐀-鿿가-힯]/g) ?? []).length;
    const spaced = text.split(/\s+/).filter(Boolean).length;
    return Math.max(spaced, Math.round(cjk / 2));
}

/**
 * Scores one extraction candidate (sanitized HTML). Pure, deterministic and
 * cheap (regex only), so it can run for every candidate of every page.
 */
export function assessExtraction(html: string | null | undefined): ExtractionQuality {
    const text = htmlToPlainText(html ?? "");
    const textLength = text.length;
    if (!html || textLength === 0) {
        return { verdict: "empty", score: 0, textLength: 0, words: 0, linkDensity: 0, paragraphs: 0, wallSignals: 0, leakSignals: 0, reason: "empty" };
    }
    const lower = text.toLowerCase();
    const words = countWords(text);
    const linkDensity = Math.min(1, linkTextLength(html) / textLength);
    const paragraphs = substantialParagraphs(html);
    const consent = countDistinct(lower, CONSENT_PATTERNS);
    const paywall = countDistinct(lower, PAYWALL_PATTERNS);
    const bot = countDistinct(lower, BOT_PATTERNS);
    const wallSignals = consent + paywall + bot;
    const leakSignals = (text.match(LEAK_PATTERN) ?? []).length;

    // Signals per 1000 characters: a wall is mostly wall vocabulary.
    const density = (wallSignals * 1000) / Math.max(textLength, 1);

    let verdict: QualityVerdict = "good";
    let reason = "ok";
    if (bot > 0 && textLength < 1500) {
        verdict = "wall";
        reason = "bot_wall";
    } else if (consent >= 3 && consent >= paywall && (textLength < 1500 || density >= 1.5)) {
        verdict = "wall";
        reason = "consent_wall";
    } else if (paywall >= 2 && textLength < 1500) {
        verdict = "wall";
        reason = "paywall";
    } else if (wallSignals >= 3 && density >= 2.5) {
        verdict = "wall";
        reason = consent >= paywall ? "consent_wall" : "paywall";
    } else if (linkDensity > 0.5) {
        verdict = "boilerplate";
        reason = "link_list";
    } else if (textLength < MIN_FULL_TEXT_LENGTH) {
        verdict = "thin";
        reason = "thin";
    }

    // Effective text: non-link prose, penalised for wall vocabulary and leaks,
    // with a small bonus for real paragraph structure.
    const prose = textLength * (1 - linkDensity);
    const score = Math.max(
        0,
        prose * (1 - Math.min(0.9, density / 5)) - leakSignals * 150 + Math.min(paragraphs, 30) * 40,
    );

    return { verdict, score, textLength, words, linkDensity, paragraphs, wallSignals, leakSignals, reason };
}

const VERDICT_RANK: Record<QualityVerdict, number> = { good: 4, thin: 2, boilerplate: 1, wall: 0, empty: -1 };

/** True when candidate `a` should be preferred over `b`. */
export function isBetterCandidate(a: ExtractionQuality, b: ExtractionQuality | null | undefined): boolean {
    if (!b) return true;
    const rankA = VERDICT_RANK[a.verdict];
    const rankB = VERDICT_RANK[b.verdict];
    if (rankA !== rankB) return rankA > rankB;
    return a.score > b.score;
}

export type FullTextDecision =
    | { accept: true; reason: "ok" }
    | { accept: false; reason: string };

/**
 * Gate for storing extracted full text in place of the feed-provided content.
 *
 * - `mode: "auto"` (background sync): the extraction must be a good article AND
 *   clearly longer than the feed content (a teaser re-extracted, a members-only
 *   stub or a page that only repeats the feed is no gain, and a rich feed item
 *   must never be replaced by a thinner page).
 * - `mode: "manual"` (the user pressed "Fetch full text"): a good article that
 *   is longer than what is shown now is enough.
 */
export function decideFullText(
    candidate: ExtractionQuality | null | undefined,
    baselineHtml: string | null | undefined,
    mode: "auto" | "manual" = "auto",
): FullTextDecision {
    if (!candidate || candidate.verdict === "empty") return { accept: false, reason: "empty" };
    if (candidate.verdict !== "good") return { accept: false, reason: candidate.reason };
    const baseline = htmlToPlainText(baselineHtml ?? "").length;
    if (mode === "manual") {
        return candidate.textLength > baseline ? { accept: true, reason: "ok" } : { accept: false, reason: "not_longer" };
    }
    // Clearly better: ≥ 20 % longer plus a fixed margin, so a page that merely
    // re-renders the feed item (plus a byline and a share bar) is not "full text".
    if (candidate.textLength < baseline * 1.2 + 100) return { accept: false, reason: "teaser" };
    return { accept: true, reason: "ok" };
}
