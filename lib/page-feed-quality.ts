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

/** Why a candidate that is still offered needs a human look (UI-translated). */
export type PreviewReviewReason =
  | "missingDates" // fewer than half of the items carry a date
  | "duplicates" // the same link/title repeats across items
  | "mixedItems" // some items look like navigation, ads, login or placeholders
  | "fewItems" // only 3–4 distinct plausible items
  | "outsideSection" // the URL names a section (/news, /blog…) but items link elsewhere
  | "otherSites"; // most items leave the site

/** Why a candidate is not offered at all (logs/bench/tests; never shown raw). */
export type PreviewRejectReason =
  | "tooFewPlausibleItems"
  | "mostlyJunk"
  | "navigationChrome";

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
  rejectReason?: PreviewRejectReason;
  /** Distinct (by link and title) items that look like real entries. */
  plausibleItems: number;
  /** Ranking adjustment added to the structural score. */
  scoreAdjustment: number;
  issues: Partial<Record<ItemIssue, number>>;
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

const LOGIN_SEGMENT = /^(login|log-in|logon|signin|sign-in|signup|sign-up|register|registration|registrieren|anmelden|anmeldung|auth|oauth|sso|account|accounts|my-account|mein-konto|join|session|sessions|password|passwort|checkout|cart|warenkorb)$/i;
const LOGIN_HOST = /^(login|accounts?|auth|signin|sso|id|my)\./;

// Path segments that introduce a taxonomy listing (category/tag/section page),
// not an entry: discourse /c/<slug>/<id>, WordPress /category/…, /tag/…
const TAXONOMY_SEGMENT = /^(c|category|categories|kategorie|kategorien|tag|tags|topic-tag|label|labels|rubrik|rubriken|ressort|ressorts|section|sections|schlagwort|schlagworte|archive|archiv|author|authors|autor|autoren|users?|u|profile)$/i;

// Section names whose items are expected to stay inside that section.
const CONTENT_SECTION = /^(news|blog|blogs|aktuelles|aktuell|nachrichten|presse|press|pressemitteilungen|press-releases|newsroom|changelog|releases|articles|artikel|posts|stories|updates|meldungen|magazin|magazine|journal|insights|research)$/i;

// Broadcast/media path tokens: a general news front page offering only these
// picked a TV/video/audio strip, not the news stream.
const MEDIA_TOKEN = /^(video|videos|tv|sendung|sendungen|mediathek|livestream|live|podcast|podcasts|audio|audios|multimedia|webtv)$/i;

// Not » or ›: French/German quotes close titles with them.
const CTA_ARROW = /[→↗➔➜⟶]\s*$/;

/** Collapse whitespace, strip trailing CTA arrows/punctuation, lowercase. */
export function normalizeTitle(title: string): string {
  return title
    .replace(/\s+/g, " ")
    .replace(/[\s→↗➔➜⟶:|·•…\-–—.!?]+$/u, "")
    .trim()
    .toLowerCase();
}

export function isPlaceholderTitle(title: string | null | undefined): boolean {
  if (!title) return true;
  const norm = normalizeTitle(title);
  if (norm.length < 3) return true;
  if (!/\p{L}/u.test(norm)) return true; // only digits/punctuation
  return PLACEHOLDER_TITLES.has(norm);
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
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "") || "/"}${query}`;
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
export function classifyItem(article: Pick<FetchedFeedArticle, "title" | "link" | "titleSynthetic">, page: URL): ItemIssue | null {
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
  if (LOGIN_HOST.test(host) || segments.some((s) => LOGIN_SEGMENT.test(s))) return "login";

  const sameSite = siteLabel(host) === siteLabel(page.hostname);
  // Profile/channel links to social networks (footer "follow us" lists);
  // an individual post/video link (id in path or query) is still an entry.
  if (!sameSite && SOCIAL_HOST.test(host) && !isArticleLikeLink(link)) return "social";

  // A title synthesized from the item's content (no real title on the page)
  // counts as missing: it says nothing about whether this is an entry.
  if (article.titleSynthetic || isPlaceholderTitle(article.title) || CTA_ARROW.test(article.title.trim())) return "placeholderTitle";

  const articleLike = isArticleLikeLink(link);
  const pageSegments = pathSegments(page.pathname);
  // The page itself, the site root, or an ancestor of the page.
  if (segments.length === 0) return "navigation";
  if (sameSite && segments.length <= pageSegments.length && hasPrefix(pageSegments, segments)) return "navigation";
  // Taxonomy listing (category/tag/author page).
  const taxonomyAt = segments.findIndex((s) => TAXONOMY_SEGMENT.test(s));
  if (taxonomyAt >= 0 && segments.length - taxonomyAt <= 3 && !/\d{4}[/-]\d{1,2}/.test(segments.join("/"))) {
    // "/c/help/7" or "/category/news" — but not "/users/x/posts/my-long-post-slug".
    const tail = segments.slice(taxonomyAt + 1);
    if (!tail.some((s) => s.split(/[-_]+/).length >= 4)) return "navigation";
  }
  // Single-word hub one or two levels deep ("/accessibility", "/blog/product",
  // "/sections/economy") — "/news/s1-sec" style short slugs stay entries.
  if (!articleLike && segments.length <= 2) {
    const last = segments[segments.length - 1];
    if (last.split(/[-_+.]+/).filter(Boolean).length <= 1) return "navigation";
    // Short label + short hub link ("Engineer jobs" → /jobs/engineer-jobs).
    if (normalizeTitle(article.title).split(" ").length <= 3) return "navigation";
  }

  // Brand/show navigation: very short title naming the site itself
  // ("tagesschau in 100 Sekunden", "Work at Apple").
  const brand = siteLabel(page.hostname);
  const norm = normalizeTitle(article.title);
  if (brand.length >= 4 && norm.split(" ").length <= 4 && norm.includes(brand)) return "brandNavigation";

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
  let articleLike = 0;
  let dated = 0;
  let withImage = 0;
  let offsite = 0;
  let inSection = 0;

  const pageSegments = pathSegments(page.pathname);
  const section = pageSegments[0] && CONTENT_SECTION.test(pageSegments[0]) ? pageSegments[0].toLowerCase() : null;

  for (const article of articles) {
    const key = article.link ? linkKey(article.link) : "";
    if (key) allLinks.add(key);
    allTitles.add(normalizeTitle(article.title || ""));
    if (article.publishedAt) dated++;
    if (article.imageUrl) withImage++;
    const issue = classifyItem(article, page);
    if (issue) {
      issues[issue] = (issues[issue] ?? 0) + 1;
      continue;
    }
    plausible++;
    plausibleLinks.add(key);
    plausibleTitles.add(normalizeTitle(article.title));
    if (isArticleLikeLink(article.link)) articleLike++;
    try {
      const u = new URL(article.link);
      if (siteLabel(u.hostname) !== siteLabel(page.hostname)) offsite++;
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

  const base = { plausibleItems: distinctPlausible, scoreAdjustment, issues };

  if (distinctPlausible < 3) {
    return { ...base, verdict: "reject", reasons: [], rejectReason: "tooFewPlausibleItems" };
  }
  if (junkFraction > 0.5) {
    return { ...base, verdict: "reject", reasons: [], rejectReason: "mostlyJunk" };
  }
  if (ctx.insideChrome && articleLikeFraction < 0.5) {
    return { ...base, verdict: "reject", reasons: [], rejectReason: "navigationChrome" };
  }

  const reasons: PreviewReviewReason[] = [];
  if (dateFraction < 0.5) reasons.push("missingDates");
  if (duplicateFraction >= 0.2) reasons.push("duplicates");
  if (junkFraction >= 0.15) reasons.push("mixedItems");
  if (distinctPlausible < 5) reasons.push("fewItems");
  if (plausible && offsite / plausible >= 0.5) reasons.push("otherSites");
  else if (section && plausible && inSection / plausible < 0.5) reasons.push("outsideSection");

  return { ...base, verdict: reasons.length ? "review" : "ok", reasons };
}
