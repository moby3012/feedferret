// Limiter stores are isolated per limiter and the credential-guessing ones evict fail-safe: a flood of
// distinct keys against any limiter must never reset the sign-in lockout. See lib/rate-limit.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkRateLimit, consumeRateLimit, MAX_STORE_ENTRIES, peekRateLimit, rateLimitStoreSize, RATE_LIMITS,
  resetProxyCountWarning, getClientIdentifier, type RateLimitConfig,
} from "../../lib/rate-limit";

const signIn = RATE_LIMITS.authSignIn;
const FLOOD = 100_000;

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function lock(identifier: string, config: RateLimitConfig = signIn) {
  for (let i = 0; i < config.limit; i++) expect(checkRateLimit(identifier, config).success).toBe(true);
  expect(checkRateLimit(identifier, config).success).toBe(false);
}

describe("per-limiter stores", () => {
  it("a 100k-key flood of another limiter cannot evict a sign-in lockout", () => {
    lock("ip:victim-a");
    for (let i = 0; i < FLOOD; i++) checkRateLimit(`ip:flood-${i}`, RATE_LIMITS.mcp);
    for (let i = 0; i < FLOOD; i++) checkRateLimit(`ip:flood-${i}`, { prefix: "csp-report", limit: 30, windowSecs: 60 });
    expect(checkRateLimit("ip:victim-a", signIn).success).toBe(false);
    expect(rateLimitStoreSize(RATE_LIMITS.mcp.prefix)).toBeLessThanOrEqual(MAX_STORE_ENTRIES);
  });

  it("ordinary limiters stay capped (oldest-first eviction)", () => {
    const cfg: RateLimitConfig = { prefix: "iso-ordinary", limit: 5, windowSecs: 60 };
    for (let i = 0; i < MAX_STORE_ENTRIES + 5_000; i++) checkRateLimit(`k${i}`, cfg);
    expect(rateLimitStoreSize(cfg.prefix)).toBeLessThanOrEqual(MAX_STORE_ENTRIES);
    expect(rateLimitStoreSize(cfg.prefix)).toBeGreaterThan(MAX_STORE_ENTRIES - 1_000);
    // the newest key is tracked, the oldest was dropped
    expect(peekRateLimit(`k${MAX_STORE_ENTRIES + 4_999}`, cfg).remaining).toBe(4);
    expect(peekRateLimit("k0", cfg).remaining).toBe(5);
  });

  it("limiters sharing no prefix do not share keys", () => {
    lock("ip:shared-key");
    expect(checkRateLimit("ip:shared-key", RATE_LIMITS.authMagicLink).success).toBe(true);
  });
});

describe("fail-safe eviction of critical limiters", () => {
  it("a flood of one-shot keys against the SAME limiter keeps lockouts and near-lockouts", () => {
    lock("ip:victim-b");
    for (let i = 0; i < signIn.limit - 1; i++) checkRateLimit("ip:partial", signIn); // 9 of 10 spent
    for (let i = 0; i < FLOOD; i++) checkRateLimit(`ip:spoof-${i}`, signIn);
    expect(checkRateLimit("ip:victim-b", signIn).success).toBe(false);
    expect(peekRateLimit("ip:partial", signIn).remaining).toBe(1);
    expect(rateLimitStoreSize(signIn.prefix)).toBeLessThanOrEqual(MAX_STORE_ENTRIES);
  });

  it("when every entry is an active lockout, new keys are refused and lockouts stay", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const cfg: RateLimitConfig = { prefix: "iso-saturated", limit: 2, windowSecs: 60, critical: true };
    for (let i = 0; i < MAX_STORE_ENTRIES; i++) { checkRateLimit(`k${i}`, cfg); checkRateLimit(`k${i}`, cfg); checkRateLimit(`k${i}`, cfg); }
    expect(rateLimitStoreSize(cfg.prefix)).toBe(MAX_STORE_ENTRIES);
    const refused = checkRateLimit("brand-new", cfg);
    expect(refused.success).toBe(false);
    expect(refused.retryAfterSecs).toBeGreaterThan(0);
    expect(rateLimitStoreSize(cfg.prefix)).toBe(MAX_STORE_ENTRIES);
    expect(checkRateLimit("k0", cfg).success).toBe(false); // existing lockout intact
    consumeRateLimit("another-new", cfg, 5); // accounting must not evict a lockout either
    expect(rateLimitStoreSize(cfg.prefix)).toBe(MAX_STORE_ENTRIES);
    // recovers once the lockouts expire
    vi.advanceTimersByTime(61_000);
    expect(checkRateLimit("brand-new", cfg).success).toBe(true);
  });

  it("evicts expired entries before anything else", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const cfg: RateLimitConfig = { prefix: "iso-expiry", limit: 2, windowSecs: 60, critical: true };
    for (let i = 0; i < MAX_STORE_ENTRIES; i++) checkRateLimit(`old${i}`, cfg);
    vi.advanceTimersByTime(61_000);
    lock("fresh-locked", cfg);
    expect(checkRateLimit("fresh-locked", cfg).success).toBe(false);
    expect(rateLimitStoreSize(cfg.prefix)).toBeLessThan(MAX_STORE_ENTRIES);
  });

  it.each([["sign-in", signIn], ["magic link", RATE_LIMITS.authMagicLink]])("%s: a store full of active lockouts evicts the OLDEST one instead of refusing every new IP", (_name, cfg) => {
    const c = { ...cfg, prefix: `iso-evict-${cfg.prefix}` }; // own store, same policy
    for (let i = 0; i < MAX_STORE_ENTRIES; i++) for (let n = 0; n <= c.limit; n++) checkRateLimit(`ip:locked-${i}`, c);
    expect(rateLimitStoreSize(c.prefix)).toBe(MAX_STORE_ENTRIES);
    expect(checkRateLimit("ip:newcomer", c).success).toBe(true); // not denied
    expect(rateLimitStoreSize(c.prefix)).toBeLessThanOrEqual(MAX_STORE_ENTRIES);
    expect(checkRateLimit(`ip:locked-${MAX_STORE_ENTRIES - 1}`, c).success).toBe(false); // newest lockouts stay
    expect(peekRateLimit("ip:locked-0", c).success).toBe(true); // the oldest was the one dropped
  });

  it("the same refuse-when-full policy stays on limiters without a backstop (internal API key)", () => {
    expect(RATE_LIMITS.internalApi.critical).toBe(true);
    expect((RATE_LIMITS.internalApi as RateLimitConfig).overflow).toBeUndefined();
    expect((RATE_LIMITS.authSignIn as RateLimitConfig).overflow).toBe("evict-oldest");
    expect((RATE_LIMITS.authMagicLink as RateLimitConfig).overflow).toBe("evict-oldest");
  });

  it("an IPv6 /64 cannot mint limiter keys: 5 000 addresses of one prefix are one entry", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
    const cfg: RateLimitConfig = { ...signIn, prefix: "iso-v6" };
    for (let i = 0; i < 5_000; i++) {
      checkRateLimit(getClientIdentifier(new Request("https://example.test", { headers: { "x-forwarded-for": `2001:db8:abcd:1234:${i.toString(16)}::${i.toString(16)}` } })), cfg);
    }
    expect(rateLimitStoreSize(cfg.prefix)).toBe(1);
  });

  it("derived limiters (GReader/Fever/credentials-status) are critical in their own store", () => {
    const greader = { ...signIn, prefix: "iso-greader-ip" };
    lock("ip:victim-c", greader);
    for (let i = 0; i < FLOOD; i++) checkRateLimit(`email-${i}`, greader);
    expect(checkRateLimit("ip:victim-c", greader).success).toBe(false);
  });
});

describe("X-Forwarded-For without TRUSTED_PROXY_COUNT", () => {
  const request = () => new Request("https://example.test", { headers: { "x-forwarded-for": "1.2.3.4" } });
  it.each([undefined, "", "garbage"])("warns once when it is %s", (value) => {
    resetProxyCountWarning();
    if (value === undefined) vi.stubEnv("TRUSTED_PROXY_COUNT", undefined as never); else vi.stubEnv("TRUSTED_PROXY_COUNT", value);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getClientIdentifier(request())).toBe("ip:1.2.3.4");
    getClientIdentifier(request());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("TRUSTED_PROXY_COUNT");
  });
  it("is silent when configured, and without the header", () => {
    resetProxyCountWarning();
    vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getClientIdentifier(request());
    vi.stubEnv("TRUSTED_PROXY_COUNT", "");
    getClientIdentifier(new Request("https://example.test", { headers: { "x-real-ip": "5.6.7.8" } }));
    expect(warn).not.toHaveBeenCalled();
  });
});
