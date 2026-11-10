/**
 * `<meta name="theme-color">` per theme = the opaque bar surface
 * (`--surface-bar-solid` in app/styles/tokens.css: oklch(0.985 0.003 250) /
 * oklch(0.15 0.012 255) as sRGB hex). The user's accent is UI only.
 */
export const THEME_COLOR = { light: "#f9fafc", dark: "#080b10" } as const;

/** theme-color for a resolved theme ("dark" → dark bar, anything else → light). */
export function themeColorFor(resolvedTheme: string | undefined): string {
  return resolvedTheme === "dark" ? THEME_COLOR.dark : THEME_COLOR.light;
}
