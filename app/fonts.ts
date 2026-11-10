import localFont from "next/font/local";

// Web fonts (Geist, SIL OFL 1.1 — app/fonts/OFL.txt).
//
// Only the Latin subset of Geist Sans is on the critical path (preloaded,
// ~32 KB instead of the 69 KB full variable font + 71 KB Geist Mono that the
// `geist/font` presets preloaded on every page). The full font is a separate
// face whose `unicode-range` is everything the subset does not cover, so a
// browser downloads it only when a page actually shows such a character
// (Cyrillic, Greek, Vietnamese, …). Geist Mono is used for code only and is
// never preloaded.
//
// app/fonts/geist-latin.woff2 = geist@1.7.0 Geist-Variable.woff2 through
//   pyftsubset --unicodes="<geistLatin unicode-range>" --layout-features='*' --flavor=woff2
// (fonttools; keep the range below and that command in sync).

// next/font needs literal option values: the two unicode-ranges are written out
// below. Latin = what geist-latin.woff2 contains; the full font's range is its
// exact complement.

export const geistLatin = localFont({
  src: "./fonts/geist-latin.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-geist-latin",
  // The metric-matched fallback comes from `geistSans` (next in the stack).
  adjustFontFallback: false,
  declarations: [{ prop: "unicode-range", value: "U+0000-00FF, U+0131, U+0152-0153, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2190-2199, U+2212, U+2215" }],
});

export const geistSans = localFont({
  src: "../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-geist-sans",
  preload: false,
  declarations: [{ prop: "unicode-range", value: "U+0100-0130, U+0132-0151, U+0154-02C5, U+02C7-02D9, U+02DB, U+02DD-1FFF, U+2070-20AB, U+20AD-2121, U+2123-218F, U+219A-2211, U+2213-2214, U+2216-10FFFF" }],
});

export const geistMono = localFont({
  src: "../node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-geist-mono",
  preload: false,
  adjustFontFallback: false,
  fallback: ["ui-monospace", "SFMono-Regular", "Roboto Mono", "Menlo", "Monaco", "Liberation Mono", "DejaVu Sans Mono", "Courier New", "monospace"],
});

export const fontVariables = `${geistLatin.variable} ${geistSans.variable} ${geistMono.variable}`;
