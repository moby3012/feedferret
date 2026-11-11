import { readPlainColumn } from "@/lib/secret-box";

// Feed columns that must never leave the server in list/bootstrap payloads
// (security audit #2, N4). The per-feed Basic-Auth credentials and the
// Scout-Studio fetch options (cookies, headers, proxy user:pass) are only
// loaded on demand, for the owner, by the feed settings dialog
// (`getFeedEditConfig`); the password itself is write-only everywhere.

export const FEED_SECRET_FIELDS = [
  "authPassword",
  "authUsername",
  "httpOptions",
  "scraperConfig",
  "etag",
  "lastModifiedHeader",
] as const;

export type FeedSecretField = (typeof FEED_SECRET_FIELDS)[number];

/**
 * Explicit allowlist of the Feed columns the reader shell and feed management
 * UI need. Used as a Prisma `select` so a newly added secret column never
 * leaks by default.
 */
export const FEED_CLIENT_SELECT = {
  id: true,
  url: true,
  name: true,
  icon: true,
  sourceType: true,
  htmlUrl: true,
  description: true,
  priority: true,
  unicityCriteria: true,
  unicityCriteriaForced: true,
  userId: true,
  categoryId: true,
  order: true,
  updateFrequency: true,
  retentionDays: true,
  keepMinArticles: true,
  lastFetchedAt: true,
  lastStatus: true,
  lastError: true,
  consecutiveFailureCount: true,
  autoMuted: true,
  authType: true,
  customUserAgent: true,
  fetchTimeoutSecs: true,
  sslVerify: true,
  maxSizeKb: true,
  fullTextSelector: true,
  fullTextRemoveSelectors: true,
  autoFetchFullText: true,
  fullTextConditions: true,
  fullTextMode: true,
  defaultContentFormat: true,
  fullTextAutoSuggestDismissed: true,
  filtersActionRead: true,
  hideFromAllFeeds: true,
  hideArticleImage: true,
  readerFontSizeOverride: true,
  readerWidthOverride: true,
  openOriginalOverride: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Removes every secret feed column from a feed object or array (no mutation). */
export function stripFeedSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripFeedSecrets(item)) as T;
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (!FEED_SECRET_FIELDS.some((field) => field in record)) return value;
  const out: Record<string, unknown> = { ...record };
  for (const field of FEED_SECRET_FIELDS) delete out[field];
  return out as T;
}

// ─── Encrypted-at-rest reads (security audit #2, M8) ───────────────────────
// `authUsername`, `authPassword` and `httpOptions` may be stored as legacy
// plaintext or as v2 `ff2.` ciphertext. This release only reads v2; writers
// still store plaintext (M8 PR 5 switches them). A value the configured keys
// cannot open throws `SecretKeyError`, so a fetch ends in an error status
// instead of being sent without its credentials.

type FeedCredentialColumns = {
  authUsername?: string | null;
  authPassword?: string | null;
  httpOptions?: string | null;
};

export function readFeedCredentials<T extends FeedCredentialColumns>(feed: T): T {
  const out = { ...feed };
  if ("authUsername" in feed) out.authUsername = readPlainColumn("feed.authUsername", feed.authUsername);
  if ("authPassword" in feed) out.authPassword = readPlainColumn("feed.authPassword", feed.authPassword);
  if ("httpOptions" in feed) out.httpOptions = readPlainColumn("feed.httpOptions", feed.httpOptions);
  return out;
}

// ─── httpOptions for the settings dialog (write-only secrets) ─────────────
// Cookies, request headers (Authorization …), POST bodies, proxy URLs with
// credentials and any unknown cURL option are secrets. The dialog only sees
// them as "__keep__"; saving that placeholder keeps the stored value, a
// removed key clears it, a new value replaces it.

export const HTTP_OPTION_KEEP = "__keep__";

/** Options that never carry credentials and are shown as-is. Everything else is masked. */
const PUBLIC_HTTP_OPTIONS = new Set([
  "CURLOPT_FOLLOWLOCATION",
  "CURLOPT_MAXREDIRS",
  "CURLOPT_POST",
  "CURLOPT_PROXYTYPE",
  "CURLOPT_USERAGENT",
]);

function parseOptionsObject(value: string | null | undefined): Record<string, unknown> | null {
  if (!value || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Mask every non-public option of a decrypted httpOptions JSON. `masked` lists the masked option names. */
export function redactHttpOptions(plain: string | null | undefined): { httpOptions: string | null; masked: string[] } {
  const options = parseOptionsObject(plain);
  if (!options) return { httpOptions: null, masked: [] };
  const masked: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (PUBLIC_HTTP_OPTIONS.has(key)) out[key] = value;
    else {
      out[key] = HTTP_OPTION_KEEP;
      masked.push(key);
    }
  }
  return { httpOptions: Object.keys(out).length ? JSON.stringify(out) : null, masked };
}

/**
 * Resolve "__keep__" placeholders in an incoming httpOptions JSON against the
 * stored (decrypted) value. Keys sent as "__keep__" keep their stored value
 * (dropped if nothing is stored); input without placeholders is returned as-is.
 */
export function mergeHttpOptions(incoming: string, storedPlain: string | null): string | null {
  if (!incoming.includes(HTTP_OPTION_KEEP)) return incoming;
  const next = parseOptionsObject(incoming);
  if (!next) return incoming;
  const stored = parseOptionsObject(storedPlain) ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (value === HTTP_OPTION_KEEP) {
      if (Object.prototype.hasOwnProperty.call(stored, key)) out[key] = stored[key];
    } else out[key] = value;
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}
