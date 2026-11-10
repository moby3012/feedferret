import { WEAK_WORDS } from "./stopwords";
import { stem } from "./normalize";
import type { StorySig } from "./types";

// Pair scoring for story clustering. Pure; all tunables are constants here.

export const HOUR_MS = 3_600_000;
export const CONFIG = {
  /** Candidates and cluster joins only inside this window (|Δ publishedAt|). */
  windowMs: 48 * HOUR_MS,
  /** Extra penalty when the two articles are further apart than this. */
  lateMs: 36 * HOUR_MS,
  joinThreshold: 0.53,
  /** Drift guard: a joiner must still resemble the cluster's lead article. */
  driftThreshold: 0.35,
  maxClusterSize: 50,
  /** Candidate cap per pending article (by shared-term count). */
  maxCandidates: 200,
  /** Window smaller than this → flat prior idf (statistics too thin). */
  minIdfWindow: 30,
  /** Only terms with idf ≥ this are used for candidate blocking. */
  blockingIdf: 1.0,
  /** Tuned on tests/fixtures/story-headlines.json (see docs/story-clustering.md): max negative pair 0.50, min positive pair 0.56. */
  weights: { W: 0.3, A: 0.3, C: 0.4, E: 0.15, L: 0.25, conflict: 0.2, late: 0.1 },
  /** Σ idf of shared tokens that saturates the "absolute evidence" term. */
  evidenceMass: 8,
} as const;

/** Token weight function (idf, already scaled for weak tokens). */
export type IdfFn = (token: string) => number;

const WEAK_FACTOR = 0.35;
const WEAK_TOKENS: ReadonlySet<string> = new Set([...WEAK_WORDS].flatMap((w) => [w, stem(w, "de"), stem(w, "en")]));
const YEAR_TOKEN_RE = /^(?:19|20)\d\d$/;
/** Generic headline verbs and years: support a match, never carry it. */
export const isWeakToken = (t: string) => WEAK_TOKENS.has(t) || YEAR_TOKEN_RE.test(t);

/** idf of a typical content word in a mid-sized window; used while a window is too small for statistics. */
const IDF_PRIOR = 3.5;
export const flatIdf: IdfFn = (t) => IDF_PRIOR * (isWeakToken(t) ? WEAK_FACTOR : 1);

export function makeIdf(df: Map<string, number>, n: number): IdfFn {
  if (n < CONFIG.minIdfWindow) return flatIdf;
  return (t) => Math.min(6, Math.max(0.5, Math.log((n + 1) / ((df.get(t) ?? 0) + 0.5)))) * (isWeakToken(t) ? WEAK_FACTOR : 1);
}

/** Prepared (set-based) view of a signature; cached per sig object. */
export interface PreparedSig {
  sig: StorySig;
  t: Set<string>;
  e: Set<string>;
  l: Set<string>;
  tri?: Set<string>;
}

const cache = new WeakMap<StorySig, PreparedSig>();
export function prepare(sig: StorySig): PreparedSig {
  let p = cache.get(sig);
  if (!p) {
    p = { sig, t: new Set(sig.t), e: new Set(sig.e), l: new Set(sig.l) };
    cache.set(sig, p);
  }
  return p;
}

function trigrams(p: PreparedSig): Set<string> {
  if (!p.tri) {
    const s = ` ${[...p.sig.t].sort().join(" ")} `;
    const set = new Set<string>();
    for (let i = 0; i + 3 <= s.length; i++) set.add(s.slice(i, i + 3));
    p.tri = set;
  }
  return p.tri;
}

// ---- contradictions: opposite moves and recurring series
// Headlines of one format with a flipped direction ("DAX steigt" / "DAX fällt",
// "Zinssenkung" / "Zinserhöhung", "im Plus" / "im Minus") share nearly all
// tokens but report opposite news; the overlap terms cannot see that. Token
// forms are the folded + stemmed ones the signature holds.
const UP_EXACT = new Set("raise steigt steig stieg stiegen anstieg plus rise rises rose climb climbs surge surges jump jumps rally rallies gain gains higher hoeher hoch".split(" "));
const DOWN_EXACT = new Set("cut faellt faell fiel fielen sinkt sink sank minus fall falls fell drop drops dropped slump plunge plunges tumble tumbles decline declines lower niedriger rueckgang".split(" "));
const UP_PREFIX = ["zinserhoeh", "erhoeh", "anheb", "preiserhoeh"];
const DOWN_PREFIX = ["zinssenk", "senkung", "absenk", "preissenk", "zinsenk"];
const WEEKDAYS = new Set("montag dienstag mittwoch donnerstag freitag samstag sonntag monday tuesday wednesday thursday friday saturday sunday".split(" "));

interface Polarity {
  up: boolean;
  down: boolean;
  days: string[];
}
const polarityCache = new WeakMap<StorySig, Polarity>();
function polarity(sig: StorySig): Polarity {
  let p = polarityCache.get(sig);
  if (!p) {
    p = { up: false, down: false, days: [] };
    for (const t of sig.t) {
      if (UP_EXACT.has(t) || UP_PREFIX.some((x) => t.startsWith(x))) p.up = true;
      if (DOWN_EXACT.has(t) || DOWN_PREFIX.some((x) => t.startsWith(x))) p.down = true;
      if (WEEKDAYS.has(t)) p.days.push(t);
    }
    polarityCache.set(sig, p);
  }
  return p;
}
/** One side only goes up, the other only down. Mixed headlines ("Dax steigt nach Zinssenkung") never conflict. */
function opposite(a: Polarity, b: Polarity): boolean {
  return (a.up && !a.down && b.down && !b.up) || (a.down && !a.up && b.up && !b.down);
}
/** Both name weekdays and none in common: same series format on different days. */
function otherDay(a: Polarity, b: Polarity): boolean {
  return a.days.length > 0 && b.days.length > 0 && !a.days.some((d) => b.days.includes(d));
}

/** Entities that carry identity (acronyms, codes, numbers, brands) — mismatches count as conflict. Weak "~name" entities (capitalized English words) do not. */
const isIdentityEntity = (e: string) => !e.startsWith("~");

export interface PairScore {
  score: number;
  W: number;
  A: number;
  late: 0 | 1;
  C: number;
  E: number;
  L: 0 | 1;
  conflict: 0 | 1;
  shared: number;
  sharedEntities: number;
  /** Opposite directions ("steigt" vs "fällt"): the score is capped below the join threshold. */
  opposite?: 0 | 1;
  /** Different weekdays named on both sides (recurring series): same veto. */
  otherDay?: 0 | 1;
  /** Passes the minimum-evidence gate (≥2 shared tokens, or link / entity paths). */
  gate: boolean;
  join: boolean;
}

/**
 * Score of two articles from different feeds (caller guarantees that).
 * `dtMs` = |publishedAt(a) − publishedAt(b)|.
 *
 *   W = ½·weighted-Jaccard + ½·weighted-overlap over content tokens (idf)
 *   A = saturating "absolute evidence" of the shared idf mass
 *   C = char-trigram Jaccard of the sorted token strings (inflection)
 *   E = shared entities / min(|Ea|,|Eb|)    L = shared outbound link
 *   conflict: both sides name entities, none shared, at least one identity entity (acronym, code, number, brand)
 */
export function scorePair(a: PreparedSig, b: PreparedSig, idf: IdfFn, dtMs: number): PairScore | null {
  if (dtMs > CONFIG.windowMs) return null;

  let shared = 0;
  let strongShared = 0;
  let interMass = 0;
  let massA = 0;
  let massB = 0;
  const [small, big] = a.t.size <= b.t.size ? [a.t, b.t] : [b.t, a.t];
  for (const t of small) {
    if (big.has(t)) {
      shared++;
      if (!isWeakToken(t)) strongShared++;
      interMass += idf(t);
    }
  }
  let sharedEntities = 0;
  const [es, eb] = a.e.size <= b.e.size ? [a.e, b.e] : [b.e, a.e];
  for (const e of es) if (eb.has(e)) sharedEntities++;
  let L: 0 | 1 = 0;
  for (const l of a.l.size <= b.l.size ? a.l : b.l) {
    if ((a.l.size <= b.l.size ? b.l : a.l).has(l)) {
      L = 1;
      break;
    }
  }

  // One shared entity is weak evidence ("iPhone" in two unrelated Apple stories): half credit.
  const E =
    a.e.size && b.e.size ? (sharedEntities / Math.min(a.e.size, b.e.size)) * (sharedEntities >= 2 ? 1 : 0.5) : 0;
  const gate = strongShared >= 2 || (L === 1 && shared >= 1) || (sharedEntities >= 2 && E >= 0.67);
  if (!gate) return { score: 0, W: 0, A: 0, late: 0, C: 0, E, L, conflict: 0, shared, sharedEntities, gate: false, join: false };

  for (const t of a.t) massA += idf(t);
  for (const t of b.t) massB += idf(t);
  const union = massA + massB - interMass;
  const jaccard = union > 0 ? interMass / union : 0;
  const overlap = Math.min(massA, massB) > 0 ? interMass / Math.min(massA, massB) : 0;
  const W = 0.5 * jaccard + 0.5 * overlap;
  const A = Math.min(1, interMass / CONFIG.evidenceMass);

  const ta = trigrams(a);
  const tb = trigrams(b);
  let triInter = 0;
  for (const g of ta.size <= tb.size ? ta : tb) if ((ta.size <= tb.size ? tb : ta).has(g)) triInter++;
  const triUnion = ta.size + tb.size - triInter;
  const C = triUnion > 0 ? triInter / triUnion : 0;

  const idA = [...a.e].filter((e) => isIdentityEntity(e));
  const idB = [...b.e].filter((e) => isIdentityEntity(e));
  const conflict: 0 | 1 = ((idA.length > 0 && b.e.size > 0) || (idB.length > 0 && a.e.size > 0)) && sharedEntities === 0 ? 1 : 0;

  const pa = polarity(a.sig);
  const pb = polarity(b.sig);
  const opp: 0 | 1 = opposite(pa, pb) ? 1 : 0;
  const day: 0 | 1 = otherDay(pa, pb) ? 1 : 0;

  const w = CONFIG.weights;
  let score =
    w.W * W + w.A * A + w.C * C + w.E * E + w.L * L - w.conflict * conflict - (dtMs > CONFIG.lateMs ? w.late : 0);
  // Contradictions veto the join: the rest of such a pair is near-identical by construction.
  if (opp || day) score = Math.min(score, CONFIG.joinThreshold - 0.05);
  return {
    score,
    W,
    A,
    late: dtMs > CONFIG.lateMs ? 1 : 0,
    C,
    E,
    L,
    conflict,
    opposite: opp,
    otherDay: day,
    shared,
    sharedEntities,
    gate: true,
    join: score >= CONFIG.joinThreshold,
  };
}
