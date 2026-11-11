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
