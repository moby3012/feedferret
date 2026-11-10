"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { writeUiPrefs, type UiPrefs } from "./ui-prefs";

/**
 * The `ff_ui` prefs as the server parsed them for this page (first paint),
 * then kept current by the writes below. Components initialise from it
 * instead of `document.cookie`, so SSR and the hydration render agree, and a
 * later remount (tab switch) still sees the user's latest choice.
 */
type UiPrefsRef = { current: UiPrefs };

const UiPrefsContext = createContext<UiPrefsRef>({ current: {} });

export function UiPrefsProvider({ initialUi, children }: { initialUi: UiPrefs; children: ReactNode }) {
  const [ref] = useState<UiPrefsRef>(() => ({ current: { ...initialUi } }));
  return <UiPrefsContext.Provider value={ref}>{children}</UiPrefsContext.Provider>;
}

export function useUiPrefs(): UiPrefsRef {
  return useContext(UiPrefsContext);
}

/** Writes the cookie and the page's copy (session-only when cookies are blocked). */
export function updateUiPrefs(ref: UiPrefsRef, patch: UiPrefs) {
  ref.current = { ...ref.current, ...patch };
  try {
    ref.current = writeUiPrefs(patch);
  } catch {
    /* cookie blocked: this page only */
  }
}
