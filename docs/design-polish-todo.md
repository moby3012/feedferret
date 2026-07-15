# FeedFerret — Visual Polish & Cohesion TODO

> **Goal:** make the whole app feel like *one* smooth, cohesive product — consistent color scheme, aligned typography, tasteful and uniform micro-animations, a shared spacing rhythm, and reuse of the shared primitives instead of per-screen re-implementations.
> **Started:** 2026-07-15. This is a follow-up to the completed design audit ([`design-audit-todo.md`](design-audit-todo.md)) and builds on the conventions in [`design-system.md`](design-system.md).

## Status

✅ **Done 2026-07-15** — audited across all four surfaces and implemented in four merged PRs. **All 37 items resolved.**

| Surface | PR | Status |
|---|---|---|
| Reading experience (article-list, article-reader, search-results-view, mobile controls) | #110, #115 | ✅ done |
| Settings + Server-Settings (settings-form, settings-shell, server-management-dialog, tabs) | #111 | ✅ done |
| Feed management (manage-feeds, feed-management, discovery-panel, feed-edit-dialog) | #112 | ✅ done |
| Auth/onboarding + UI primitives (login/register/setup, components/ui) | #112 | ✅ done |

**Notable beyond pure styling:** fixed a reduced-motion bug (duplicate reader keyframe, #110); replaced 5 hand-rolled `role=switch` toggles with `<Switch>` and a hand-rolled `role=dialog` overlay with a real `Dialog` (focus-trap/Escape restored, #111/#112); fixed a latent i18n crash-path (`t('packSelected')` for a nonexistent key, #112); localized a hardcoded German back-button label and ~40 other strings. Every PR: `tsc`/`lint`/`translations:check`/`pnpm test` (103/103) green.

**Final 3 items (PR #115), once deferred for a design decision, now resolved with the maintainer's calls:** star color → the `--brand-secondary` token; all article rows + skeletons → `rounded-xl`; selected-row state converged to `ring-2 ring-accent/40 border-accent/30 bg-accent/10` across all view modes (with `--brand` reserved for the unread signal).

---

## North-star conventions (unify on these)

The single biggest theme in the audit: **the app already ships shared primitives and utility classes, but many screens bypass them and hand-roll their own.** The fix for most findings is "use the existing primitive."

**Shared primitives to reuse (stop re-implementing):**
- **`.ui-brand-icon`** — the standard 48px brand-tinted section-header icon badge. Use for *every* section badge (not `bg-primary/10`, not `bg-accent/10`).
- **`.ui-control-surface`** — the standard nested control/sub-row surface. Use wherever a card contains a sub-form/control row (not ad-hoc `bg-muted/20` · `bg-background/50` · `bg-background/60` · `bg-card`).
- **`.ui-segmented-surface` / `.ui-segmented-trigger`** — the standard pill segmented control. Use for the theme picker and every tab bar (not ad-hoc `bg-muted/45`).
- **`.ui-floating-surface`** — already the base of `DropdownMenuContent`/popovers. Don't override it with `bg-popover/95 backdrop-blur-xl shadow-2xl` — let it do the work.
- **`<Switch>`** — the shadcn toggle. Delete every hand-rolled `<button role="switch">`; standardize on one size.
- **`<Empty>/<EmptyMedia>/<EmptyTitle>/<EmptyDescription>`** — the shared empty state. Use for *all* empty states.
- **`SettingsSection` / `SettingsPageShell`** (`settings-shell.tsx`) — the shared settings shell (currently **unused** — both settings pages hand-roll their headers). Route both settings entry points through it so title, eyebrow, back button, and sticky-tabs can't diverge.

**Values to standardize on:**
- **Hover/press motion:** `transition-all duration-200 hover:scale-105 active:scale-95` for icon buttons (already the de-facto standard — keep it, just unify button *sizes*).
- **Image hover-zoom:** `transition-transform duration-500 hover:scale-105` everywhere (retire the `duration-700 scale-110` variant).
- **Reveal/expand animation:** `animate-fade-in-up` (already reduced-motion-gated).
- **Tab / content-swap animation:** `filter-swap` (~0.32s).
- **Gesture snap-back easing:** `cubic-bezier(0.16, 1, 0.3, 1)` (the app's signature easing).
- **Heading tracking scale:** `-0.02em` (text-lg), `-0.03em` (text-xl page titles), `-0.04em` (text-2xl+). No bespoke half-steps (`-0.015em`, `-0.035em`).
- **Uppercase eyebrow labels:** `text-xs font-semibold uppercase tracking-wider` (the dominant pattern).
- **Field labels:** `text-sm font-medium` + a real `<label htmlFor>`.
- **Icon sizes:** `size-3` (badges/metadata), `size-4` (default — buttons, inline, form icons), `size-5` (section/nav headers). Retire the 14px `h-3.5 w-3.5` in-betweens.
- **Radius (per `design-system.md`):** inputs/selects `rounded-lg` (or the current de-facto `rounded-2xl` — pick one), list rows `rounded-xl`, section cards `rounded-2xl`, dialogs/sheets `rounded-3xl`/`[2rem]`. **Skeletons must match the radius of the row they resolve into.**
- **Read/unread title weight:** unread `font-semibold`, read `font-medium text-foreground/75` — identical in every view mode.
- **Selected state:** `ring`/`border` on `--accent`; keep `--brand` reserved for the *unread* signal only.
- **Save feedback:** instant local prefs stay silent; anything with a network write toasts success/error (never a bare `catch {}`).

---

## Findings — Reading experience

### Color-scheme cohesion
- [x] **[P1] Selected-article state uses different tokens per view mode** — `S` · `components/article-list.tsx:598` (minimal `ring-accent/20`), `:748` (classic `border-accent/25`), `:649-650` (magazine `ring-brand border-brand`). Magazine reuses `--brand`, which collides with the unread signal → a selected+unread card is indistinguishable from unread. Use `ring-2 ring-accent border-accent` for magazine; reserve `--brand` for unread.
- [x] **[P2] `hover:bg-muted/50` vs `hover:bg-card/80` for the same unselected-row hover** — `S` · `article-list.tsx:599` vs `:749`. Standardize on `hover:bg-card/80`.
- [x] **[P3] Star color `amber-500` is a hardcoded literal (~20+ uses)** — `M` · `article-list.tsx:552,613,616,694,697,806,872,876`, `article-reader.tsx:354,676,681`. ✅ Done (PR #115): migrated star-semantic `amber-500` to the `--brand-secondary` token (added `--color-brand-secondary` utility); warning ambers left as-is.

### Typography
- [x] **[P1] Read/unread title weight differs in every view mode** — `S` · minimal `article-list.tsx:605` (600→400), classic `:826-828` (600→500), magazine `:678` (700→600). Standardize: unread `font-semibold`, read `font-medium text-foreground/75` in all three.
- [x] **[P2] Uppercase eyebrow labels use 3 tracking values** — `S` · `keyboard-shortcuts-dialog.tsx:79` (`tracking-wide`), `article-reader.tsx:521` (`tracking-wider`), `mobile-bottom-controls.tsx:166` (`tracking-[0.16em]`). Unify on `tracking-wider`.
- [x] **[P2] Off-grid heading letter-spacing** — `S` · article `<h1>` `article-reader.tsx:485` (`-0.035em` → `-0.04em`), row title `article-list.tsx:824` (`-0.015em` → `-0.02em`).
- [x] **[P3] Empty-state heading bolder than the article headline** — `S` · `article-reader.tsx:260` (`font-bold`) vs `:485` (`font-semibold`). Use `font-semibold` for both.
- [x] **[P3] Minimal-view timestamp `text-[10px]`** — `S` · `article-list.tsx:606` → `text-xs`.

### Micro-animations
- [x] **[P1] Duplicate `slide-in-right` keyframes — the reader's open/close uses the wrong, un-reduced-motion-gated one** — `M` · `app/globals.css:221-260` (0.4s, gated) vs `:356-371` (0.28s, ungated, wins); consumed at `app/page.tsx:1068`. Users with `prefers-reduced-motion` still get the reader animation. Rename one pair, gate the reader's version, pick duration/easing intentionally.
- [x] **[P2] Image hover-zoom uses 3 duration/scale magnitudes** — `S` · `article-list.tsx:661` (`duration-700 scale-110`), `:762` (`duration-500 scale-105`), `article-reader.tsx:575` (`duration-700 scale-105`). Standardize on `duration-500 hover:scale-105`.
- [x] **[P3] Gesture snap-back uses two easings** — `S` · pull-to-refresh `article-list.tsx:405` (`ease` 180ms) vs swipe `:536` (signature easing 220ms). Use `cubic-bezier(0.16,1,0.3,1)` for both.

### Spacing & rhythm
- [x] **[P1] Skeletons don't match the radius of the rows they become (shape-pop on load, all 3 modes)** — `S` · skeletons `article-list.tsx:60-95` all `rounded-xl`; real rows `:595` (`rounded-2xl`), `:648` (`rounded-3xl`), `:744` (`rounded-2xl sm:rounded-3xl`). Match skeleton radius to its row.
- [x] **[P2] Article-row radii exceed the documented list-row scale** — `M` · `article-list.tsx:595,648,744` are `rounded-2xl`/`3xl` vs documented `rounded-xl`. ✅ Done (PR #115): all rows + skeletons unified to `rounded-xl` (matches the documented list-row scale).
- [x] **[P3] Selected-row visual weight varies a lot across modes** — `M` · classic shadow+border vs minimal faint ring vs magazine heavy double ring. ✅ Done (PR #115): converged to `ring-2 ring-accent/40 border-accent/30 bg-accent/10` across all modes; `--brand` stays the unread signal.

### Component consistency
- [x] **[P1] Reader desktop toolbar buttons are bigger than the identical main-header toolbar** — `S` · `article-reader.tsx:316-437` (`w-11 h-11`, `w-5 h-5` icons) vs `rss-header.tsx:132-269` (`w-10 h-10`, `w-4 h-4`). Drop reader header buttons to `w-10 h-10` + `w-4 h-4`.
- [x] **[P1] Three bespoke empty states in the reading flow, none matching the shared `Empty`** — `M` · `article-list.tsx:392-398` (uses `Empty` but `size-6` icon vs the `size-5` used elsewhere), `article-reader.tsx:247-269` (fully bespoke), `search-results-view.tsx:115-132` (fully bespoke). Rebuild both bespoke ones on `Empty`/`EmptyMedia`/`EmptyTitle`; fix the icon size to `size-5`.
- [x] **[P2] `search-results-view` mixes a raw `<button>` chip with a `Button` ghost-icon in one toolbar** — `S` · `search-results-view.tsx:86-96` vs `:98-109`. Rebuild the close button on `Button variant="ghost" size="icon"`.
- [x] **[P3] Ad-hoc `bg-popover/95 backdrop-blur-xl shadow-2xl` flattens `.ui-floating-surface`** — `S` · `article-reader.tsx:441,724` (also `rss-sidebar.tsx:1275`). Remove the overrides; keep only sizing/radius.

### Flow / polish
- [x] **[P2] Untranslated German "Zurück" actually renders on the mobile settings back button** — `S` · default at `mobile-floating-back-button.tsx:9`; call sites `settings-form.tsx:609` and `settings-shell.tsx:143` omit `label`. Pass `label={t(...)}`, change the default to a neutral `"Back"` or make it required.

---

## Findings — Settings & Server-Settings

> Root cause: `SettingsSection`/`SettingsPageShell` (`settings-shell.tsx`) are the intended shared shell but are **unused** — `settings-form.tsx` and `server-management-dialog.tsx` hand-roll their own section markup, which drives most of the divergence below.

### Color-scheme cohesion
- [x] **[P1] Section icon badges use 3 treatments** — `S` · `.ui-brand-icon` (`settings-form.tsx:111,188,767,2304`) vs flat `bg-primary/10` (`:521,924,1746,1904,2158`) vs `bg-accent/10` (`:1142`). Standardize all on `.ui-brand-icon`.
- [x] **[P2] Nested sub-row backgrounds drift across 4+ tokens** — `M` · `bg-muted/20` · `bg-background/50` · `bg-background/60` · `bg-muted/30` in `settings-form.tsx` (~12 spots); opaque `bg-card` in `server-management-dialog.tsx` (~8). Standardize on `.ui-control-surface`.

### Typography
- [x] **[P1] Settings vs Server-Settings page titles differ ~2 type steps** — `S` · `settings-form.tsx:166` (`text-3xl/4xl -0.04em`) vs `settings-shell.tsx:124` (`text-xl/2xl -0.03em`). Unify (ideally route both through `SettingsPageShell`).
- [x] **[P1] Field labels have 4 unrelated treatments; notification-channel fields have no `<label>` at all** — `M` · digest uppercase `text-xs`, AI/2FA `text-sm font-medium`, token `text-xs`, channels none (`settings-form.tsx:2330-2417`). Standardize on `text-sm font-medium` + real `<label htmlFor>`.
- [x] **[P2] Settings eyebrow/breadcrumb is a third bespoke pattern** — `S` · `settings-form.tsx:162-165` vs the two shell variants. Consolidate via the shared shell.

### Micro-animations
- [x] **[P2] Conditional reveal panels pop in with no animation** — `S` · digest `settings-form.tsx:1182`, 2FA `:950,:1009`, sync tutorial `:2172`. Wrap in `animate-fade-in-up`.
- [x] **[P2] Tab-panel switches have no enter transition** — `M` · all `TabsContent` in `settings-form.tsx` + `server-management-dialog.tsx` (~16). Apply `filter-swap`.
- [x] **[P3] Theme picker + tab bar bypass `.ui-segmented-surface`** — `S` · `settings-form.tsx:198`, `responsive-tabs-nav.tsx:49`. Use `.ui-segmented-surface`/`.ui-segmented-trigger`.

### Spacing & rhythm
- [x] **[P1] Section-card radius disagrees with the scale AND between the two pages** — `M` · `settings-form.tsx` `rounded-[2rem]` (11×) vs `server-management-dialog.tsx` `rounded-3xl` (13×+); docs say `rounded-2xl`. Unify (recommend `rounded-2xl` via a shared class).
- [x] **[P2] Select/Input radius fragmented (lg spec / xl / 2xl)** — `S` · majority `rounded-2xl`, AI+token clusters drift to `rounded-xl` (`settings-form.tsx:1379,1786,1791,1802,1920,1943,1956,1978,1992`). Pick one (recommend `rounded-2xl`, the Input default) and drop overrides.
- [x] **[P3] Magic `pt-7` offset aligns a Switch beside a Select** — `S` · `server-management-dialog.tsx:640`. Use a `grid items-end` layout instead.

### Component consistency
- [x] **[P1] Toggle switches: 3 hand-rolled `<button role=switch>` + size-inconsistent `<Switch>`** — `M` · hand-rolled `settings-form.tsx:1164-1179,1351-1366,1476-1491` (different track/thumb tokens); `<Switch>` at `h-6 w-11` in some places, `h-7 w-12` in others. Replace hand-rolled with `<Switch>`; pick one size everywhere.
- [x] **[P1] Back button styled completely differently on the two settings pages** — `S` · frosted pill `settings-form.tsx:152-160` vs bare ghost `settings-shell.tsx:119-121`. Route both through one shared treatment.
- [x] **[P2] Icon sizes at off-scale 14px (`h-3.5 w-3.5`)** — `S` · `server-management-dialog.tsx:903,915,918,926,930,1227`, `settings-form.tsx:1846`. Round to `size-4`.

### Flow / polish
- [x] **[P1] Save feedback inconsistent: silent auto-save vs toast vs swallowed `catch {}`** — `M` · PrefRow/digest auto-save silently; AI/channels/server-settings toast; `TwoFactorSection` `settings-form.tsx:896-917` swallows errors silently. At minimum add `toast.error` to the three 2FA `catch {}` blocks; decide a consistent model.
- [x] **[P2] Empty states mix `Empty` with bare muted-text** — `S` · no-tokens `settings-form.tsx:1824`, no-starter-feeds `server-management-dialog.tsx:963`, no-storage `:1162` are bare `<p>`. Route through `Empty`.
- [x] **[P2] Settings tab bar scrolls away; Server-Settings tab bar is pinned** — `M` · `settings-form.tsx:172-179` (inline) vs `settings-shell.tsx:130-138` (`sticky top-0`). Make user Settings tabs sticky too (ideally via the shared shell).
- [x] **[P3] Loading indicator: spinner vs plain text** — `S` · `ApiTokenSection` `settings-form.tsx:1822` uses text; the rest use `<Loader2 animate-spin>`. Add the spinner.

---

## Findings — Feed management & Auth/primitives

✅ **Done (PR #112).** Audited and fixed in one pass against the north-star conventions:

**Feed management** (`feed-management`, `discovery-panel`, `feed-edit-dialog`, `manage-feeds`):
- [x] Nested control rows → `.ui-control-surface`; Scout Studio badge → `.ui-brand-icon`.
- [x] Section-card radius `rounded-3xl` → `rounded-2xl` (matches settings); ~23 off-scale `h-3.5` icons → `size-4`; oversized empty-state icons → `size-5`.
- [x] Hand-rolled `<div role="dialog">` category-settings overlay → real `Dialog` (focus-trap / Escape / scroll-lock restored).
- [x] ~10 stray `text-[10px]`/`[11px]` metadata → `text-xs`; uppercase eyebrows → `tracking-wider`.
- [x] ~20 hardcoded strings routed through `next-intl` (en+de). *(Skipped: the large rules/alerts syntax reference docs + per-reader migration steps — a separate i18n project, risky to auto-translate.)*

**Auth / onboarding** (`login`, `register`, `setup`) + `components/ui/*`:
- [x] Input radius overrides → `rounded-2xl` (match the shared `Input` default); `h1` tracking → `-0.04em`; card/step titles → `-0.02em`; taglines → `text-xs uppercase tracking-wider`.
- [x] Two hand-rolled `role=switch` toggles → `<Switch>` + `<Label htmlFor>`; setup step badges → `.ui-brand-icon`; nested rows → `.ui-control-surface`; primary-button press unified to `active:scale-95`.
- [x] Fixed latent i18n bug (`t('packSelected')` → existing `packsSelected` plural key); routed setup/login fallback strings through new keys.
- [x] `components/ui/*` primitives already bake in the right conventions (`rounded-2xl`, `.ui-control-surface`, `size-4`) — confirmed no changes needed; the auth pages' inline overrides were the drift.

---

## Suggested implementation order

1. **Shared-primitive sweeps (highest leverage, kills whole finding-classes):** section badges → `.ui-brand-icon`; nested rows → `.ui-control-surface`; tab bars/theme picker → `.ui-segmented-surface`; toggles → `<Switch>`; empty states → `<Empty>`; route both settings pages through `SettingsPageShell`.
2. **Motion correctness:** fix the duplicate `slide-in-right` keyframe + reduced-motion gate; standardize image-hover zoom; add `fade-in-up` reveals and `filter-swap` tab transitions.
3. **Radius coherence:** skeletons match rows; unify section-card and form-control radii.
4. **Cross-view consistency:** unified read/unread weight, selected-state tokens, reader vs header button sizes.
5. **Polish tail:** eyebrow tracking, `text-[10px]`/`h-3.5` off-scale values, the `"Zurück"` string, save-feedback model.
