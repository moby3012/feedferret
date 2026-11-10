// Pure, isomorphic helpers that derive list metadata from an article: its
// "kind" (article / video / audio / social / image), estimated reading time
// and primary media attachment. Computed once at sync time into the nullable
// `Article.kind / readMinutes / media*` columns; rows synced before those
// columns existed are filled by lib/article-meta-backfill.ts and, until then,
// derived on the fly by the list mapper (server/articles/list.ts).
//
// No DOM, no DOMPurify, no I/O: cheap enough to run per row.

export type ArticleKind = "article" | "video" | "audio" | "social" | "image";
export const ARTICLE_KINDS: readonly ArticleKind[] = ["article", "video", "audio", "social", "image"];

export function isArticleKind(value: unknown): value is ArticleKind {
  return typeof value === "string" && (ARTICLE_KINDS as readonly string[]).includes(value);
}

export interface DeriveKindInput {
  /** MIME type of the primary enclosure / media:content, if any. */
  enclosureType?: string | null;
  /** iTunes / media:content duration in seconds, if the feed provided one. */
  durationSecs?: number | null;
  link?: string | null;
  feedUrl?: string | null;
  title?: string | null;
  /** Length of the article's plain text. `null`/`undefined` = unknown (treated as long). */
  textLength?: number | null;
  /** Start of the article's plain text (only the first ~60 chars are used). */
  text?: string | null;
  imageUrl?: string | null;
}

const VIDEO_HOSTS = ["youtube.com", "youtu.be", "vimeo.com", "twitch.tv"];
const SOCIAL_HOSTS = ["bsky.app", "t.me", "threads.net", "x.com"];

function hostMatches(host: string, domains: string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

function parseUrl(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Title is missing, a placeholder, or just the beginning of the body (typical for social posts). */
function titleIsBodyLike(title: string, text: string): boolean {
  const t = normalizeSpace(title);
  if (!t || t.toLowerCase() === "untitled") return true;
  const body = normalizeSpace(text);
  if (!body) return false;
  const head = body.slice(0, 60).trim();
  if (t === head) return true;
  // Feeds that truncate the post into the title usually append an ellipsis.
  const stripped = t.replace(/(…|\.\.\.)$/, "").trim();
  return stripped.length >= Math.min(20, body.length) && stripped.length <= 60 && body.startsWith(stripped) && stripped !== t;
}

/**
 * First match wins:
 * 1. audio enclosure, or an iTunes duration without a video enclosure → audio
 * 2. video enclosure / media, a video host link, a PeerTube watch path or a
 *    YouTube channel feed → video
 * 3. (title empty / "Untitled" / the body's first 60 chars) and body ≤ 500
 *    chars, or a social host link / Mastodon status path → social
 * 4. image set and body < 80 chars → image
 * 5. article
 */
export function deriveKind(input: DeriveKindInput): ArticleKind {
  const type = (input.enclosureType ?? "").toLowerCase();
  const isVideoType = type.startsWith("video/");
  if (type.startsWith("audio/") || (input.durationSecs != null && input.durationSecs > 0 && !isVideoType)) return "audio";

  const url = parseUrl(input.link);
  const host = url?.hostname.toLowerCase() ?? "";
  const path = url?.pathname ?? "";
  if (
    isVideoType ||
    (host && hostMatches(host, VIDEO_HOSTS)) ||
    path.includes("/videos/watch/") ||
    (input.feedUrl ?? "").toLowerCase().includes("youtube.com/feeds/videos.xml")
  ) {
    return "video";
  }

  const textLength = input.textLength ?? Number.POSITIVE_INFINITY;
  if (
    (textLength <= 500 && titleIsBodyLike(input.title ?? "", input.text ?? "")) ||
    (host && hostMatches(host, SOCIAL_HOSTS)) ||
    /\/@[^/]+\/\d+/.test(path)
  ) {
    return "social";
  }

  if (input.imageUrl && textLength < 80) return "image";
  return "article";
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Cheap tag strip + entity decode; good enough for lengths and word counts. */
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return "";
  return normalizeSpace(
    html
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>?/g, " ")
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent: string) => {
        if (ent[0] === "#") {
          const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
          return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
        }
        return NAMED_ENTITIES[ent.toLowerCase()] ?? m;
      }),
  );
}

/** Rough Markdown → text (enough for reading-time and kind heuristics). */
export function markdownToPlainText(md: string | null | undefined): string {
  if (!md) return "";
  return normalizeSpace(
    md
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]*>?/g, " ")
      .replace(/[#>*_`~|-]+/g, " "),
  );
}

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g;
const WORDS_PER_MINUTE = 200;

/** Minutes at 200 wpm (CJK characters count as words), rounded up; `null` for empty text. */
export function estimateReadMinutes(text: string): number | null {
  const cjk = text.match(CJK)?.length ?? 0;
  const words = text.replace(CJK, " ").split(/\s+/).filter(Boolean).length + cjk;
  if (words === 0) return null;
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}

/** iTunes duration: "3723", "62:03", "1:02:03" (or a number of seconds). */
export function parseDurationSecs(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Math.round(Number(v));
    return n > 0 ? n : null;
  }
  if (!/^\d+(:\d{1,2}){1,2}$/.test(v)) return null;
  const secs = v.split(":").map(Number).reduce((acc, part) => acc * 60 + part, 0);
  return secs > 0 ? secs : null;
}

export interface MediaInfo {
  url: string | null;
  type: string | null;
  durationSecs: number | null;
}

type EnclosureLike = { href?: string | null; url?: string | null; type?: string | null };

function parseEnclosures(value: string | EnclosureLike[] | null | undefined): EnclosureLike[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** First audio/video enclosure (falls back to media:content), plus the duration. */
export function pickMedia(input: {
  enclosures?: string | EnclosureLike[] | null;
  mediaUrl?: string | null;
  mediaType?: string | null;
  durationSecs?: number | null;
}): MediaInfo | null {
  const av = parseEnclosures(input.enclosures).find((e) => /^(audio|video)\//i.test(e.type ?? "") && (e.href || e.url));
  const url = av ? (av.href || av.url || null) : input.mediaType && /^(audio|video)\//i.test(input.mediaType) ? input.mediaUrl ?? null : null;
  const type = av ? (av.type || null) : url ? input.mediaType ?? null : null;
  const durationSecs = input.durationSecs ?? null;
  if (!url && !type && durationSecs == null) return null;
  return { url, type, durationSecs };
}

export interface ArticleMetaInput {
  content: string | null | undefined;
  contentFormat?: string | null;
  title?: string | null;
  link?: string | null;
  imageUrl?: string | null;
  enclosures?: string | EnclosureLike[] | null;
  feedUrl?: string | null;
  /** media:content (when the feed has no audio/video enclosure). */
  mediaUrl?: string | null;
  mediaType?: string | null;
  durationSecs?: number | null;
}

export interface ArticleMeta {
  kind: ArticleKind;
  readMinutes: number | null;
  mediaUrl: string | null;
  mediaType: string | null;
  mediaDurationSecs: number | null;
}

/** Everything the nullable list-metadata columns hold, from the stored article fields. */
export function computeArticleMeta(input: ArticleMetaInput): ArticleMeta {
  const text = input.contentFormat === "markdown" ? markdownToPlainText(input.content) : htmlToPlainText(input.content);
  const media = pickMedia({ enclosures: input.enclosures, mediaUrl: input.mediaUrl, mediaType: input.mediaType, durationSecs: input.durationSecs });
  const kind = deriveKind({
    enclosureType: media?.type ?? null,
    durationSecs: media?.durationSecs ?? null,
    link: input.link,
    feedUrl: input.feedUrl,
    title: input.title,
    textLength: text.length,
    text: text.slice(0, 120),
    imageUrl: input.imageUrl,
  });
  return {
    kind,
    readMinutes: estimateReadMinutes(text),
    mediaUrl: media?.url ?? null,
    mediaType: media?.type ?? null,
    mediaDurationSecs: media?.durationSecs ?? null,
  };
}
