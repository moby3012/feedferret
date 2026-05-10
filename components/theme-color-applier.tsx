"use client";

import { useEffect } from "react";
import { useReadingPreferences } from "@/hooks/use-rss-data";

export function ThemeColorApplier() {
  const { data: prefs } = useReadingPreferences();

  useEffect(() => {
    if (!prefs) return;
    const root = document.documentElement;
    if (prefs.accentColor) root.style.setProperty("--brand", prefs.accentColor);
    if (prefs.secondaryColor) root.style.setProperty("--brand-secondary", prefs.secondaryColor);
  }, [prefs]);

  return null;
}
