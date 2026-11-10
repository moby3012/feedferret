import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetOfflineSessionForTests, revokeOfflineScope, setOfflineUser } from "../../features/offline/session";
import {
  clearReaderPositions,
  POSITION_TTL_MS,
  readReaderPosition,
  resetReaderPositionCache,
  saveReaderPosition,
} from "../../features/reader/reader-position";

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

/** `document.cookie` semantics: the setter writes one cookie (max-age=0 deletes), the getter lists them. */
function cookieDocument() {
  const jar = new Map<string, string>();
  return {
    jar,
    visibilityState: "visible",
    addEventListener() {},
    removeEventListener() {},
    get cookie() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    set cookie(raw: string) {
      const [pair, ...attrs] = raw.split("; ");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      if (attrs.some((a) => a === "max-age=0")) jar.delete(name);
      else jar.set(name, pair.slice(eq + 1));
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("document", cookieDocument());
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  resetReaderPositionCache();
  resetOfflineSessionForTests();
  setOfflineUser("u1");
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

describe("reader position memory is account data", () => {
  it("is stored per user: another account on the device sees none of it", () => {
    const now = 2_000_000;
    saveReaderPosition("a", 0.4, now);
    expect(localStorage.getItem("ff:reader-pos")).toBeNull();
    expect(JSON.parse(localStorage.getItem("ff:reader-pos:u1")!)).toEqual({ a: { r: 0.4, t: now } });
    resetOfflineSessionForTests();
    setOfflineUser("u2");
    expect(readReaderPosition("a", now)).toBeNull(); // the module cache is per user too
    saveReaderPosition("a", 0.7, now);
    expect(readReaderPosition("a", now)).toBe(0.7);
    expect(readReaderPosition("a", now, "u1")).toBe(0.4);
  });

  it("without a known user (revoked / signed out) nothing is read or written", () => {
    const now = 3_000_000;
    saveReaderPosition("a", 0.4, now);
    revokeOfflineScope();
    expect(readReaderPosition("a", now)).toBeNull();
    saveReaderPosition("b", 0.5, now);
    expect(localStorage.length).toBe(1);
  });

  it("clearReaderPositions drops storage and memory of every account (logout)", () => {
    const now = 4_000_000;
    saveReaderPosition("a", 0.4, now);
    saveReaderPosition("b", 0.5, now, "u2");
    localStorage.setItem("ff:reader-pos", "{}");
    localStorage.setItem("ff:offline-other-device-pref", "1");
    clearReaderPositions();
    expect(readReaderPosition("a", now)).toBeNull(); // memory gone, not only storage
    expect(localStorage.getItem("ff:reader-pos:u1")).toBeNull();
    expect(localStorage.getItem("ff:reader-pos:u2")).toBeNull();
    expect(localStorage.getItem("ff:reader-pos")).toBeNull();
    expect(localStorage.getItem("ff:offline-other-device-pref")).toBe("1"); // nothing else is touched
  });

  it("an account switch keeps only the new account's positions", () => {
    const now = 5_000_000;
    saveReaderPosition("a", 0.4, now);
    saveReaderPosition("b", 0.5, now, "u2");
    clearReaderPositions("u1");
    expect(readReaderPosition("a", now)).toBe(0.4);
    expect(localStorage.getItem("ff:reader-pos:u2")).toBeNull();
  });

  it("logout's clearAccountBrowserData clears them", async () => {
    vi.doMock("next-auth/react", () => ({ signOut: vi.fn() }));
    const now = 6_000_000;
    saveReaderPosition("a", 0.4, now);
    const positions = await import("../../features/reader/reader-position");
    const { clearAccountBrowserData } = await import("../../lib/logout");
    await clearAccountBrowserData();
    expect(localStorage.getItem("ff:reader-pos:u1")).toBeNull();
    expect(positions.readReaderPosition("a", now, "u1")).toBeNull();
    vi.doUnmock("next-auth/react");
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

  it("persists sanitized values in the ff_ui cookie (server-readable); clearing a field and reset remove them", async () => {
    const t = await import("../../features/reader/typography/typography");
    const { parseUiCookie, UI_COOKIE, writeUiPrefs } = await import("../../features/reader/layout/ui-prefs");
    const ui = () => parseUiCookie((document as unknown as { jar: Map<string, string> }).jar.get(UI_COOKIE));
    writeUiPrefs({ listW: 400, bc: 1 });
    t.setReaderTypography({ font: "rounded", size: 40, theme: "sepia" });
    expect(t.getReaderTypography()).toEqual({ font: "rounded", size: 24, theme: "sepia" });
    expect(ui()).toEqual({ listW: 400, bc: 1, rt: { font: "rounded", size: 24, theme: "sepia" } }); // other prefs kept
    t.setReaderTypography({ theme: undefined, size: 3 });
    expect(t.getReaderTypography()).toEqual({ font: "rounded", size: 15 });
    t.resetReaderTypography();
    expect(t.getReaderTypography()).toEqual({});
    expect(ui()).toEqual({ listW: 400, bc: 1 });
    expect(localStorage.length).toBe(0);
  });

  it("a fresh page reads the cookie; garbage in it is ignored", async () => {
    const { serializeUiCookie, UI_COOKIE } = await import("../../features/reader/layout/ui-prefs");
    document.cookie = `${UI_COOKIE}=${serializeUiCookie({ rt: { font: "serif", width: "full", leading: 1.8 } })}; path=/`;
    const t = await import("../../features/reader/typography/typography");
    expect(t.getReaderTypography()).toEqual({ font: "serif", width: "full", leading: 1.8 });
    t.resetReaderTypographyCache();
    document.cookie = `${UI_COOKIE}=${encodeURIComponent(JSON.stringify({ rt: { font: "comic", width: 3, leading: 9, theme: "neon", size: "big" } }))}; path=/`;
    expect(t.getReaderTypography()).toEqual({});
  });

  it("the server parses rt from ff_ui with the same sanitizer", async () => {
    const { parseUiCookie, serializeUiCookie } = await import("../../features/reader/layout/ui-prefs");
    expect(parseUiCookie(serializeUiCookie({ rt: { font: "serif", size: 99, theme: "auto" as never } }))).toEqual({ rt: { font: "serif", size: 24 } });
    expect(parseUiCookie(encodeURIComponent(JSON.stringify({ rt: "x", listW: 400 })))).toEqual({ listW: 400 });
  });
});
