// Google News keyword feeds (G1): pure, client-safe URL helpers.
//
// A "Google News feed" is an ordinary feed whose URL is a Google News RSS
// search URL — no extra schema. Everything the UI needs (query, edition, time
// window) round-trips through that URL:
//
//   https://news.google.com/rss/search?q=<query>[ when:7d]&hl=de&gl=DE&ceid=DE%3Ade
//
// The origin can be overridden by the instance admin
// (`FEEDFERRET_GOOGLE_NEWS_BASE_URL`, server-side only — the e2e harness
// points it at the local fixture server); the client always builds/reads the
// public origin and the server rebuilds URLs itself.

export const GOOGLE_NEWS_ORIGIN = "https://news.google.com";
export const GOOGLE_NEWS_MAX_QUERY = 200;
/** Feeds are polled no more often than this (minutes) — Google throttles aggressive pollers. */
export const GOOGLE_NEWS_MIN_UPDATE_MINUTES = 30;

/** Editions offered in the UI (`<lang>-<REGION>`); any valid pair still parses. */
export const GOOGLE_NEWS_EDITIONS = [
  "de-DE",
  "de-AT",
  "de-CH",
  "en-US",
  "en-GB",
  "fr-FR",
  "es-ES",
  "it-IT",
  "nl-NL",
] as const;

/** Time windows (`when:` operator). "" = no restriction. */
export const GOOGLE_NEWS_WINDOWS = ["", "1h", "1d", "7d"] as const;
export type GoogleNewsWindow = (typeof GOOGLE_NEWS_WINDOWS)[number];

export type GoogleNewsSearch = {
  query: string;
  edition: string;
  when: GoogleNewsWindow;
};

const DEFAULT_REGION: Record<string, string> = {
  en: "US", de: "DE", fr: "FR", es: "ES", it: "IT", nl: "NL", pt: "BR", pl: "PL", sv: "SE", ja: "JP", tr: "TR",
};

/** Normalizes a UI locale ("de", "en-GB", "pt_BR") to an edition ("de-DE"). Defaults to de-DE. */
export function googleNewsEdition(locale?: string | null): string {
  if (!locale) return "de-DE";
  const [langRaw, regionRaw] = locale.replace("_", "-").split("-");
  const lang = /^[a-z]{2,3}$/i.test(langRaw ?? "") ? langRaw.toLowerCase() : "de";
  const region = /^[a-z]{2}$/i.test(regionRaw ?? "") ? regionRaw.toUpperCase() : DEFAULT_REGION[lang] ?? "US";
  return `${lang}-${region}`;
}

/** Edition → Google's hl/gl/ceid triple (English keeps the region in `hl`). */
export function googleNewsLocaleParams(edition: string): { hl: string; gl: string; ceid: string } {
  const [lang, region] = googleNewsEdition(edition).split("-");
  return { hl: lang === "en" ? `en-${region}` : lang, gl: region, ceid: `${region}:${lang}` };
}

const WHEN_TOKEN = /(?:^|\s)when:(\d+[hdwmy])\s*$/i;

/** Collapses whitespace, drops control chars and caps the length. */
export function normalizeGoogleNewsQuery(raw: string): string {
  return String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, GOOGLE_NEWS_MAX_QUERY);
}

function isWindow(value: unknown): value is GoogleNewsWindow {
  return typeof value === "string" && (GOOGLE_NEWS_WINDOWS as readonly string[]).includes(value);
}

/**
 * Builds the RSS search URL. Operators inside the query (quotes, OR, -word,
 * site:, intitle:, after:/before:) are passed through untouched; the time
 * window is appended as a trailing `when:` token (an explicit trailing
 * `when:` in the query is replaced). Returns null for an empty query.
 */
export function buildGoogleNewsSearchUrl(
  search: { query: string; edition?: string | null; when?: string | null },
  origin: string = GOOGLE_NEWS_ORIGIN,
): string | null {
  let query = normalizeGoogleNewsQuery(search.query);
  const when = isWindow(search.when) ? search.when : "";
  if (when) query = query.replace(WHEN_TOKEN, "").trim();
  if (!query) return null;
  const q = when ? `${query} when:${when}` : query;
  const { hl, gl, ceid } = googleNewsLocaleParams(search.edition || "de-DE");
  const enc = encodeURIComponent;
  return `${origin.replace(/\/+$/, "")}/rss/search?q=${enc(q)}&hl=${enc(hl)}&gl=${enc(gl)}&ceid=${enc(ceid)}`;
}

/** True for a Google News RSS URL on the given origins (public origin always included). */
export function isGoogleNewsRssUrl(url: string | null | undefined, extraOrigins: string[] = []): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const origins = new Set([GOOGLE_NEWS_ORIGIN, ...extraOrigins]);
    return origins.has(u.origin) && u.pathname.startsWith("/rss");
  } catch {
    return false;
  }
}

/** Reverse of `buildGoogleNewsSearchUrl`; null when the URL is not a Google News search feed. */
export function parseGoogleNewsSearchUrl(url: string | null | undefined, extraOrigins: string[] = []): GoogleNewsSearch | null {
  if (!isGoogleNewsRssUrl(url, extraOrigins)) return null;
  const u = new URL(url!);
  if (u.pathname.replace(/\/+$/, "") !== "/rss/search") return null;
  let query = normalizeGoogleNewsQuery(u.searchParams.get("q") ?? "");
  if (!query) return null;
  let when: GoogleNewsWindow = "";
  const m = WHEN_TOKEN.exec(query);
  if (m && isWindow(m[1].toLowerCase())) {
    when = m[1].toLowerCase() as GoogleNewsWindow;
    query = query.replace(WHEN_TOKEN, "").trim();
  }
  const hl = u.searchParams.get("hl") ?? "";
  const gl = u.searchParams.get("gl") ?? "";
  const ceid = u.searchParams.get("ceid") ?? "";
  const lang = (ceid.split(":")[1] || hl.split("-")[0] || "de").toLowerCase();
  const region = (gl || ceid.split(":")[0] || "").toUpperCase();
  return { query, edition: googleNewsEdition(region ? `${lang}-${region}` : lang), when };
}

/** Default display name of a keyword feed. */
export function googleNewsFeedName(query: string): string {
  return `Google News: ${normalizeGoogleNewsQuery(query).replace(WHEN_TOKEN, "").trim()}`;
}

/** Whether `name` is the auto-generated name for `query` (so a query edit may rename it). */
export function isAutoGoogleNewsName(name: string | null | undefined, query: string): boolean {
  return !!name && name === googleNewsFeedName(query);
}
