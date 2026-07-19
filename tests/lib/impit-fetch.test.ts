import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { wrapFetchErrors } from "../../lib/impit-fetch";

// The module memoises its engine, so re-import fresh per test via vi.resetModules.
async function loadFresh() {
  vi.resetModules();
  return await import("../../lib/impit-fetch");
}

describe("getImpitFetch", () => {
  const original = process.env.FEEDFERRET_DISABLE_IMPIT;

  beforeEach(() => {
    delete process.env.FEEDFERRET_DISABLE_IMPIT;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.FEEDFERRET_DISABLE_IMPIT;
    else process.env.FEEDFERRET_DISABLE_IMPIT = original;
    vi.restoreAllMocks();
  });

  it("returns null (native-fetch fallback) when disabled via env", async () => {
    process.env.FEEDFERRET_DISABLE_IMPIT = "1";
    const { getImpitFetch } = await loadFresh();
    expect(getImpitFetch()).toBeNull();
  });

  it("returns a callable engine (or null) and memoises the result", async () => {
    const { getImpitFetch } = await loadFresh();
    const first = getImpitFetch();
    const second = getImpitFetch();
    // Either a function (native binary loaded) or null (unavailable) — never throws.
    expect(first === null || typeof first === "function").toBe(true);
    expect(second).toBe(first);
  });
});

// ── native-rejection normalization (wrapFetchErrors) ─────────────────────────
//
// impit's Rust core rejects with a native napi error object (e.g. a
// reqwest/hyper HTTP2 stream reset when a site's anti-bot layer kills the
// connection mid-request) — not a plain JS `Error`. Regression for a
// production crash: that native rejection propagated uncaught through a
// Server Action ("An error occurred in the Server Components render")
// instead of surfacing as a normal, catchable fetch failure. Tested directly
// against the exported wrapper rather than mocking the native `impit` module,
// which resists interception since it's loaded via a runtime `require()` call.
describe("wrapFetchErrors", () => {
  it("wraps a native (non-Error) rejection into a plain Error with a short, clean message", async () => {
    // Simulates the real crash: reqwest/hyper's native error object isn't a
    // JS Error instance and carries a huge multi-line Rust debug dump.
    const nativeRejection = {
      message: 'reqwest::Error {\n    kind: Request,\n    url: "https://www.formel1.de/nc/148166",\n}',
    };
    const wrapped = wrapFetchErrors(async () => {
      throw nativeRejection;
    });

    await expect(wrapped("https://example.com/", {})).rejects.toThrow(Error);
    await expect(wrapped("https://example.com/", {})).rejects.toThrow(/impit fetch failed: reqwest::Error/);
    // The multi-line native debug dump must not leak through wholesale.
    await wrapped("https://example.com/", {}).catch((err: Error) => {
      expect(err.message.includes("\n")).toBe(false);
      expect(err.message.length).toBeLessThan(250);
    });
  });

  it("also normalizes a genuine Error rejection (message preserved, still a clean Error)", async () => {
    const wrapped = wrapFetchErrors(async () => {
      throw new Error("connection reset");
    });
    await expect(wrapped("https://example.com/", {})).rejects.toThrow(/impit fetch failed: connection reset/);
  });

  it("resolves normally when the wrapped fetch succeeds", async () => {
    const fakeResponse = { status: 200, ok: true } as never;
    const wrapped = wrapFetchErrors(async () => fakeResponse);
    await expect(wrapped("https://example.com/", {})).resolves.toBe(fakeResponse);
  });
});
