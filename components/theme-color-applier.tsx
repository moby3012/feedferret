"use client";

import { useEffect } from "react";
import { useReadingPreferences } from "@/hooks/use-rss-data";

function normalizeHexColor(value: string | null | undefined, fallback: string) {
  const raw = value?.trim();
  if (!raw) return fallback;

  const hex = raw.startsWith("#") ? raw.slice(1) : raw;
  if (!/^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(hex)) return fallback;

  if (hex.length === 3) {
    return `#${hex
      .split("")
      .map((char) => `${char}${char}`)
      .join("")
      .toLowerCase()}`;
  }

  return `#${hex.toLowerCase()}`;
}

function getContrastColor(hex: string) {
  const sanitized = hex.replace("#", "");
  const value = Number.parseInt(sanitized, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;

  const toLinear = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };

  const luminance =
    0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

  return luminance > 0.45 ? "#08111d" : "#f8fbff";
}

export function ThemeColorApplier() {
  const { data: prefs } = useReadingPreferences();

  useEffect(() => {
    if (!prefs) return;

    const root = document.documentElement;
    const accentColor = normalizeHexColor(prefs.accentColor, "#5ba4cf");
    const secondaryColor = normalizeHexColor(prefs.secondaryColor, "#f0963c");

    root.style.setProperty("--brand", accentColor);
    root.style.setProperty("--brand-secondary", secondaryColor);
    root.style.setProperty("--brand-foreground", getContrastColor(accentColor));
    root.style.setProperty(
      "--brand-secondary-foreground",
      getContrastColor(secondaryColor),
    );
  }, [prefs]);

  return null;
}
