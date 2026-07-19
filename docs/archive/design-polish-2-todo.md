# FeedFerret — Visual Polish Round 2: Color, Contrast & Mobile/PWA

> **Goal:** a cleaner, more confident color scheme (flat & intentional, not muddy tints/gradients), legible contrast everywhere (WCAG AA), and a phone/PWA experience that feels **native**.
> **Started:** 2026-07-16. Follows the completed round-1 polish ([`design-polish-todo.md`](design-polish-todo.md)); conventions live in [`design-system.md`](../design-system.md).
> **Source:** two focused audits (color/contrast — with *computed* WCAG ratios; mobile/responsive/PWA — with a root-cause for the reported bottom-nav bug).

---

## Progress (2026-07-16)

Implementation is running in sequential, individually-merged batches (all touch `app/page.tsx`, so not parallelizable):

| Batch | Scope | Status |
|---|---|---|
| 1 · Color foundation | flatten `.ui-*` utilities to solid, contrast token fixes (`--primary`/`--accent`/dark `--accent-foreground`/`--muted-foreground`, new `--link`) | ✅ merged (PR #119) |
| 2 · Color component sweep | bare `text-accent`/`text-primary` → `text-link`/solid; selected-states off the `/10` wash → `border-s-2 border-accent bg-muted` / solid chips | ✅ merged (PR #120) |
| 3 · Mobile P1 | bottom-nav bleed-through fix + `safe-area-inset-top` on top bars | ✅ merged (PR #122) |
| 4 · Mobile P2/P3 | touch targets 44px, `min-h-dvh`, manifest colors, tap-highlight reset, drawer safe-area, accent→OS `theme-color` | ✅ merged (PR #123) |
| 5 · Article sort | stable `createdAt`+`id` `orderBy` tiebreaker (server + client) so date-less feeds surface newest-first | ✅ merged (PR #124) |

**All five batches merged.** Also shipped alongside: tap-the-headline / swipe-left to open the original article (PR #125).

**Closed out (Phase 0.1, PR #136):** inline `width`/`min-width` are now stripped from untrusted article HTML by the shared `lib/sanitize-html.ts` `getSanitizer()` hook (keeps `max-width`); the 320px (iPhone SE) pass on `ResponsiveTabsNav` + the rss-header title/icon row was verified OK (see the Overflow / verification section below).

**Follow-up per maintainer:** re-introduce brand color as deliberate *highlights* on important non-interactive elements (the flattening in batches 1–2 was intentionally cautious; see the refined rule A.1 above) — a light, taste-driven pass, best done against specific elements the maintainer points at.

---

## North star

### A. Color direction — flat, confident, high-contrast
The app currently derives almost everything from `color-mix(brand …)` tints and stacked gradients, so nearly every surface (cards, inputs, buttons, tabs, icon chips) carries a faint brand wash — nothing reads as a single clean color, and hierarchy collapses. New rules:

1. **Brand color = interactive OR genuinely important.** Use the two brand colors for interactive/actionable things (primary buttons, active nav, checked controls, links, real "selected" states) **and** to deliberately highlight *important* non-interactive information (unread emphasis, key badges/stats, a section that deserves attention). The rule is **intentional, not austere** — don't tint *everything* (that's the muddiness we removed), but don't be so sparse that nothing stands out either. Neutral (`--card`/`--muted`/`--border`) stays the default for ordinary chrome; brand is the deliberate exception that draws the eye. *(Refined 2026-07-16 per maintainer: earlier "interactive-only" wording was too strict.)*
2. **Flatten the gradient utilities** to solid fills for interactive/foreground surfaces: `.ui-control-surface` → solid `--background`/`--border`; `.ui-brand-button` → solid `--primary`/`--primary-foreground`; `.ui-segmented-trigger[active]` → one solid color; `.ui-brand-icon` → solid `--accent`/`--accent-foreground`. Keep at most **one** subtle page-level ambiance (`.app-chrome`, reduced to a single low-opacity radial).
3. **Never use `bg-{primary,accent,brand-secondary}/10…/20` as a persisted "selected" state.** Use a solid `bg-accent text-accent-foreground` chip or a `border-s-2 border-accent bg-muted` indicator. Opacity tints are for transient hover-preview only.
4. **Never use `text-accent`/`text-primary` as body/link text** on `--background`/`--card`/`--muted` (computed ~1.95–2.2:1 in light — a severe AA fail). Links use a dedicated `--link` token; "active" labels become solid chips.

**Token changes (concrete, from the audit's computed values):**
- Light `--primary: oklch(0.62 0.11 235)`, light `--accent: oklch(0.58 0.115 235)` (darker/more saturated → text-safe ≥4.6:1 on `--background`).
- `.dark` `--accent-foreground: oklch(0.97 0.005 250)` (currently reuses the near-black `--brand-foreground` → only 3.14:1 on dark accent; this is a WCAG bug).
- Light `--muted-foreground: oklch(0.46 0.012 255)`, dark `--muted-foreground: oklch(0.68 0.01 250)` (base ratio vs `--muted` clears 4.5:1).
- New `--link` token: light `oklch(0.5 0.13 235)`, dark `oklch(0.75 0.11 235)`; `prose-a` → `text-link`.

### B. Native-feel conventions (mobile/PWA)
1. **Safe-area on every edge**, not just bottom: top bars get `padding-top: env(safe-area-inset-top)`; bottom bars keep `pb-[max(Xrem,env(safe-area-inset-bottom))]` and add `padding-inline: max(1rem, env(safe-area-inset-left/right))` for landscape. **A fixed bar's opaque background must cover its full rectangular footprint** — no translucent-only-inside-a-rounded-pill wrappers that let scrolled content peek through corners/gutters.
2. **Always `dvh`** (`h-dvh`/`min-h-dvh`/`max-h-[calc(100dvh-…)]`), never bare `vh`/`min-h-screen`, for anything that can appear on a phone.
3. **Touch targets ≥ 44px** (`h-11 w-11`) for icon-only mobile controls; use the established `h-11 w-11 sm:h-9 sm:w-9` responsive-shrink pattern.
4. Global `-webkit-tap-highlight-color: transparent`; rely on existing `active:scale-*` press states.
5. **No `position: fixed` nested inside an ancestor carrying a `transform`** (incl. animation `fill-mode: forwards` leftovers) — it changes the inner element's containing block away from the viewport (a mobile bleed/desync trigger). Clear the transform on `animationend`.

---

## Suggested order of attack

1. **Token/utility color foundation** (globals.css) — flatten `.ui-*` utilities + the 4 token fixes + `--link`. Highest leverage, fixes muddiness + the worst contrast bugs at the source. → *Color batch, PR 1*
2. **Selected-state + `text-accent`/`text-primary` sweep** across components (solid chips instead of tints). → *Color batch, PR 2*
3. **Mobile P1s** — bottom-nav bleed-through bug + safe-area-top. → *Mobile batch, PR 3*
4. **Mobile P2/P3** — touch targets, `min-h-dvh`, manifest, tap-highlight, drawer safe-area. → *Mobile batch, PR 4*
5. **Article-sort tiebreaker** (functional bug). → *own PR*

**Totals:** Color 12 (6 P1 · 3 P2 · 3 P3) · Mobile 16 (2 P1 · 6 P2 · 8 P3) · +1 functional sort bug.

---

## Functional bug — article sort (reported)

- [ ] **[P1] Feeds without a valid `publishedAt` render oldest→newest** — `M`
  Server always orders `publishedAt: desc` (`app/actions/feeds.ts:639`) with **no tiebreaker**; the client sorts stably by `publishedAtRaw` (`app/page.tsx:342-345`). Feeds whose items lack a parseable date all get the same sync-time fallback (`lib/rss-sync.ts:346` `item.publishedAt || new Date()`), so their articles tie and fall back to XML/insertion order — which is oldest-first for some feeds, ignoring the "newest" default.
  **Fix:** in `syncFeed`, give **new** date-less articles a position-based synthetic `publishedAt` (item 0 = newest → `base - index`), applied only on create so re-syncs don't churn/reorder; and add a stable secondary sort (`{ createdAt: "desc" }`, then `id`) to both the server `orderBy` and the client comparator. Preserve dated feeds' behavior exactly.

---

## Color & contrast findings

### Muddy / over-tinted surfaces
- [ ] **[P1] `.ui-control-surface` brand-tints nearly every bordered box** — `M` · `app/globals.css:400-410`; applied via `button.tsx:15-16` (outline/secondary), `input.tsx:11`, `textarea.tsx:10`, `select.tsx:40`, `dialog.tsx:72`, `sheet.tsx:75`, + 30+ direct uses (settings-form, feed-management, server-management-dialog, feed-edit-dialog, discovery-panel, setup). Every input/card/secondary-button looks the same faint wash. **Fix:** flat `background: var(--background)` (or `--card`) + `border-color: var(--border)`, drop the `color-mix` tint + shadows.
- [ ] **[P1] Selected/active/starred = `bg-{accent|primary|brand-secondary}/10` + same-hue text** — `M` · ~40 sites incl. `article-list.tsx:598,649,694,702,748,813,872,882`, `article-reader.tsx:364,676,702`, `rss-sidebar.tsx:745,821,1228`, `rss-header.tsx:169`, `mobile-bottom-controls.tsx:195`, `feed-management.tsx:1326,1489,2009,2025,2031,2596,2607,2892`, `search-results-view.tsx:57`, `pwa-install-prompt.tsx:127`. Washed-out, murky, indistinguishable from unrelated tints. **Fix:** solid `bg-accent text-accent-foreground` or `border-s-2 border-accent bg-muted`; tints only for hover-preview.
- [ ] **[P2] `.ui-brand-icon` = two-gradient wash on 15+ feature icons** — `S` · `app/globals.css:440-446`; settings-form (×10), feed-edit-dialog:479, setup (×6). **Fix:** flat `background: var(--accent); color: var(--accent-foreground)` (or `bg-muted text-accent`).

### Gradient overuse
- [ ] **[P1] Every default `<Button>` is a two-color diagonal gradient** — `S` · `app/globals.css:427-434` `.ui-brand-button` (brand→brand-secondary) wired as `button.tsx:12` default variant. **Fix:** flat `bg-primary text-primary-foreground` + `hover:bg-primary/90` (already the intended hover in several call sites).
- [ ] **[P1] `.ui-segmented-trigger[active]` uses a brand+brand-secondary gradient** — `S` · `app/globals.css:418-425`; `tabs.tsx:45`, `settings-form.tsx:211`, `responsive-tabs-nav.tsx:49`. **Fix:** one solid color (`--background` chip or `--primary` bold).
- [ ] **[P2] `.app-chrome`/`.ui-overlay`/`.ui-surface`/`.ui-floating-surface` stack radial+linear brand gradients under every screen/dialog/dropdown** — `M` · `app/globals.css:361-398`. Compounding haze. **Fix:** keep one subtle `.app-chrome` radial; flatten `.ui-surface`/`.ui-floating-surface`/`.ui-segmented-surface` to solid `--card`/`--popover`/`--muted` + `--border`.
- [ ] **[P3] Ad-hoc gradients** — `S` · `article-reader.tsx:642` `bg-gradient-to-br from-muted to-muted/50` → flat `bg-muted`; `settings-form.tsx:264` accent-preview swatch → two solid side-by-side chips (shows real colors, not a blend).

### Text contrast (computed, not eyeballed)
- [ ] **[P1] `text-accent`/`text-primary` as text on `background`/`card` — worst offender (~1.95–2.2:1 light)** — `M` · 23 `text-accent` + 28 `text-primary` sites incl. `prose-a:text-accent` (`globals.css:9`, all article links), settings-form:1734, feed-management:2009/2025/2596/2607, rss-sidebar:821. **Fix:** links → new `--link` token; active labels → solid `bg-accent text-accent-foreground` chips. Never bare `text-accent`/`text-primary` on light surfaces.
- [ ] **[P1] `.dark` `--accent-foreground` is near-black on dark accent → 3.14:1** — `S` · `globals.css:95` not overridden in `.dark` (`:131`). Hits `toggle.tsx:10` (on-state), dropdown/command/calendar focus, segmented buttons. **Fix:** `.dark { --accent-foreground: oklch(0.97 0.005 250) }`.
- [ ] **[P2] `--muted-foreground` fails AA on `--muted`/`--secondary`, worse with `/70`/`/60`/`/50`** — `S`+`M` · `globals.css:92-93,128-129`; base 4.48:1 light / 4.17:1 dark, `/70` on muted = 2.19/3.22. Real content text at `feed-management.tsx:2010,2596`, `article-list.tsx:787`, `search-results-view.tsx:77`, `app/page.tsx:1125`. **Fix:** darken light `--muted-foreground` to `oklch(0.46 0.012 255)`, lighten dark to `oklch(0.68 0.01 250)`; ban opacity-modified `text-muted-foreground/NN` on real content (keep only for decorative glyphs like grip handles / middot separators).
- [ ] **[P3] `text-foreground/70…/80` on real copy** — `S` · feed-management help/modifier labels (1673,1699,1718,2276,2302,2316), article-reader:552 (AI summary), article-list:605/678/827 (read-title dim). `/70`=2.94:1. **Fix:** use a solid token (corrected `--muted-foreground`) instead of opacity-derived foreground.
- [ ] **[P3] `.ui-brand-icon` glyph borderline in light (4.16:1)** — `S` · `globals.css:443`. OK for a large icon; just don't reuse the mixed color for adjacent small text.

### Consistency
- [ ] **[P2] Brand applied at ~7 different strengths simultaneously (88%/76%/8-20%/`/5`/`/10`/`/[0.04]`…)** — covered by flattening above; the guiding rule: brand at full strength = interactive, everything else neutral. Also strengthen weak hover deltas (`.ui-control-surface:hover` 8%→12% is barely perceptible).

---

## Mobile / PWA findings

### Fixed-element collisions (the reported bug)
- [ ] **[P1] Article-reader bottom-nav thumbnail bleed-through (the screenshot)** — `M` · `article-reader.tsx:658-659` (fixed `<nav>` whose background lives only on the inner `rounded-[2rem] bg-background/90` pill) + `:642` (the `w-14 h-14` feed-favicon in the footer) + `app/page.tsx:1080` (reader is a `fixed` panel with a persisted `translateX` from `animate-slide-*`, `fill-mode: forwards`). Three compounding causes: (1) the nav wrapper's `px-3` gutters + rounded-corner cutouts + safe-area strip are **transparent**, so scrolled content shows through; (2) short (non-scrolling) articles can place the footer under the pill because fixed elements don't subtract from flex height; (3) the transformed ancestor makes the nested `fixed` nav's containing block ≠ viewport (URL-bar desync). **Fix:** put the opaque/blurred background on the full-bleed `<nav>` (or a backdrop layer), not just the pill; ensure the reader body reserves the nav's real footprint (`~64px + safe-area`) so short articles clear it; clear the panel transform on `animationend` (or drop `forwards`).
- [ ] **[P2] Toaster mobile offset is a hand-duplicated magic number** — `S` · `layout.tsx:96-102` (`+88px`). **Fix:** derive from a shared `--mobile-bottom-bar-h` CSS var also used by the bars.

### Safe-area / insets
- [ ] **[P1] No `safe-area-inset-top` anywhere (despite `viewport-fit=cover`)** — `S` · sticky/fixed top bars `article-reader.tsx:313`, `rss-header.tsx:114`, `settings-shell.tsx:118` have no top inset; repo-wide `safe-area-inset-top/left/right` = 0 hits. **Fix:** `padding-top: env(safe-area-inset-top)` on top bars; `padding-inline: max(1rem, env(safe-area-inset-left/right))` on the fixed bottom bars.
- [ ] **[P2] Bottom drawer (mobile feed picker) has no safe-area padding** — `S` · `ui/drawer.tsx` `DrawerContent` bottom variant; used at `app/page.tsx:815`. **Fix:** `pb-[max(1rem,env(safe-area-inset-bottom))]`.

### Touch targets
- [ ] **[P2] Manage-Feeds icon buttons are 32px (`h-8 w-8`) with no mobile bump** — `S` · `feed-management.tsx:1277,1326,1335,1115,1131,1141`. **Fix:** `h-11 w-11 sm:h-9 sm:w-9` (the `rss-sidebar.tsx:688` house pattern).
- [ ] **[P3] RSS-header mobile icon buttons are 40px** — `S` · `rss-header.tsx:135,145` → `w-11 h-11`.

### dvh vs vh
- [ ] **[P2] `SettingsPageShell` uses `min-h-screen`** — `S` · `settings-shell.tsx:116` → `min-h-dvh` (settings-form already uses `min-h-dvh`; this shell is the outlier, pairs with a fixed bottom back button).
- [ ] **[P3] Auth/error/accessibility pages use `min-h-screen`** — `S` · `login:152`, `register:81`, `setup:224`, `error.tsx:18`, `global-error.tsx:18`, `accessibility:14` → `min-h-dvh`.

### PWA feel
- [ ] **[P2] Manifest `theme_color`/`background_color` don't match the app** — `S` · `public/manifest.json:30-31` (`#05060a` / `#3b82f6`) vs actual light `#f8f9fc` / dark `#1a1b23`. Light users get a near-black splash flash + mismatched status bar. **Fix:** set `background_color` to the dark bg (~`#1a1b23`) and a `theme_color` that reads on both (or commit to dark).
- [ ] **[P3] User accent color isn't pushed to the OS `theme-color` meta** — `S` · `theme-color-applier.tsx:48-87` updates CSS vars only. **Fix:** also update `meta[name="theme-color"]` after computing the accent.
- [ ] **[P3] No `-webkit-tap-highlight-color` reset** — `S` · add `html { -webkit-tap-highlight-color: transparent }` to `globals.css` `@layer base`.

### Overflow / verification
- [x] **[P3] Untrusted article HTML may carry inline `width`/`min-width`** — `M` · **Fixed:** new `lib/sanitize-html.ts` shared `getSanitizer()` registers a one-time DOMPurify `uponSanitizeAttribute` hook that strips the `width`/`min-width` HTML attributes and `width:`/`min-width:` inline-style declarations (keeps `max-width`); all article-HTML sanitize sites in `lib/rss-sync.ts` + `app/actions/feeds.ts` route through it.
- [x] **[P3] Verify 320px (iPhone SE): `ResponsiveTabsNav` + rss-header title/icon row** — `S` · **Verified OK, no change needed:** `responsive-tabs-nav.tsx` renders a full-width `<Select>` below `sm` (no tab row to clip at 320px); `rss-header.tsx` title uses `min-w-0 flex-1` + `truncate`, mobile icon buttons are `flex-shrink-0` 44px — fits within 320px.

---

## Already solid (preserve)
Momentum/overscroll containment (`overscroll-behavior-y: contain` + custom pull-to-refresh with `preventDefault` gating); dialogs/drawers sized against `dvh` and viewport-relative widths; safe-area **bottom** handling on the existing bars; service-worker registration (after `load`, HTTPS-gated) and the install-prompt gating; `.article-content` overflow guards (`overflow-wrap: anywhere`, `overflow-x: auto` on `pre`/`table`).

---

*Generated from two read-only audits (color/contrast with computed WCAG ratios; mobile/responsive/PWA with root-cause analysis) on 2026-07-16. Tick items as they land; link the PR.*
