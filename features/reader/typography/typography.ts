"use client";

// Reader typography ("Aa" sheet, .pm/research-reeder.md §4.3): font style,
// measure, size, leading and a reader theme that is independent of the app
// theme. A per-device choice (like the app theme), kept in the `ff_ui` cookie
// (`rt`, spec §0.3): server-readable, so a cold `?a=` deep link is rendered
// styled and hydration changes nothing. Every field is optional; an unset
// field falls back to the per-feed override, then the account preference
// (Settings → reader width / font size), then the design tokens.
//
// The values reach the page only as data attributes + CSS custom properties on
// the reader root (app/styles/reader.css), so a change repaints without
// re-rendering the article.
import { useState, useSyncExternalStore } from "react";
import { readUiPrefsFromDocument, writeUiPrefs } from "@/features/reader/layout/ui-prefs";
import { useUiPrefs } from "@/features/reader/layout/ui-prefs-context";
import { EMPTY_TYPOGRAPHY, sameTypography, sanitizeTypography, type ReaderTypography, type ReaderWidth, type ReaderFont, type ReaderTheme } from "./values";

export {
  READER_FONTS,
  READER_LEADINGS,
  READER_SIZE_MAX,
  READER_SIZE_MIN,
  READER_THEMES,
  READER_WIDTHS,
  clampSize,
  type ReaderFont,
  type ReaderTheme,
  type ReaderTypography,
  type ReaderWidth,
} from "./values";

/** Account / per-feed preferences the sheet's unset fields fall back to. */
export interface ReaderAccountPrefs {
  readerWidth?: string | null;
  readerFontSize?: string | null;
}

let current: ReaderTypography | null = null;
const listeners = new Set<() => void>();

function read(): ReaderTypography {
  try {
    return sanitizeTypography(readUiPrefsFromDocument().rt);
  } catch {
    return EMPTY_TYPOGRAPHY;
  }
}

export function getReaderTypography(): ReaderTypography {
  if (typeof window === "undefined") return EMPTY_TYPOGRAPHY;
  if (!current) current = read();
  return current;
}

/** Another tab may have changed the cookie: pick it up when this one comes back. */
function refresh() {
  if (document.visibilityState === "hidden") return;
  const next = read();
  if (current && sameTypography(current, next)) return;
  current = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    }
  };
}

function commit(next: ReaderTypography) {
  current = sanitizeTypography(next);
  try {
    writeUiPrefs({ rt: Object.keys(current).length ? current : undefined });
  } catch {
    /* cookies blocked: the choice still applies for this page */
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

/** Tests only: forget the module copy (re-read the cookie on next access). */
export function resetReaderTypographyCache() {
  current = null;
}

/**
 * The typography for this render. Server + hydration render use what the
 * server parsed from `ff_ui` for this request (UiPrefsProvider), so the
 * SSR'd reader and the first client render agree — no restyle, no reflow.
 */
export function useReaderTypography(): ReaderTypography {
  const ui = useUiPrefs();
  const [ssr] = useState(() => sanitizeTypography(ui.current.rt));
  // After hydration the client snapshot is read from the same cookie: equal
  // values, so the follow-up render writes no attribute.
  return useSyncExternalStore(subscribe, getReaderTypography, () => ssr);
}

// ------------------------------------------------------------ resolution

/** Account font size names → px delta on the token default (17 compact / 19 wide). */
const SIZE_DELTA: Record<string, number> = { small: -2, medium: 0, large: 2, xl: 4 };
/** Account width names → measure. */
const ACCOUNT_WIDTH: Record<string, ReaderWidth> = { normal: "medium", wide: "wide", full: "full" };

export interface ResolvedTypography {
  font: ReaderFont;
  width: ReaderWidth;
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
