/** Generic AutoTTL. No article writes; publication time is the signal, never ingestion volume. */
export const MINUTE_MS = 60_000;
export function refreshBounds() {
    const positive = (value: string | undefined, fallback: number) => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    const min = positive(process.env.FEED_MIN_REFRESH_MINUTES, 15);
    return { min, max: Math.max(min, positive(process.env.FEED_MAX_REFRESH_MINUTES, 1440)) };
}

type Publication = { publishedAt?: Date | null; createdAt: Date };
/** Median of distinct publication clusters resists bursts; age prevents backfills looking busy. */
export function publicationCadence(items: Publication[], now = Date.now()): number | null {
    const times = [...new Set(items.map((item) => (item.publishedAt ?? item.createdAt).getTime())
        .filter((time) => Number.isFinite(time) && time <= now))].sort((a, b) => b - a).slice(0, 40);
    const rawGaps = times.slice(1).map((time, index) => times[index] - time).sort((a, b) => a - b);
    const threshold = Math.min(5 * MINUTE_MS, (rawGaps[Math.floor(rawGaps.length / 2)] ?? 0) / 2);
    const clusters = times.filter((time, index) => index === 0 || times[index - 1] - time >= threshold);
    if (clusters.length < 2) return null;
    const gaps = clusters.slice(1).map((time, index) => (clusters[index] - time) / MINUTE_MS).sort((a, b) => a - b);
    const middle = Math.floor(gaps.length / 2);
    return gaps.length % 2 ? gaps[middle] : (gaps[middle - 1] + gaps[middle]) / 2;
}

export function adaptiveInterval(items: Publication[], explicitMinutes: number | null, inheritedMinimum: number, now = Date.now()) {
    const { min, max } = refreshBounds();
    if (explicitMinutes && explicitMinutes > 0) return Math.max(5, Number(process.env.FEED_MIN_REFRESH_MINUTES) || 5, explicitMinutes);
    const cadence = publicationCadence(items, now);
    const latest = Math.max(0, ...items.map((item) => (item.publishedAt ?? item.createdAt).getTime()).filter((time) => Number.isFinite(time) && time <= now));
    const idle = latest ? (now - latest) / MINUTE_MS / 2 : 0;
    return Math.max(min, inheritedMinimum, Math.min(max, Math.max(cadence ?? 60, idle)));
}

/** Persisted, indexed due selection shared by scheduler tests. Manual refresh bypasses this. */
export function dueFeedWhere(now = new Date()) {
    return { archivedAt: null, autoMuted: false, sourceType: { not: "newsletter" }, OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: now } }] };
}

/** First background observation persists a Date; pure-DDL legacy adoption leaves schedules NULL. */
export function initialSyncAt(feedId: string, now = Date.now()): Date {
    let hash = 2166136261;
    for (const char of feedId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    return new Date(now + 1000 + hash % (15 * MINUTE_MS));
}

/** Host quotas may be longer, but each feed rechecks within the automatic ceiling. */
export function deferredSyncAt(waitMs: number, now = Date.now()): Date {
    return new Date(now + Math.min(waitMs, refreshBounds().max * MINUTE_MS));
}
