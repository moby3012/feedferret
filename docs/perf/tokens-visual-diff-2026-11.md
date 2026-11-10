# Token foundation (PR 3) — visual diff

Screenshots: Playwright/Chromium, seeded e2e data, `reducedMotion: reduce`, main view · reader (first article) · settings, light + dark, 390×844 (touch) and 1280×800. Before = `origin/main@c7aa1d1`, after = this PR. 12 pairs; not committed (binary size budget) — kept next to the PR author's scratch dir (`…/scratchpad/shots/{before,after,cmp-*}.png`).

Pixel difference (share of pixels whose luma differs by >12/255; relative timestamps in list rows shift ~12 min between the two seeded runs and add ≈0.3 %):

| View | 390 light | 390 dark | 1280 light | 1280 dark |
|---|---|---|---|---|
| main | 4.4 % | 4.2 % | 2.4 % | 2.3 % |
| reader | 15.2 % | 15.0 % | 10.4 % | 10.4 % |
| settings | 1.1 % | 0.9 % | 0.4 % | 0.4 % |

Intentional differences:

- **Radius pins**: `2xl` 16→20, `3xl` 24→28, `sm` 12→10, `4xl` 32→28; `rounded-[2rem]/[1.75rem]/[1.65rem]` (32/28/26) → `rounded-sheet` 28; `rounded-[1.5rem]` (24) → `rounded-panel` 20. Visible on settings sections, dialog/sheet corners, the bottom pill, prose images.
- **Reader headline** (largest diff): arbitrary `lg:text-[2.85rem]` (45.6 px) / `sm:text-4xl` (36) → `text-display` 26 px compact, 32 px ≥768. Headline wraps to two lines on 390 px; shifts the body down ~30 px. Tracking −0.04em → −0.02em.
- **Opaque card** (`--card` alpha .86 → 1) and removal of blur on cards/rows/settings sections: imperceptible on the flat page background.
- **Bars/pills/sheets**: blur 40/24 px → 20 (bar) / 28 (overlay); `shadow-2xl` → hairline ring + soft long shadow (`shadow-overlay`). The floating bottom pill looks slightly flatter.
- **Type**: `text-[10px]/[11px]` → `text-caption` (11/14, weight 500): label chips 10→11 px.
- **Status colours** (info/warning/success/danger banners, badges): amber/emerald/green/red/blue palette → role tokens; hue stays close, light-mode text a touch darker, dark-mode contrast preserved (`danger` is a text-safe red, `destructive` unchanged).
- **Tracking**: −0.02em/−0.03em/−0.04em → −0.02em; −0.01em kept; uppercase overlines 0.2/0.18em → +0.06em.
- Motion: entrance animations capped at 320 ms (were 350–500 ms); no `scroll-behavior: smooth` on `<html>`.
