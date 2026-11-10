# FeedFerret Design System

> Single source of truth for the visual conventions. Values live in exactly two files — [`app/styles/tokens.css`](../app/styles/tokens.css) and [`app/styles/motion.css`](../app/styles/motion.css), imported by [`app/globals.css`](../app/globals.css). Everything else uses the utilities those tokens generate. A lint guard enforces it (§9).
> Rewritten with the token foundation (spec: `.pm/spec-shell-design.md` §4; audit: `.pm/audit-ux.md` §3.7). Direction: FDL, Reeder-inspired — flat list, quiet chrome, brand only on actionable things.

---

## 1. Colour roles

Light = `:root`, dark = `.dark` (next-themes class on `<html>`). The shadcn names (`--background`, `--card`, `--popover`, `--muted-foreground`, …) are **aliases** of the roles, so existing utilities keep working.

| Role (utility) | Light | Dark | Use |
|---|---|---|---|
| `--surface-base` (`bg-surface-base`, = `bg-background`) | `oklch(.975 .004 250)` | `oklch(.13 .012 255)` | page, list, reader |
| `--surface-raised` (`bg-surface-raised`, = `bg-card`) | `oklch(.995 .002 250)` | `oklch(.18 .012 255)` | cards, segmented thumb. **Opaque** |
| `--surface-sunken` (`bg-surface-sunken`) | `oklch(.945 .006 250)` | `oklch(.105 .012 255)` | placeholders, inputs, pressed row |
| `--surface-bar` (`bg-surface-bar`) | base @ 82 % | @ 80 % | top bars, pills (+ blur-bar) |
| `--surface-overlay` (`bg-surface-overlay`, = `bg-popover`) | @ 94 % | @ 94 % | sheets, menus, dialogs (+ blur-overlay) |
| `--text-primary` / `--text-secondary` (`text-foreground` / `text-muted-foreground`) | `.18` / `.46` (6.7:1) | `.95` / `.68` (7.0:1) | body / meta |
| `--divider` (`border-divider`) | hairline | hairline | 1 px lines |
| `--unread` (`bg-unread`) | `--primary` | `--brand` | the only unread colour — **never red** |
| `--selected` (`bg-selected`) | `--sidebar-accent` | same | the single selected style |
| `--accent-subtle` (`bg-accent-subtle`) | brand 14 % | brand 20 % | active tab background |
| `--success` / `--warning` / `--danger` / `--info` (+ `-subtle`) | dark enough for text on light | light enough for text on dark | status, never palette colours |
| `--scrim` / `--scrim-reader` | black .55 / .08 | .6 / .3 | overlays / list under compact reader |

- **Status colours:** `bg-warning/10 border-warning/20 text-warning`, not `bg-amber-500/10 text-amber-700 dark:text-amber-400`. The roles already adapt to dark, so no `dark:` twin is needed. `danger` is the text/icon-safe red (`destructive` remains the fill for destructive buttons).
- **User accent (Settings → Appearance):** `ThemeColorApplier` writes `--brand`, `--brand-secondary`, `--brand-foreground` (+ `-secondary-foreground`) inline on `<html>`. All accent-derived roles are expressions of `--brand` (`--unread` in dark, `--accent-subtle`, `--primary`/`--accent` in dark, `--ring`, `--sidebar-accent`). **Never hard-code a brand colour; never re-declare `--brand` in CSS.**
- `@supports not (backdrop-filter)` and `prefers-reduced-transparency` make bar/overlay surfaces opaque.
- Never hard-code `bg-black`/`text-white`/`zinc-*`/hex in app UI. The Google OAuth `#4285F4` is the one sanctioned literal.
- `viewport.themeColor` = `#f5f7f9` / `#05080c` (matches `--surface-base`, no status-bar seam).
- Focus: `focus-visible:ring-2 focus-visible:ring-ring`; never remove an indicator without a replacement (WCAG 2.4.7).

## 2. Type scale

Utilities `text-<name>` set size, line-height, weight and tracking in one go; an explicit `font-*` / `leading-*` / `tracking-*` utility on the same element wins. Arbitrary `text-[…]` / `tracking-[…]` are banned. **11 px is the minimum size anywhere.**

| Token | Size / line | Weight · tracking | Use |
|---|---|---|---|
| `text-caption` | 11/14 | 500 · 0 | tab labels, chips, duration badge |
| `text-footnote` | 12/16 | 500 · 0 (`tabular-nums` for times/counts) | source line, time, meta |
| `text-body-sm` | 14/20 | 400 | summary, secondary menu text |
| `text-body` | 16/24 | 400 | inputs (≥16 px: no iOS zoom), buttons, sheets |
| `text-row-title` | 16/21 → 17/22 ≥768 | 600 (unread) / 500 (read) · −0.01em | list titles |
| `text-title-sm` | 17/22 | 600 · −0.01em | bar titles |
| `text-title` | 20/26 | 600 · −0.02em | sheet titles |
| `text-headline` | 24/30 | 700 · −0.02em | compact large titles |
| `text-display` | 26/32 → 32/38 ≥768 | 700 · −0.02em | reader headline |

Tracking utilities: `tracking-title` (−0.02em, ≥20 px) · `tracking-subtitle` (−0.01em, 17–19 px) · `tracking-overline` (+0.06em — the only allowed tracking for uppercase). Tailwind's `text-xs/sm/base/…` still exist for legacy code; new code uses the scale above.
Reader body tokens (consumed by the reader PR): `--reader-size` 17/19 px, `--reader-leading` 1.6, `--reader-measure` 68ch.

## 3. Space, safe area, targets

Plain custom properties on `:root`: `--gutter` 16/20/24 · `--row-pad-y` 12 · `--row-gap` 12 · `--bar-h` 52/56 · `--tabbar-h` 60 · `--tabbar-inset` 12 · `--rail-w` 72 · `--sidebar-w` 280 · `--list-w` 380 · `--list-w-medium` 360 · `--reader-gutter` 20/32/48 · `--content-pad-bottom`.

- **Safe areas:** `var(--safe-t|r|b|l)` (and `--titlebar-h`, `--keyboard-inset`). Tailwind: `pt-(--safe-t)`, `pb-[max(0.75rem,var(--safe-b))]`. Never write `env(safe-area-inset-*)` in components.
- **Touch targets:** every interactive element ≥ 44×44 on coarse pointers. `Button` carries `.hit-slop` (an invisible `::after`, `max(100%, var(--hit-min))`, coarse only); visual sizes stay 32/36/44. For raw `<button>`s in bars add `hit-slop` (+ nothing else).
- **Layout variants** (CSS only): `compact:` <768 · `medium:` 768–1199 · `expanded:` ≥1200 · `wide:` ≥768 · `fine:` `(hover:hover) and (pointer:fine)` · `coarse:` `(pointer:coarse)` · `standalone:`. Do not use `sm:`/`lg:` to mean "has a mouse" / "is desktop" in shell code.

## 4. Radius (monotonic)

Role utilities for all new code:

| Utility | px | Use |
|---|---|---|
| `rounded-chip` | 6 | chips, badges, checkboxes |
| `rounded-control` | 10 | buttons, inputs, thumbs |
| `rounded-row` | 14 | cards, covers |
| `rounded-panel` | 20 | popovers, menus, grouped panels |
| `rounded-sheet` | 28 | sheets, dialogs, pills (`rounded-t-sheet` for bottom sheets) |
| `rounded-full` | ∞ | avatars, round buttons, knobs |
| `rounded-icon` | 28 % | app-icon squircle marks |

Legacy Tailwind keys are re-pinned so nothing is inverted: `sm 10 · md 14 · lg 16 · xl 20 · 2xl 20 · 3xl 28 · 4xl 28`. `rounded-[…]` is banned (`rounded-inherit` exists for ScrollArea-style inheritance).

## 5. Elevation and blur

Two levels only. Everything else is flat (hairline at most). **Rows, cards and list panels never blur.**

| Level | Recipe | Utilities |
|---|---|---|
| bar | `--surface-bar` + `blur(20px) saturate(1.4)` + `--shadow-bar` + 1 px `--divider` | `bg-surface-bar backdrop-blur-bar shadow-bar` or `elev-bar` |
| overlay | `--surface-overlay` + `blur(28px) saturate(1.4)` + `--shadow-overlay` | `bg-surface-overlay backdrop-blur-overlay shadow-overlay` or `elev-overlay` |

`.ui-surface`, `.ui-floating-surface`, `.ui-overlay` (scrim) in `globals.css` use the same tokens. Raw `backdrop-blur-xl`, `shadow-2xl` etc. are not used.

## 6. z-index

Only via `z-(--z-*)`: `sticky 10 · bar 30 · reader 40 · overlay 50 · toast 60 · skip 100`. `z-[…]`, numeric `z-10…`, and inline `zIndex: 50` are banned. Inline: `style={{ zIndex: "var(--z-overlay)" }}`.

## 7. Motion

`--dur-press 80ms · --dur-fast 140ms · --dur-base 220ms · --dur-slow 320ms` (hard ceiling) and `--ease-out / --ease-in / --ease-standard`. Tailwind: `duration-(--dur-base)`, `ease-(--ease-out)`. Rules:

- Nothing animates or transitions longer than 320 ms (looping loaders excepted).
- State changes are attributes; CSS transitions on them. No JS timer waits for an animation.
- No `hover:scale`, no `hover:-translate` on new code; press = background within `--dur-press`.
- **Reduced motion:** transitions collapse to 1 ms; `animate-in/out` (tw-animate, Radix, vaul) to 1 ms; spinners/bounce become an opacity pulse; keyframe utilities only exist under `prefers-reduced-motion: no-preference`. User-driven finger tracking stays.
- `html` no longer sets `scroll-behavior: smooth`; call `scrollTo({ behavior: "smooth" })` explicitly where wanted.

## 8. Icons, dialogs, wording (unchanged conventions)

- **Icons:** `lucide-react`. `size-3` (12) badges/meta · `size-4` (16) **default** · `size-5` (20) headers/primary nav; `Button` already sizes bare child SVGs to `size-4`. Prefer `size-N` over `w-N h-N`.
- **Dialogs:** `Dialog` for tasks, `AlertDialog` for explicit yes/no (destructive, irreversible). Always through `DialogContent`/`AlertDialogContent`; guard dirty forms with an `AlertDialog`. Focus management, Escape and scroll-lock come from Radix.
- **Wording (de):** star = "Favorit"; refresh = "Aktualisieren" ("Volltext abrufen" stays its own action); always "du".

## 9. The guard

`eslint-rules/no-raw-design-values.mjs` (rule `ff/no-raw-design-values`, **error**, wired in `eslint.config.mjs` for `app/ components/ hooks/ lib/ features/`) rejects in string/template literals and inline styles:

`rounded-[…]` · `z-[…]`/`z-10`/`zIndex: 50` · `text-[12px]` (sizes; `text-[var(--x)]` colours are fine) · `tracking-[…]` · palette status colours (`amber|emerald|green|red|yellow|orange|blue|sky|…-NNN`) · raw `backdrop-blur[-xl…]` · `env(safe-area-inset-…)` · `duration-NNN`.

Fix by using the token, never by disabling the rule. Need a new value? Add a token to `app/styles/` in its own PR, with the design owner's sign-off. Tests: `tests/design/token-guard.test.ts`, `tests/design/tokens-css.test.ts`.
