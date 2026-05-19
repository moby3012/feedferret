import { describe, it, expect, beforeEach, vi } from "vitest";
import { checkRateLimit, type RateLimitConfig } from "../../lib/rate-limit";

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
