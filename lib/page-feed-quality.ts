// Preview quality gate for "Von Webseite" (page → feed) selector candidates.
//
// A selector that parses into ≥3 linked items is not yet a feed: the T1
// live benchmark (.pm/T1-feed-everything-report.md) found nonempty selectors
// that picked menus, footer social links, login links, Bing Maps office
// locations, forum categories, "Apply" buttons, duplicate cards and ad
// redirects. This module classifies every previewed item and decides whether
// a candidate may be offered at all ("reject"), only with a visible
// "please review" label ("review"), or plainly ("ok").
//
// Pure and synchronous: it inspects already-extracted items (titles, links,
// dates, images) plus the page URL — no DOM, no network.

import type { FetchedFeedArticle } from "./feed-fetcher";
import { stripTags, trimEndWhile, trimTrailingSlashes } from "@/lib/linear-text";

/** Why a candidate that is still offered needs a human look (UI-translated). */
export type PreviewReviewReason =
  | "duplicates" // the same link/title repeats across items
  | "mixedItems" // some items look like navigation, ads, login or placeholders
  | "fewItems" // only 3–4 distinct plausible items
  | "outsideSection" // the URL names a section (/news, /blog…) but items link elsewhere
  | "otherSites"; // most items leave the site

/** Informational, not a review reason: shown in the preview, not as "please review". */
export type PreviewNote = "missingDates"; // fewer than half of the items carry a date

/** Why a candidate is not offered at all (logs/bench/tests; never shown raw). */
export type PreviewRejectReason =
  | "tooFewPlausibleItems"
  | "mostlyJunk"
  | "navigationChrome"
  | "navigationList";

/** Per-item problem; `null` = a plausible feed item. */
export type ItemIssue =
  | "noLink"
  | "placeholderTitle"
  | "ad"
  | "login"
  | "map"
  | "social"
  | "navigation"
  | "brandNavigation"
  | "offScope";

export type PreviewQuality = {
  verdict: "ok" | "review" | "reject";
  reasons: PreviewReviewReason[];
  notes: PreviewNote[];
  rejectReason?: PreviewRejectReason;
  /** Distinct (by link and title) items that look like real entries. */
  plausibleItems: number;
  /** Ranking adjustment added to the structural score. */
  scoreAdjustment: number;
  issues: Partial<Record<ItemIssue, number>>;
  /** Per input item, aligned with `articles`: why it is not an entry (null = plausible). */
  itemIssues: Array<ItemIssue | null>;
};

export type QualityContext = {
  /** The page the user entered. */
  pageUrl: string;
  /** The repeating items sit inside nav/header/footer/menu-like chrome. */
  insideChrome?: boolean;
};

// Titles that name an action or a placeholder rather than an entry.
const PLACEHOLDER_TITLES = new Set([
  "untitled", "apply", "apply now", "jetzt bewerben", "bewerben", "mehr", "mehr lesen",
  "mehr erfahren", "mehr dazu", "weiterlesen", "weiter", "read more", "more", "learn more",
  "see more", "view more", "show more", "see all", "alle anzeigen", "mehr anzeigen", "details",
  "mehr details", "click here", "hier klicken", "hier", "zum artikel", "zum beitrag", "view",
  "open", "link", "home", "start", "startseite", "menu", "menü", "login", "log in", "sign in",
  "sign up", "anmelden", "registrieren", "register", "subscribe", "abonnieren", "share", "teilen",
  "next", "previous", "zurück", "newsletter", "kontakt", "contact", "impressum", "datenschutz",
  "privacy", "cookies", "get directions", "route", "download", "play", "abspielen", "anhören",
  "listen", "watch", "ansehen", "video", "audio", "jobs", "careers", "karriere",
  // fr / es / it
  "lire la suite", "lire plus", "en savoir plus", "voir plus", "plus", "suite", "postuler",
  "leer más", "leer mas", "ver más", "ver mas", "más información", "seguir leyendo", "más",
  "leggi di più", "leggi tutto", "scopri di più", "continua a leggere", "altro", "candidati",
]);

// Hosts whose links are ad clicks, trackers or URL shorteners — never an entry.
const AD_HOST_PATTERNS = [
  /(^|\.)doubleclick\.net$/, /(^|\.)googlesyndication\.com$/, /(^|\.)googleadservices\.com$/,
  /(^|\.)adservice\.google\./, /(^|\.)outbrain\.com$/, /(^|\.)taboola\.com$/, /(^|\.)criteo\.(com|net)$/,
  /(^|\.)adnxs\.com$/, /(^|\.)amazon-adsystem\.com$/, /(^|\.)smartadserver\.com$/, /(^|\.)adform\.net$/,
  /(^|\.)ad\.atdmt\.com$/, /(^|\.)t\.co$/, /(^|\.)bit\.ly$/, /(^|\.)lnkd\.in$/, /(^|\.)ow\.ly$/,
];
const AD_PATH = /\/(gampad\/clk|pagead\/|aclk\b|adclick|clicktrack)/i;

const MAP_HOST = /(^|\.)(maps\.google\.[a-z.]+|maps\.apple\.com|openstreetmap\.org|maps\.app\.goo\.gl|here\.com|waze\.com)$/;
const MAP_PATH_HOSTS = /(^|\.)(google\.[a-z.]+|bing\.com)$/; // …/maps on these hosts

const SOCIAL_HOST = /(^|\.)(facebook\.com|instagram\.com|twitter\.com|x\.com|whatsapp\.com|linkedin\.com|tiktok\.com|threads\.net|threads\.com|pinterest\.[a-z.]+|xing\.com|t\.me|telegram\.me|bsky\.app|youtube\.com|flickr\.com|soundcloud\.com|social\.bund\.de|mastodon\.social)$/;

// Auth/commerce flows. Matched only as the FIRST segment of a short path
// ("/login", "/auth/signin", "/cart") or as the exact LAST segment
// ("/u/login") — never anywhere in a path: "/sessions/opening-keynote" and
// "/join/weekly-meetup-berlin" are conference/event entries.
const LOGIN_FIRST_SEGMENT = /^(login|log-in|logon|logout|signin|sign-in|signup|sign-up|register|registration|registrieren|anmelden|anmeldung|abmelden|oauth|sso|auth|my-account|mein-konto|password|passwort|checkout|cart|warenkorb)$/i;
const LOGIN_LAST_SEGMENT = /^(login|log-in|logon|logout|signin|sign-in|signup|sign-up|register|registrieren|anmelden|abmelden)$/i;
const LOGIN_HOST = /^(login|accounts?|auth|signin|sso|id|my)\./;

// Path segments that introduce a taxonomy listing (category/tag/section page),
// not an entry: discourse /c/<slug>/<id>, WordPress /category/…, /tag/…
const TAXONOMY_SEGMENT = /^(c|category|categories|kategorie|kategorien|tag|tags|topic-tag|topic|topics|label|labels|rubrik|rubriken|ressort|ressorts|section|sections|schlagwort|schlagworte|archive|archiv|author|authors|autor|autoren|users?|u|profile|collections?)$/i;

// Section names whose items are expected to stay inside that section.
const CONTENT_SECTION = /^(news|blog|blogs|aktuelles|aktuell|nachrichten|presse|press|pressemitteilungen|press-releases|newsroom|changelog|releases|articles|artikel|posts|stories|updates|meldungen|magazin|magazine|journal|insights|research)$/i;

// Broadcast/media path tokens: a general news front page offering only these
// picked a TV/video/audio strip, not the news stream.
const MEDIA_TOKEN = /^(video|videos|tv|sendung|sendungen|mediathek|livestream|live|podcast|podcasts|audio|audios|multimedia|webtv)$/i;

// Not » or ›: French/German quotes close titles with them.
const CTA_ARROW = /[→↗➔➜⟶]\s*$/;
// Call-to-action phrasing at the start of a short title ("Learn more about
// your rights", "Mehr erfahren über …"): a button, not an entry title.
const CTA_PREFIX = /^(learn more|read more|find out more|see more|view more|click here|mehr erfahren|mehr lesen|jetzt mehr|hier klicken|en savoir plus|lire la suite|leer más|leggi di più|scopri di più)\b/i;

const TITLE_TRAILING = /[\s→↗➔➜⟶:|·•…\-–—.!?]/u;

/** Collapse whitespace, strip trailing CTA arrows/punctuation, lowercase. */
export function normalizeTitle(title: string): string {
  return trimEndWhile(title.replace(/\s+/g, " "), (ch) => TITLE_TRAILING.test(ch))
    .trim()
    .toLowerCase();
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Placeholder/action title ("Apply", "Read more", "Lire la suite"…). Very
 * short titles are placeholders only for alphabetic scripts and only when the
 * link does not itself look like an entry: "新闻" or "Go" → `/2026/11/go-1-30`
 * are real titles.
 */
export function isPlaceholderTitle(title: string | null | undefined, opts: { articleLikeLink?: boolean } = {}): boolean {
  if (!title) return true;
  const norm = normalizeTitle(title);
  if (!norm) return true;
  if (!/\p{L}/u.test(norm)) return true; // only digits/punctuation
  if (PLACEHOLDER_TITLES.has(norm)) return true;
  if (CTA_PREFIX.test(norm) && norm.split(" ").length <= 12) return true;
  if (norm.length < 3 && !CJK.test(norm) && !opts.articleLikeLink) return true;
  return false;
}

/** Strong evidence of an individual entry: a date, a long numeric id or a uuid in the URL. */
export function hasEntryIdOrDate(link: string): boolean {
  try {
    const u = new URL(link);
    const path = u.pathname;
    if (/\d{4}[/-]\d{1,2}([/-]\d{1,2})?/.test(path) || /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(path)) return true;
    return /(^|\D)\d{5,}(\D|$)/.test(path) || [...u.searchParams].some(([k, v]) => /^(id|p|article|story|post|item|nid|aid)$/i.test(k) && /\d/.test(v));
  } catch {
    return false;
  }
}

/** Registrable-ish site label: "www.faz.net" → "faz", "bbc.co.uk" → "bbc". */
export function siteLabel(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length < 2) return labels[0] ?? "";
  const last = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  if (labels.length >= 3 && last.length === 2 && /^(co|com|org|net|ac|gov|edu|or|ne|go)$/.test(second)) {
    return labels[labels.length - 3];
  }
  return second;
}

const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|mc_[a-z]+|ref|ref_src|aff|affiliate|recid|trk|trkinfo|source|src|cmp|wt_mc|at_medium|at_campaign|ns_.*|icid)$/i;

/** Link identity for duplicate detection: no hash, no tracking params, no trailing slash. */
export function linkKey(link: string): string {
  try {
    const u = new URL(link);
    const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k)).sort();
    const query = params.length ? "?" + params.map(([k, v]) => `${k}=${v}`).join("&") : "";
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${trimTrailingSlashes(u.pathname) || "/"}${query}`;
  } catch {
    return link;
  }
}

function pathSegments(pathname: string): string[] {
  const segments = pathname.split("/").filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  // "…/slug/index.html", "…/slug/html/index.en.html" → meaningful tail is "slug".
  while (segments.length && /^(index|default|home)(\.[a-z]{2})?\.(html?|php|aspx?)$/i.test(segments[segments.length - 1])) segments.pop();
  while (segments.length && /^(html?)$/i.test(segments[segments.length - 1])) segments.pop();
  return segments;
}

/**
 * Does this link look like an individual entry (slug, id, date, file) rather
 * than a hub/section/navigation target?
 */
export function isArticleLikeLink(link: string): boolean {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return false;
  }
  const segments = pathSegments(u.pathname);
  const path = segments.join("/");
  if (/\d{4}[/-]\d{1,2}([/-]\d{1,2})?/.test(path)) return true; // date in the path
  if (/\d{4,}/.test(path)) return true; // numeric ids
  if (/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(path)) return true; // uuid
  for (const [key, value] of u.searchParams) {
    if (/^(id|p|article|story|post|item|i|v|nid|aid)$/i.test(key) && /\d/.test(value)) return true;
  }
  const last = segments[segments.length - 1] ?? "";
  if (!last) return false;
  const words = last.replace(/\.[a-z0-9]{2,5}$/i, "").split(/[-_+]+/).filter(Boolean);
  if (words.length >= 3) return true; // slug
  // Short opaque ids like BBC "c3rryrryk59zo": letters and digits mixed.
  if (last.length >= 8 && /\d/.test(last) && /[a-z]/i.test(last)) return true;
  return false;
}

function hasPrefix(segments: string[], prefix: string[]): boolean {
  return prefix.every((s, i) => segments[i]?.toLowerCase() === s.toLowerCase());
}

/** Classify a single extracted item; `null` means it looks like a real entry. */
export type ClassifyContext = {
  /**
   * linkKeys of non-entry-like links that several items of the SAME list
   * point to (a section kicker repeated on every card, "/blog/product").
   * A short slug on its own is never a hub signal.
   */
  repeatedHubs?: Set<string>;
};

export function classifyItem(
  article: Pick<FetchedFeedArticle, "title" | "link" | "titleSynthetic">,
  page: URL,
  ctx: ClassifyContext = {},
): ItemIssue | null {
  const link = article.link?.trim();
  if (!link) return "noLink";
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return "noLink";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "noLink";
  const host = u.hostname.toLowerCase();
  if (AD_HOST_PATTERNS.some((re) => re.test(host)) || AD_PATH.test(u.pathname)) return "ad";
  if (MAP_HOST.test(host) || (MAP_PATH_HOSTS.test(host) && /^\/maps\b/.test(u.pathname))) return "map";

  const segments = pathSegments(u.pathname);
  if (
    LOGIN_HOST.test(host) ||
    (segments.length > 0 && segments.length <= 2 && LOGIN_FIRST_SEGMENT.test(segments[0])) ||
    (segments.length > 0 && LOGIN_LAST_SEGMENT.test(segments[segments.length - 1]))
  ) return "login";

  const sameSite = siteLabel(host) === siteLabel(page.hostname);
  // Profile/channel links to social networks (footer "follow us" lists);
  // an individual post/video link (id in path or query) is still an entry.
  if (!sameSite && SOCIAL_HOST.test(host) && !isArticleLikeLink(link)) return "social";

  // A title synthesized from the item's content (no real title on the page)
  // counts as missing: it says nothing about whether this is an entry.
  const articleLike = isArticleLikeLink(link);
  if (article.titleSynthetic || isPlaceholderTitle(article.title, { articleLikeLink: articleLike }) || CTA_ARROW.test(article.title.trim())) {
    return "placeholderTitle";
  }

  const pageSegments = pathSegments(page.pathname);
  const norm = normalizeTitle(article.title);
  const words = norm.split(" ").length;
  // The site root (or another site's homepage under a short label, like the
  // Wikipedia portal's sister projects), the page itself, or an ancestor of it.
  if (segments.length === 0 && (sameSite || words <= 4)) return "navigation";
  if (sameSite && segments.length <= pageSegments.length && hasPrefix(pageSegments, segments)) return "navigation";
  // Taxonomy listing (category/tag/author page).
  const taxonomyAt = segments.findIndex((s) => TAXONOMY_SEGMENT.test(s));
  if (taxonomyAt >= 0 && segments.length - taxonomyAt <= 3 && !/\d{4}[/-]\d{1,2}/.test(segments.join("/"))) {
    // "/c/help/7" or "/category/news" — but not "/users/x/posts/my-long-post-slug".
    const tail = segments.slice(taxonomyAt + 1);
    if (!tail.some((s) => s.split(/[-_]+/).length >= 4)) return "navigation";
  }
  // A sibling of the entered page (same parent, same depth, short name, no
  // id/date): peer profiles/categories — "/company/github" listed on
  // "/company/microsoft", "/c/ideas" on "/c/help".
  if (
    sameSite &&
    pageSegments.length > 0 &&
    segments.length === pageSegments.length &&
    hasPrefix(segments, pageSegments.slice(0, -1)) &&
    !hasEntryIdOrDate(link) &&
    segments[segments.length - 1].split(/[-_]+/).length <= 2
  ) return "navigation";

  // The same non-entry link repeated across the list's cards: a section
  // kicker ("/blog/product" on every Stripe card), not the entry. A short
  // slug alone ("/blog/regex", "/essays/the-gap") is a normal entry.
  if (!articleLike && ctx.repeatedHubs?.has(linkKey(link))) return "navigation";

  // Brand/show navigation: a very short title that starts or ends with the
  // site's own name ("tagesschau in 100 Sekunden", "Work at Apple"), unless
  // the link carries a date/id ("Acme opens Berlin office" →
  // /newsroom/2024/05/…). "Introducing Stripe Tax" is not brand navigation.
  const brand = siteLabel(page.hostname);
  if (brand.length >= 4 && words <= 4 && !hasEntryIdOrDate(link)) {
    const first = norm.split(" ")[0];
    const last = norm.split(" ")[words - 1];
    if (first.startsWith(brand) || last === brand) return "brandNavigation";
  }

  // A general news front page whose items are TV/video/audio programmes.
  // Whole directory segments ("/multimedia/…", "/video/…") or a leading file
  // token ("video-1681750.html"); never words inside an article slug
  // ("…-sur-arte-tv-…").
  if (sameSite && pageSegments.length === 0) {
    const dirs = segments.slice(0, -1);
    const lastToken = segments[segments.length - 1].split(/[-_.]+/)[0];
    if (dirs.some((s) => MEDIA_TOKEN.test(s)) || MEDIA_TOKEN.test(lastToken)) return "offScope";
  }

  return null;
}

/**
 * A short label pointing at a short, id-less path ("Accessibility" →
 * /accessibility, "Engineer jobs" → /jobs/engineer-jobs, "@handle" →
 * /handle). One such item is a normal entry ("Regex" → /blog/regex); a whole
 * undated, text-less list of them is a menu or facet list.
 */
function isHubLike(article: FetchedFeedArticle, page: URL): boolean {
  try {
    const u = new URL(article.link);
    // Links to other sites (an "awesome list" of repos) are not this site's menu.
    if (siteLabel(u.hostname) !== siteLabel(page.hostname)) return false;
    if (hasEntryIdOrDate(article.link)) return false;
    return pathSegments(u.pathname).length <= 2 && normalizeTitle(article.title).split(" ").length <= 3;
  } catch {
    return false;
  }
}

/**
 * Score the extracted items of one candidate. `articles` are ALL items the
 * candidate config yields (not just the preview).
 */
export function assessPreviewQuality(articles: FetchedFeedArticle[], ctx: QualityContext): PreviewQuality {
  let page: URL;
  try {
    page = new URL(ctx.pageUrl);
  } catch {
    page = new URL("https://invalid.invalid/");
  }
  const total = articles.length;
  const issues: Partial<Record<ItemIssue, number>> = {};
  const plausibleLinks = new Set<string>();
  const plausibleTitles = new Set<string>();
  const allLinks = new Set<string>();
  const allTitles = new Set<string>();
  let plausible = 0;
  let hubLike = 0;
  let hubLikeLeaving = 0;
  let withText = 0;
  let articleLike = 0;
  let dated = 0;
  let withImage = 0;
  let offsite = 0;
  let inSection = 0;

  const pageSegments = pathSegments(page.pathname);
  const section = pageSegments[0] && CONTENT_SECTION.test(pageSegments[0]) ? pageSegments[0].toLowerCase() : null;

  // Non-entry links that ≥2 items share (and that are not the majority link
  // of a duplicated list) are hubs/kickers.
  const hubCounts = new Map<string, number>();
  for (const article of articles) {
    if (!article.link || isArticleLikeLink(article.link)) continue;
    const key = linkKey(article.link);
    hubCounts.set(key, (hubCounts.get(key) ?? 0) + 1);
  }
  const repeatedHubs = new Set([...hubCounts].filter(([, n]) => n >= 2).map(([k]) => k));
  const offsiteHosts = new Set<string>();
  const itemIssues: Array<ItemIssue | null> = [];

  for (const article of articles) {
    const key = article.link ? linkKey(article.link) : "";
    if (key) allLinks.add(key);
    allTitles.add(normalizeTitle(article.title || ""));
    if (article.publishedAt) dated++;
    if (article.imageUrl) withImage++;
    const issue = classifyItem(article, page, { repeatedHubs });
    itemIssues.push(issue);
    if (issue) {
      issues[issue] = (issues[issue] ?? 0) + 1;
      continue;
    }
    plausible++;
    if (isHubLike(article, page)) {
      hubLike++;
      // …and leaves the entered page's own path (Apple /careers/us/ → /accessibility,
      // LinkedIn /company/x → /jobs/engineer-jobs): site navigation, not entries.
      try {
        const u = new URL(article.link);
        const first = pathSegments(u.pathname)[0]?.toLowerCase();
        if (pageSegments.length > 0 && siteLabel(u.hostname) === siteLabel(page.hostname) && first !== pageSegments[0].toLowerCase()) hubLikeLeaving++;
      } catch {
        /* classified above */
      }
    }
    if (stripTags(article.content ?? "").trim().length >= 40) withText++;
    plausibleLinks.add(key);
    plausibleTitles.add(normalizeTitle(article.title));
    if (isArticleLikeLink(article.link)) articleLike++;
    try {
      const u = new URL(article.link);
      if (siteLabel(u.hostname) !== siteLabel(page.hostname)) {
        offsite++;
        offsiteHosts.add(siteLabel(u.hostname));
      }
      else if (section && pathSegments(u.pathname)[0]?.toLowerCase() === section) inSection++;
    } catch {
      /* classified above */
    }
  }

  const distinctPlausible = Math.min(plausibleLinks.size, plausibleTitles.size);
  const junkFraction = total ? 1 - plausible / total : 1;
  const duplicateFraction = total ? 1 - Math.min(allLinks.size, allTitles.size) / total : 0;
  const articleLikeFraction = plausible ? articleLike / plausible : 0;
  const dateFraction = total ? dated / total : 0;
  const imageFraction = total ? withImage / total : 0;

  const scoreAdjustment =
    articleLikeFraction * 30 +
    dateFraction * 10 +
    imageFraction * 5 -
    junkFraction * 60 -
    duplicateFraction * 40 +
    Math.min(distinctPlausible, 10);

  const base = { plausibleItems: distinctPlausible, scoreAdjustment, issues, itemIssues };

  if (distinctPlausible < 3) {
    return { ...base, verdict: "reject", reasons: [], notes: [], rejectReason: "tooFewPlausibleItems" };
  }
  // ≥40 % non-entries: a wrong block (LinkedIn's office list: 45 Bing Maps
  // "Get directions" links among 107 items), not a feed with a few strays.
  if (junkFraction >= 0.4) {
    return { ...base, verdict: "reject", reasons: [], notes: [], rejectReason: "mostlyJunk" };
  }
  if (ctx.insideChrome && articleLikeFraction < 0.5) {
    return { ...base, verdict: "reject", reasons: [], notes: [], rejectReason: "navigationChrome" };
  }
  // A list made almost entirely of short labels → short paths, with neither
  // dates nor teaser text: a menu/facet list (Apple's "Accessibility,
  // Education…", LinkedIn's "Engineer jobs", a profile's @handles).
  if (
    plausible &&
    dateFraction < 0.3 &&
    (hubLikeLeaving / plausible >= 0.7 || (hubLike / plausible >= 0.7 && withText / plausible < 0.5))
  ) {
    return { ...base, verdict: "reject", reasons: [], notes: [], rejectReason: "navigationList" };
  }

  // Missing dates alone is NOT a review reason (most listing pages carry
  // none; the preview shows "no date" per item instead) — it is reported
  // separately in `notes`. Review reasons need several affected items so
  // one stray card in a 40-item list doesn't label a good feed.
  const junk = total - plausible;
  const duplicates = total - Math.min(allLinks.size, allTitles.size);
  const reasons: PreviewReviewReason[] = [];
  if (duplicateFraction >= 0.2 && duplicates >= 3) reasons.push("duplicates");
  if (junkFraction >= 0.25 && junk >= 3) reasons.push("mixedItems");
  if (distinctPlausible < 5) reasons.push("fewItems");
  // Aggregators link to many different sites (fine); a list that mostly
  // leaves for ONE or two other sites is likely the wrong block.
  if (plausible && offsite / plausible >= 0.5 && offsiteHosts.size <= 2) reasons.push("otherSites");
  else if (section && plausible && inSection / plausible < 0.5) reasons.push("outsideSection");
  const notes: PreviewNote[] = dateFraction < 0.5 ? ["missingDates"] : [];

  return { ...base, verdict: reasons.length ? "review" : "ok", reasons, notes };
}
