"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";
import { useSession } from "next-auth/react";
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

function getContrastColor(hex: string, darkForeground: string) {
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

  // "darkForeground" comes from the --brand-foreground token (falls back to the
  // literal below only if that property is empty). "#f8fbff" has no dedicated
  // token counterpart — it's the near-white text option used against dark brand
  // colors — so it stays a literal.
  return luminance > 0.45 ? darkForeground : "#f8fbff";
}

export function ThemeColorApplier() {
  // This component is mounted unconditionally in the root layout, so it
  // also renders on public, unauthenticated pages (login, register, setup).
  // Without gating, getReadingPreferences() (which requires a session)
  // fires there too, throwing and logging server-side noise on every
  // anonymous pageview for a preference that doesn't even apply yet.
  const { status } = useSession();
  const { data: prefs } = useReadingPreferences(status === "authenticated");
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (!prefs) return;

    const root = document.documentElement;
    const computed = getComputedStyle(root);
    // Source defaults from the CSS custom properties so this stays in sync with
    // app/globals.css; the literals are only a last-resort fallback if the
    // property is empty (e.g. before stylesheets have loaded).
    const brandDefault = computed.getPropertyValue("--brand").trim() || "#5ba4cf";
    const brandSecondaryDefault =
      computed.getPropertyValue("--brand-secondary").trim() || "#f0963c";
    const brandForegroundDefault =
      computed.getPropertyValue("--brand-foreground").trim() || "#08111d";

    const accentColor = normalizeHexColor(prefs.accentColor, brandDefault);
    const secondaryColor = normalizeHexColor(prefs.secondaryColor, brandSecondaryDefault);

    root.style.setProperty("--brand", accentColor);
    root.style.setProperty("--brand-secondary", secondaryColor);
    root.style.setProperty(
      "--brand-foreground",
      getContrastColor(accentColor, brandForegroundDefault),
    );
    root.style.setProperty(
      "--brand-secondary-foreground",
      getContrastColor(secondaryColor, brandForegroundDefault),
    );

    // Persisted RTL/LTR preference
    const dir = prefs.layoutDirection === "rtl" ? "rtl" : "ltr";
    if (root.getAttribute("dir") !== dir) {
      root.setAttribute("dir", dir);
    }

    // Push the personalized accent to the OS chrome (Android status bar /
    // task-switcher strip) by updating the live theme-color meta(s). layout.tsx
    // declares one meta per color-scheme media query; update whichever matches
    // the currently resolved theme so we don't clobber the other scheme's tag.
    const themeColorMetas = document.querySelectorAll<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    if (themeColorMetas.length > 0) {
      const isDark = resolvedTheme === "dark";
      const matchingMeta =
        Array.from(themeColorMetas).find((meta) => {
          const media = meta.getAttribute("media") || "";
          return isDark ? media.includes("dark") : media.includes("light");
        }) ?? themeColorMetas[0];
      matchingMeta.setAttribute("content", accentColor);
    }
  }, [prefs, resolvedTheme]);

  return null;
}
