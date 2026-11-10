/**
 * Bounds for per-feed fetch options that a user can set. Unbounded values let a
 * single user exhaust memory/sockets of the shared Node process for everyone.
 */
export const FEED_LIMITS = {
  maxSizeKb: { min: 64, max: 20 * 1024 },
  fetchTimeoutSecs: { min: 5, max: 120 },
  updateFrequency: { min: 5, max: 10080 },
  retentionDays: { min: 0, max: 3650 },
  keepMinArticles: { min: 0, max: 10000 },
} as const;

/** Clamps known numeric feed fields in place; non-numeric values become null. */
export function clampFeedLimits<T extends Record<string, unknown>>(data: T): T {
  const out = data as Record<string, unknown>;
  for (const [key, { min, max }] of Object.entries(FEED_LIMITS)) {
    if (out[key] === undefined || out[key] === null) continue;
    const n = Number(out[key]);
    out[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : null;
  }
  return data;
}
