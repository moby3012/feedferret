// Reader typography values shared by the server (`ff_ui` cookie parsing,
// features/reader/layout/ui-prefs.ts) and the client store (./typography.ts).
// No "use client": the server calls `sanitizeTypography`.

export const READER_FONTS = ["sans", "serif", "rounded"] as const;
/** `full` is also the account setting "Full width" (Settings → reader width). */
export const READER_WIDTHS = ["narrow", "medium", "wide", "full"] as const;
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

export const EMPTY_TYPOGRAPHY: ReaderTypography = Object.freeze({}) as ReaderTypography;

export function clampSize(px: number): number {
  return Math.min(READER_SIZE_MAX, Math.max(READER_SIZE_MIN, Math.round(px)));
}

/** Only known values survive; theme "auto" is the absence of a theme. */
export function sanitizeTypography(raw: unknown): ReaderTypography {
  if (!raw || typeof raw !== "object") return EMPTY_TYPOGRAPHY;
  const r = raw as Record<string, unknown>;
  const out: ReaderTypography = {};
  if (READER_FONTS.includes(r.font as ReaderFont)) out.font = r.font as ReaderFont;
  if (READER_WIDTHS.includes(r.width as ReaderWidth)) out.width = r.width as ReaderWidth;
  if (READER_THEMES.includes(r.theme as ReaderTheme) && r.theme !== "auto") out.theme = r.theme as ReaderTheme;
  if (typeof r.size === "number" && Number.isFinite(r.size)) out.size = clampSize(r.size);
  if (typeof r.leading === "number" && READER_LEADINGS.includes(r.leading as (typeof READER_LEADINGS)[number])) out.leading = r.leading;
  return Object.keys(out).length ? out : EMPTY_TYPOGRAPHY;
}

export function sameTypography(a: ReaderTypography, b: ReaderTypography): boolean {
  return a.font === b.font && a.width === b.width && a.size === b.size && a.leading === b.leading && a.theme === b.theme;
}
