import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
