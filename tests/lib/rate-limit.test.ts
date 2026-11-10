import { describe, it, expect, beforeEach, vi } from "vitest";
import { authRateLimitFor, checkRateLimit, RATE_LIMITS, type RateLimitConfig } from "../../lib/rate-limit";

const config: RateLimitConfig = { limit: 3, windowSecs: 60, prefix: "test" };

// Use unique identifiers per test to avoid cross-test state
let counter = 0;
function uid() { return `test-user-${Date.now()}-${++counter}`; }

describe("checkRateLimit", () => {
  it("allows the first request", () => {
    const result = checkRateLimit(uid(), config);
    expect(result.success).toBe(true);
  });

  it("tracks remaining correctly", () => {
    const id = uid();
    checkRateLimit(id, config);
    const r2 = checkRateLimit(id, config);
    expect(r2.remaining).toBe(1);
  });

  it("allows requests up to the limit", () => {
    const id = uid();
    for (let i = 0; i < config.limit; i++) {
      expect(checkRateLimit(id, config).success).toBe(true);
    }
  });

  it("rejects at limit + 1", () => {
    const id = uid();
    for (let i = 0; i < config.limit; i++) checkRateLimit(id, config);
    const over = checkRateLimit(id, config);
    expect(over.success).toBe(false);
    expect(over.remaining).toBe(0);
    expect(typeof over.retryAfterSecs).toBe("number");
  });

  it("different identifiers have independent windows", () => {
    const a = uid(), b = uid();
    for (let i = 0; i < config.limit; i++) checkRateLimit(a, config);
    expect(checkRateLimit(b, config).success).toBe(true);
  });

  it("resets after the window expires", () => {
    vi.useFakeTimers();
    const id = uid();
    for (let i = 0; i < config.limit; i++) checkRateLimit(id, config);
    expect(checkRateLimit(id, config).success).toBe(false);
    vi.advanceTimersByTime((config.windowSecs + 1) * 1000);
    expect(checkRateLimit(id, config).success).toBe(true);
    vi.useRealTimers();
  });

  it("X-RateLimit-Reset and X-RateLimit-Remaining are accurate", () => {
    const id = uid();
    const before = Math.floor(Date.now() / 1000);
    const result = checkRateLimit(id, config);
    const resetSec = Math.floor(result.resetAt / 1000);
    expect(resetSec).toBeGreaterThanOrEqual(before + config.windowSecs - 1);
    expect(result.remaining).toBe(config.limit - 1);
  });
});

describe("auth route limiters", () => {
  it("routes sign-out to its own budget, sign-in and magic links keep theirs", () => {
    expect(authRateLimitFor("/api/auth/signout")).toBe(RATE_LIMITS.authSignOut);
    expect(authRateLimitFor("/api/auth/signout/")).toBe(RATE_LIMITS.authSignOut);
    expect(authRateLimitFor("/api/auth/callback/credentials")).toBe(RATE_LIMITS.authSignIn);
    expect(authRateLimitFor("/api/auth/signin/credentials")).toBe(RATE_LIMITS.authSignIn);
    expect(authRateLimitFor("/api/auth/signin/email")).toBe(RATE_LIMITS.authMagicLink);
    expect(authRateLimitFor("/api/auth/signin/sendverificationrequest")).toBe(RATE_LIMITS.authMagicLink);
  });

  it("an exhausted sign-in budget never refuses a sign-out (regression: a refused sign-out left the session alive)", () => {
    const id = uid();
    const signIn = authRateLimitFor("/api/auth/callback/credentials");
    for (let i = 0; i < signIn.limit; i++) expect(checkRateLimit(id, signIn).success).toBe(true);
    expect(checkRateLimit(id, signIn).success).toBe(false);
    const signOut = authRateLimitFor("/api/auth/signout");
    expect(signOut.prefix).not.toBe(signIn.prefix);
    expect(checkRateLimit(id, signOut).success).toBe(true);
    // …and sign-outs do not eat the sign-in budget either.
    const other = uid();
    for (let i = 0; i < signIn.limit; i++) checkRateLimit(other, signOut);
    expect(checkRateLimit(other, signIn).remaining).toBe(signIn.limit - 1);
  });
});
