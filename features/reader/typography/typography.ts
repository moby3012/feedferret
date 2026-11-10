"use client";

// Reader typography ("Aa" sheet, .pm/research-reeder.md §4.3): font style,
// measure, size, leading and a reader theme that is independent of the app
// theme. Device-local (localStorage `ff:reader-typography`): typography is a
// per-screen choice, like the app theme. Every field is optional; an unset
// field falls back to the per-feed override, then the account preference
// (Settings → reader width / font size), then the design tokens.
//
// The values reach the page only as data attributes + CSS custom properties on
// the reader root (app/styles/reader.css), so a change repaints without
// re-rendering the article.
import { useSyncExternalStore } from "react";

export const READER_FONTS = ["sans", "serif", "rounded"] as const;
export const READER_WIDTHS = ["narrow", "medium", "wide"] as const;
export const READER_THEMES = ["auto", "light", "dark", "sepia"] as const;
export const READER_LEADINGS = [1.45, 1.6, 1.8] as const;
export const READER_SIZE_MIN = 15;
export const READER_SIZE_MAX = 24;

export type ReaderFont = (typeof READER_FONTS)[number];
export type ReaderWidth = (typeof READER_WIDTHS)[number];
export type ReaderTheme = (typeof READER_THEMES)[number];

export interface ReaderTypography {
  font?: ReaderFont;
  width?: ReaderWidth;
  /** Body size in px (15–24). */
  size?: number;
  leading?: number;
  theme?: ReaderTheme;
}

/** Account / per-feed preferences the sheet's unset fields fall back to. */
export interface ReaderAccountPrefs {
  readerWidth?: string | null;
  readerFontSize?: string | null;
}

const STORAGE_KEY = "ff:reader-typography";
const EMPTY: ReaderTypography = Object.freeze({}) as ReaderTypography;

let current: ReaderTypography | null = null;
const listeners = new Set<() => void>();

function sanitize(raw: unknown): ReaderTypography {
  if (!raw || typeof raw !== "object") return EMPTY;
  const r = raw as Record<string, unknown>;
  const out: ReaderTypography = {};
  if (READER_FONTS.includes(r.font as ReaderFont)) out.font = r.font as ReaderFont;
  if (READER_WIDTHS.includes(r.width as ReaderWidth)) out.width = r.width as ReaderWidth;
  if (READER_THEMES.includes(r.theme as ReaderTheme) && r.theme !== "auto") out.theme = r.theme as ReaderTheme;
  if (typeof r.size === "number" && Number.isFinite(r.size)) out.size = clampSize(r.size);
  if (typeof r.leading === "number" && READER_LEADINGS.includes(r.leading as (typeof READER_LEADINGS)[number])) out.leading = r.leading;
  return out;
}

export function clampSize(px: number): number {
  return Math.min(READER_SIZE_MAX, Math.max(READER_SIZE_MIN, Math.round(px)));
}

function read(): ReaderTypography {
  try {
    return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return EMPTY;
  }
}

export function getReaderTypography(): ReaderTypography {
  if (typeof window === "undefined") return EMPTY;
  if (!current) current = read();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    current = read();
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function commit(next: ReaderTypography) {
  current = sanitize(next);
  try {
    if (Object.keys(current).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* private mode / quota: the choice still applies for this page */
  }
  listeners.forEach((l) => l());
}

/** Merges `patch`; `undefined` (or theme "auto") clears a field back to its fallback. */
export function setReaderTypography(patch: Partial<ReaderTypography>) {
  const next: ReaderTypography = { ...getReaderTypography(), ...patch };
  for (const key of Object.keys(next) as (keyof ReaderTypography)[]) if (next[key] === undefined) delete next[key];
  commit(next);
}

export function resetReaderTypography() {
  commit({});
}

/** Server snapshot = nothing chosen (the SSR'd deep-link reader matches the first client render). */
const serverSnapshot = () => EMPTY;

export function useReaderTypography(): ReaderTypography {
  return useSyncExternalStore(subscribe, getReaderTypography, serverSnapshot);
}

// ------------------------------------------------------------ resolution

/** Account font size names → px delta on the token default (17 compact / 19 wide). */
const SIZE_DELTA: Record<string, number> = { small: -2, medium: 0, large: 2, xl: 4 };
/** Account width names → measure. */
const ACCOUNT_WIDTH: Record<string, ReaderWidth | "full"> = { normal: "medium", wide: "wide", full: "full" };

export interface ResolvedTypography {
  font: ReaderFont;
  width: ReaderWidth | "full";
  theme: ReaderTheme;
  /** Explicit px from the sheet, else null (token default + `sizeDelta`). */
  size: number | null;
  sizeDelta: number;
  leading: number | null;
}

export function resolveTypography(t: ReaderTypography, fallback: ReaderAccountPrefs): ResolvedTypography {
  return {
    font: t.font ?? "sans",
    width: t.width ?? ACCOUNT_WIDTH[fallback.readerWidth ?? "normal"] ?? "medium",
    theme: t.theme ?? "auto",
    size: t.size ?? null,
    sizeDelta: SIZE_DELTA[fallback.readerFontSize ?? "medium"] ?? 0,
    leading: t.leading ?? null,
  };
}

/** Attributes + custom properties for the reader root (consumed by app/styles/reader.css). */
export function typographyAttrs(r: ResolvedTypography): Record<string, unknown> {
  const style: Record<string, string> = {};
  if (r.size !== null) style["--reader-size-user"] = `${r.size}px`;
  else if (r.sizeDelta) style["--reader-size-delta"] = `${r.sizeDelta}px`;
  if (r.leading !== null) style["--reader-leading-user"] = String(r.leading);
  return {
    "data-reader-font": r.font,
    "data-reader-width": r.width,
    "data-reader-theme": r.theme === "auto" ? undefined : r.theme,
    // The dark reader theme is a nested `.dark` scope (tokens.css declares
    // every role on `.dark`, so the whole subtree flips, `dark:` utilities too).
    className: r.theme === "dark" ? "dark" : undefined,
    style,
  };
}
