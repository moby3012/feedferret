/** Conditions of an API platform source that say nothing about an individual
 * feed (credentials missing/rejected, shared quota exhausted, provider outage).
 * Sync treats them like a saturated HTML worker: no failure streak, no
 * auto-mute, retry on the next sync.
 *  - "unconfigured" / "auth": an admin must act → shown on the feed (see below).
 *  - "rate-limited": quota exhausted until its reset.
 *  - "transient": network error, timeout or 5xx of the provider. */
export type ApiSourceDeferredReason = "unconfigured" | "auth" | "rate-limited" | "transient";

export class ApiSourceDeferredError extends Error {
  constructor(
    readonly reason: ApiSourceDeferredReason,
    message: string,
    /** HTTP status of the upstream answer, when there was one (never a body). */
    readonly status?: number,
    /** Milliseconds until a rate limit resets, when known. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ApiSourceDeferredError";
  }
}

export function isApiSourceDeferredError(error: unknown): error is ApiSourceDeferredError {
  return error instanceof ApiSourceDeferredError || (error instanceof Error && error.name === "ApiSourceDeferredError");
}

/** Feed.lastStatus of a feed that is neither healthy nor failing: an admin has to fix credentials. */
export const API_SOURCE_ATTENTION_STATUS = "attention";
const ATTENTION_PREFIX = "api-source:";
export type ApiSourceAttentionReason = "unconfigured" | "auth";

/** The Feed.lastError code stored for an attention status (a code, not display text). */
export function apiSourceAttentionCode(reason: ApiSourceAttentionReason): string {
  return `${ATTENTION_PREFIX}${reason}`;
}

/** Which setup hint the UI shows for a feed row, or null for ordinary healthy/failing feeds. */
export function apiSourceAttentionReason(feed: { lastStatus?: string | null; lastError?: string | null }): ApiSourceAttentionReason | null {
  if (feed.lastStatus !== API_SOURCE_ATTENTION_STATUS || !feed.lastError?.startsWith(ATTENTION_PREFIX)) return null;
  const reason = feed.lastError.slice(ATTENTION_PREFIX.length);
  return reason === "unconfigured" || reason === "auth" ? reason : null;
}
