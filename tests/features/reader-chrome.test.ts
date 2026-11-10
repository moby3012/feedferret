import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POSITION_TTL_MS, readReaderPosition, resetReaderPositionCache, saveReaderPosition } from "../../features/reader/reader-position";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  resetReaderPositionCache();
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reader position memory (per article, 24 h)", () => {
  it("remembers a partway position and forgets the top / the end", () => {
    const now = 1_000_000;
    saveReaderPosition("a", 0.42, now);
    expect(readReaderPosition("a", now + 1000)).toBe(0.42);
    saveReaderPosition("a", 0.005, now); // back at the top
    expect(readReaderPosition("a", now)).toBeNull();
    saveReaderPosition("b", 0.99, now); // finished
    expect(readReaderPosition("b", now)).toBeNull();
  });

  it("expires after 24 h", () => {
    const now = 5_000_000;
    saveReaderPosition("a", 0.5, now);
    expect(readReaderPosition("a", now + POSITION_TTL_MS - 1)).toBe(0.5);
    expect(readReaderPosition("a", now + POSITION_TTL_MS)).toBeNull();
  });

  it("survives a reload (storage) and drops expired entries on load", () => {
    const now = 9_000_000;
    saveReaderPosition("fresh", 0.3, now);
    saveReaderPosition("old", 0.6, now - POSITION_TTL_MS - 10);
    resetReaderPositionCache();
    expect(readReaderPosition("fresh", now)).toBe(0.3);
    expect(readReaderPosition("old", now)).toBeNull();
  });

  it("keeps at most 200 articles, dropping the oldest", () => {
    for (let i = 0; i < 205; i++) saveReaderPosition(`a${i}`, 0.5, 10_000 + i);
    resetReaderPositionCache();
    expect(readReaderPosition("a0", 10_300)).toBeNull();
    expect(readReaderPosition("a4", 10_300)).toBeNull();
    expect(readReaderPosition("a5", 10_300)).toBe(0.5);
    expect(readReaderPosition("a204", 10_300)).toBe(0.5);
  });
});

describe("reader typography (Aa sheet)", () => {
  it("unset fields fall back to the per-feed / account prefs, then the tokens", async () => {
    const { resolveTypography, typographyAttrs } = await import("../../features/reader/typography/typography");
    const r = resolveTypography({}, { readerWidth: "wide", readerFontSize: "large" });
    expect(r).toEqual({ font: "sans", width: "wide", theme: "auto", size: null, sizeDelta: 2, leading: null });
    const attrs = typographyAttrs(r) as Record<string, unknown>;
    expect(attrs["data-reader-width"]).toBe("wide");
    expect(attrs["data-reader-theme"]).toBeUndefined();
    expect(attrs.className).toBeUndefined();
    expect(attrs.style).toEqual({ "--reader-size-delta": "2px" });
    expect(resolveTypography({}, { readerWidth: "full" }).width).toBe("full");
    expect(resolveTypography({}, {}).width).toBe("medium");
  });

  it("explicit sheet values win; the dark reader theme is a nested .dark scope", async () => {
    const { resolveTypography, typographyAttrs } = await import("../../features/reader/typography/typography");
    const r = resolveTypography({ font: "serif", width: "narrow", size: 21, leading: 1.8, theme: "dark" }, { readerWidth: "wide", readerFontSize: "xl" });
    const attrs = typographyAttrs(r) as Record<string, unknown>;
    expect(attrs).toMatchObject({ "data-reader-font": "serif", "data-reader-width": "narrow", "data-reader-theme": "dark", className: "dark" });
    expect(attrs.style).toEqual({ "--reader-size-user": "21px", "--reader-leading-user": "1.8" });
  });

  it("persists sanitized values; clearing a field and reset remove them", async () => {
    const t = await import("../../features/reader/typography/typography");
    t.setReaderTypography({ font: "rounded", size: 40, theme: "sepia" });
    expect(t.getReaderTypography()).toEqual({ font: "rounded", size: 24, theme: "sepia" });
    expect(JSON.parse(localStorage.getItem("ff:reader-typography")!)).toEqual({ font: "rounded", size: 24, theme: "sepia" });
    t.setReaderTypography({ theme: undefined, size: 3 });
    expect(t.getReaderTypography()).toEqual({ font: "rounded", size: 15 });
    t.resetReaderTypography();
    expect(t.getReaderTypography()).toEqual({});
    expect(localStorage.getItem("ff:reader-typography")).toBeNull();
  });

  it("ignores garbage in storage", async () => {
    localStorage.setItem("ff:reader-typography", JSON.stringify({ font: "comic", width: 3, leading: 9, theme: "neon", size: "big" }));
    const t = await import("../../features/reader/typography/typography");
    expect(t.getReaderTypography()).toEqual({});
  });
});
