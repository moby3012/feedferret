import { beforeEach, describe, expect, it } from "vitest";
import {
  classifyFetchFailure,
  hostBackoffRemainingMs,
  recordHostFailure,
  recordHostSuccess,
  resetHostBackoff,
} from "@/lib/host-backoff";
import { HttpStatusError, parseRetryAfterMs } from "@/lib/ssrf";

const URL_A = "https://slow.example/a/1";
const URL_A2 = "https://slow.example/b/2";

describe("host backoff", () => {
  beforeEach(() => resetHostBackoff());

  it("classifies statuses generically", () => {
    expect(classifyFetchFailure(new HttpStatusError(429, "Fetch failed: 429", 30_000))).toEqual({ kind: "rate_limited", status: 429, retryAfterMs: 30_000 });
    expect(classifyFetchFailure(new HttpStatusError(403, "Fetch failed: 403")).kind).toBe("blocked");
    expect(classifyFetchFailure(new HttpStatusError(503, "Fetch failed: 503")).kind).toBe("blocked");
    expect(classifyFetchFailure(new HttpStatusError(404, "Fetch failed: 404")).kind).toBe("permanent");
    expect(classifyFetchFailure(new Error("Fetch failed: 402")).kind).toBe("blocked"); // legacy message shape
    expect(classifyFetchFailure(new Error("Full-text hostname resolves to a private IP")).kind).toBe("permanent");
    expect(classifyFetchFailure(new Error("The operation was aborted due to timeout")).kind).toBe("network");
  });

  it("backs a host off after a 429, honouring Retry-After, for every URL on that host", () => {
    const now = 1_000_000;
    const wait = recordHostFailure(URL_A, new HttpStatusError(429, "Fetch failed: 429", 2 * 60 * 60 * 1000), now);
    expect(wait).toBe(2 * 60 * 60 * 1000);
    expect(hostBackoffRemainingMs(URL_A2, now + 1000)).toBeGreaterThan(0);
    expect(hostBackoffRemainingMs("https://other.example/x", now)).toBe(0);
  });

  it("honours a Retry-After longer than the local cap, sanity-capped at 7 days", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(recordHostFailure(URL_A, new HttpStatusError(429, "Fetch failed: 429", 2 * day), 0)).toBe(2 * day);
    expect(hostBackoffRemainingMs(URL_A, day)).toBe(day);
    resetHostBackoff();
    expect(recordHostFailure(URL_A, new HttpStatusError(503, "Fetch failed: 503", 30 * day), 0)).toBe(7 * day);
  });

  it("grows exponentially per consecutive failure and is capped", () => {
    const now = 0;
    const first = recordHostFailure(URL_A, new HttpStatusError(403, "Fetch failed: 403"), now);
    const second = recordHostFailure(URL_A, new HttpStatusError(403, "Fetch failed: 403"), now);
    expect(second).toBe(first * 2);
    let last = 0;
    for (let i = 0; i < 20; i++) last = recordHostFailure(URL_A, new HttpStatusError(403, "Fetch failed: 403"), now);
    expect(last).toBe(6 * 60 * 60 * 1000);
  });

  it("never backs off for permanent failures and clears on success", () => {
    expect(recordHostFailure(URL_A, new HttpStatusError(404, "Fetch failed: 404"))).toBe(0);
    expect(hostBackoffRemainingMs(URL_A)).toBe(0);
    recordHostFailure(URL_A, new HttpStatusError(503, "Fetch failed: 503"));
    expect(hostBackoffRemainingMs(URL_A)).toBeGreaterThan(0);
    recordHostSuccess(URL_A2);
    expect(hostBackoffRemainingMs(URL_A)).toBe(0);
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfterMs("120")).toBe(120_000);
    expect(parseRetryAfterMs("Wed, 21 Oct 2015 07:28:10 GMT", Date.parse("Wed, 21 Oct 2015 07:28:00 GMT"))).toBe(10_000);
    expect(parseRetryAfterMs("soon")).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
  });
});
