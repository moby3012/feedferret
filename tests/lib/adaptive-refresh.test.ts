import { afterEach, describe, expect, it, vi } from "vitest";
import { adaptiveInterval, dueFeedWhere, publicationCadence } from "../../lib/adaptive-refresh";
import { HostDeferredError, resetHostBackoff, withPoliteHost } from "../../lib/host-backoff";
import { HttpStatusError, parseRetryAfterMs } from "../../lib/ssrf";
const now = Date.UTC(2026, 10, 12);
const item = (minutesAgo: number) => ({ publishedAt: new Date(now - minutesAgo * 60000), createdAt: new Date(now) });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); resetHostBackoff(); });
describe("publication cadence", () => {
    it("learns cautiously for new and single-item feeds", () => {
        expect(publicationCadence([], now)).toBeNull();
        expect(publicationCadence([item(30)], now)).toBeNull();
        expect(adaptiveInterval([], null, 15, now)).toBe(60);
    });
    it("uses median gaps and ignores future dates and duplicate bursts", () => {
        expect(publicationCadence([item(-100), item(0), item(0), item(1), item(60), item(120), item(10000)], now)).toBe(60);
        expect(publicationCadence([{ createdAt: new Date(now) }, { createdAt: new Date(now - 86400000) }], now)).toBe(1440);
    });
    it("does not interpret an old backfill dump as a busy live feed", () => {
        const dump = Array.from({ length: 40 }, (_, i) => item(60 * 24 * 100 + i * 10));
        expect(adaptiveInterval(dump, null, 15, now)).toBe(1440);
    });
    it("respects bounds, inherited preferences and explicit feed overrides", () => {
        expect(adaptiveInterval([item(0), item(10)], null, 15, now)).toBe(15);
        expect(adaptiveInterval([item(0), item(10)], null, 60, now)).toBe(60);
        expect(adaptiveInterval([item(0), item(1440)], 30, 60, now)).toBe(30);
        vi.stubEnv("FEED_MIN_REFRESH_MINUTES", "45");
        expect(adaptiveInterval([], 10, 60, now)).toBe(45);
    });
    it("selects active due and new subscriptions using persisted schedule", () => {
        expect(dueFeedWhere(new Date(now))).toEqual({ archivedAt: null, autoMuted: false, sourceType: { not: "newsletter" }, OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: new Date(now) } }] });
    });
});
it("parses Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfterMs("120", now)).toBe(120000);
    expect(parseRetryAfterMs(new Date(now + 60000).toUTCString(), now)).toBe(60000);
    expect(parseRetryAfterMs("invalid", now)).toBeNull();
    expect(parseRetryAfterMs(new Date(now - 60000).toUTCString(), now)).toBe(0);
});
it("serializes one host across users, spaces starts, and permits independent hosts", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const starts: number[] = [];
    let release!: () => void;
    const first = withPoliteHost("https://spacing.example/a", async () => { starts.push(Date.now()); await new Promise<void>(resolve => { release = resolve; }); });
    await vi.advanceTimersByTimeAsync(0);
    const second = withPoliteHost("https://spacing.example/b", async () => { starts.push(Date.now()); });
    const other = vi.fn();
    await withPoliteHost("https://other.example/a", async () => { other(); });
    await vi.advanceTimersByTimeAsync(500);
    expect(starts).toHaveLength(1);
    release(); await first;
    await vi.advanceTimersByTimeAsync(1499);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(2000);
    expect(other).toHaveBeenCalledOnce();
});
it("a queued request rechecks backoff after a 503 with Retry-After", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const first = withPoliteHost("https://retry.example/a", async () => { throw new HttpStatusError(503, "busy", 3600000); });
    const check = expect(first).rejects.toBeInstanceOf(HostDeferredError);
    await vi.advanceTimersByTimeAsync(0); await check;
    const fetch = vi.fn();
    await expect(withPoliteHost("https://retry.example/b", fetch)).rejects.toMatchObject({ waitMs: 3600000 });
    expect(fetch).not.toHaveBeenCalled();
});
