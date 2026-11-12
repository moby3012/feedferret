import { afterEach, describe, expect, it, vi } from "vitest";
import { adaptiveInterval, dueFeedWhere, publicationCadence, deferredSyncAt } from "../../lib/adaptive-refresh";
import { HostDeferredError, resetHostBackoff, withPoliteHost, recordHostFailure, hostBackoffRemainingMs } from "../../lib/host-backoff";
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
    it("learns three-minute publication cadence instead of collapsing the whole feed", () => {
        expect(publicationCadence(Array.from({ length: 20 }, (_, i) => item(i * 3)), now)).toBe(3);
        expect(adaptiveInterval([], 5, 60, now)).toBe(5);
        expect(adaptiveInterval([], 10, 60, now)).toBe(10);
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
it("defers busy and spaced hosts immediately without parking a worker", async () => {
    vi.stubEnv("FEED_HOST_SPACING_MS", "2000");
    vi.useFakeTimers(); vi.setSystemTime(now);
    let release!: () => void;
    const task = vi.fn();
    const first = withPoliteHost("https://spacing.example/a", async () => { await new Promise<void>(resolve => { release = resolve; }); });
    await expect(withPoliteHost("https://spacing.example/b", task)).rejects.toMatchObject({ reason: "host_busy" });
    const other = vi.fn();
    await withPoliteHost("https://other.example/a", async () => { other(); });
    release(); await first;
    await vi.advanceTimersByTimeAsync(1999);
    await expect(withPoliteHost("https://spacing.example/c", task)).rejects.toBeInstanceOf(HostDeferredError);
    await vi.advanceTimersByTimeAsync(1);
    await withPoliteHost("https://spacing.example/d", async () => { task(); });
    expect(task).toHaveBeenCalledOnce();
    expect(other).toHaveBeenCalledOnce();
});
it("with spacing disabled, a busy host still asks for a short retry floor instead of a spin", async () => {
    vi.stubEnv("FEED_HOST_SPACING_MS", "0");
    let release!: () => void;
    const first = withPoliteHost("https://nospacing.example/a", async () => { await new Promise<void>(resolve => { release = resolve; }); });
    await expect(withPoliteHost("https://nospacing.example/b", async () => "x")).rejects.toMatchObject({ reason: "host_busy", waitMs: 250 });
    release(); await first;
    await expect(withPoliteHost("https://nospacing.example/c", async () => "ok")).resolves.toBe("ok");
});
it("does not let a full-text 403 backoff block feed fetches", async () => {
    recordHostFailure("https://pages.example/article", new HttpStatusError(403, "denied"));
    expect(hostBackoffRemainingMs("https://pages.example/feed")).toBeGreaterThan(0);
    const task = vi.fn(async () => "ok");
    await expect(withPoliteHost("https://pages.example/feed", task)).resolves.toBe("ok");
});
it("does not propagate one feed's 403 to another feed on its host", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    await expect(withPoliteHost("https://private.example/private", async () => { throw new HttpStatusError(403, "denied"); })).rejects.toMatchObject({ status: 403 });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(withPoliteHost("https://private.example/public", async () => "ok")).resolves.toBe("ok");
});
it("caps persisted deferrals at the configured refresh ceiling", () => {
    expect(deferredSyncAt(7 * 86400000, now).getTime()).toBe(now + 86400000);
});
it("a later request honours backoff after a 503 with Retry-After", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const first = withPoliteHost("https://retry.example/a", async () => { throw new HttpStatusError(503, "busy", 3600000); });
    const check = expect(first).rejects.toBeInstanceOf(HostDeferredError);
    await vi.advanceTimersByTimeAsync(0); await check;
    const fetch = vi.fn();
    await expect(withPoliteHost("https://retry.example/b", fetch)).rejects.toMatchObject({ waitMs: 3600000 });
    expect(fetch).not.toHaveBeenCalled();
});

it("a successful probe resets expired host failures, preserving a live quota", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const url = "https://reset.example/feed";
    await expect(withPoliteHost(url, async () => { throw new HttpStatusError(503, "busy"); })).rejects.toBeInstanceOf(HostDeferredError);
    await vi.advanceTimersByTimeAsync(120000);
    await withPoliteHost(url, async () => "ok");
    await vi.advanceTimersByTimeAsync(2000);
    await expect(withPoliteHost(url, async () => { throw new HttpStatusError(503, "busy"); })).rejects.toMatchObject({ waitMs: 120000 });
});
it("a plain full-text 503 does not create a feed/discovery rate-limit window", async () => {
    const url = "https://page503.example/article";
    recordHostFailure(url, new HttpStatusError(503, "busy"));
    await expect(withPoliteHost("https://page503.example/feed", async () => "ok")).resolves.toBe("ok");
});
