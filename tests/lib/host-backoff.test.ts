import { beforeEach, describe, expect, it } from "vitest";
import {
  classifyFetchFailure,
  hostBackoffRemainingMs,
  hostRateLimitRemainingMs,
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

describe("normalizeLinkForComparison", () => {
  it("treats scheme, host case, www, fragment, trailing slash and tracking/session params as cosmetic", async () => {
    const { normalizeLinkForComparison: n } = await import("@/lib/content-hash");
    const base = n("https://news.example/story/42?id=7");
    for (const variant of [
      "http://News.Example/story/42/?id=7#comments",
      "https://www.news.example/story/42?utm_source=rss&utm_medium=feed&id=7",
      "https://news.example/story/42?id=7&fbclid=abc&gclid=x&ref=home&sessionid=s1&_hsenc=q",
      "https://news.example/story/42?utm_campaign=rotating-2&id=7&PHPSESSID=zz",
    ]) {
      expect(n(variant), variant).toBe(base);
    }
    expect(n("https://news.example/story/43?id=7")).not.toBe(base);
    expect(n("https://news.example/story/42?id=8")).not.toBe(base);
  });
});

describe("hostRateLimitRemainingMs (interactive callers)", () => {
  beforeEach(() => resetHostBackoff());

  it("counts only windows the server asked for: 429, or any status with Retry-After", () => {
    const now = 1_000_000;
    recordHostFailure("https://a.example/x", new HttpStatusError(429, "Fetch failed: 429", null), now);
    expect(hostRateLimitRemainingMs("https://a.example/y", now)).toBeGreaterThan(0);
    recordHostFailure("https://b.example/x", new HttpStatusError(503, "Fetch failed: 503", 60_000), now);
    expect(hostRateLimitRemainingMs("https://b.example/y", now)).toBe(120_000);
  });

  it("ignores our own guesses for 403 / 5xx / network failures (still deferred for full text)", () => {
    const now = 1_000_000;
    recordHostFailure("https://c.example/x", new HttpStatusError(403, "Fetch failed: 403"), now);
    recordHostFailure("https://d.example/x", new Error("socket hang up"), now);
    expect(hostRateLimitRemainingMs("https://c.example/y", now)).toBe(0);
    expect(hostRateLimitRemainingMs("https://d.example/y", now)).toBe(0);
    expect(hostBackoffRemainingMs("https://c.example/y", now)).toBeGreaterThan(0);
  });
});
