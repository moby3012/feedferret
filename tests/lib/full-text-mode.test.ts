import { describe, it, expect } from "vitest";
import { resolveFullTextMode } from "../../lib/full-text-mode";

describe("resolveFullTextMode", () => {
  it("returns 'auto' when fullTextMode is explicitly 'auto', regardless of the legacy flag", () => {
    expect(resolveFullTextMode({ fullTextMode: "auto", autoFetchFullText: false })).toBe("auto");
    expect(resolveFullTextMode({ fullTextMode: "auto", autoFetchFullText: true })).toBe("auto");
  });

  it("returns 'selector' when fullTextMode is explicitly 'selector', regardless of the legacy flag", () => {
    expect(resolveFullTextMode({ fullTextMode: "selector", autoFetchFullText: false })).toBe("selector");
    expect(resolveFullTextMode({ fullTextMode: "selector", autoFetchFullText: true })).toBe("selector");
  });

  it("falls back to 'selector' when fullTextMode is 'off' (the default) but the legacy boolean is true", () => {
    // This is the critical back-compat case: every pre-existing feed row gets
    // fullTextMode = "off" by default migration, so it must not silently
    // disable full-text for feeds that already had autoFetchFullText = true.
    expect(resolveFullTextMode({ fullTextMode: "off", autoFetchFullText: true })).toBe("selector");
  });

  it("returns 'off' when fullTextMode is 'off' and the legacy boolean is false", () => {
    expect(resolveFullTextMode({ fullTextMode: "off", autoFetchFullText: false })).toBe("off");
  });

  it("falls back to the legacy boolean when fullTextMode is null/undefined", () => {
    expect(resolveFullTextMode({ fullTextMode: null, autoFetchFullText: true })).toBe("selector");
    expect(resolveFullTextMode({ fullTextMode: undefined, autoFetchFullText: true })).toBe("selector");
    expect(resolveFullTextMode({ fullTextMode: null, autoFetchFullText: false })).toBe("off");
    expect(resolveFullTextMode({ fullTextMode: undefined, autoFetchFullText: false })).toBe("off");
  });

  it("returns 'off' when neither field is set at all", () => {
    expect(resolveFullTextMode({})).toBe("off");
  });

  it("treats an unrecognized fullTextMode value as unset and falls back to the legacy boolean", () => {
    expect(resolveFullTextMode({ fullTextMode: "bogus", autoFetchFullText: true })).toBe("selector");
    expect(resolveFullTextMode({ fullTextMode: "bogus", autoFetchFullText: false })).toBe("off");
  });

  it("treats autoFetchFullText: null the same as false", () => {
    expect(resolveFullTextMode({ fullTextMode: "off", autoFetchFullText: null })).toBe("off");
    expect(resolveFullTextMode({ fullTextMode: undefined, autoFetchFullText: null })).toBe("off");
  });
});
