# Accessibility (a11y) — Status & Backlog

Goal: WCAG 2.2 AA conformance. Detailed implementation notes per sprint below.

---

## Status Overview (v1.0.0)

| Sprint | Description | Status |
|---|---|---|
| A-1 | Motion, Skip Link, ARIA Landmarks, Icon Labels | ✅ Done |
| A-2 | Screen Reader Live Regions, Focus Management, Semantics | ✅ Done |
| A-3 | Keyboard Navigation, Feed Cards, Drag-and-Drop | ✅ Done |
| A-4 | Visuals & Contrast | 🟡 Partial — Font-size slider done (PR #44); WCAG AA color-contrast now auto-enforced by the axe CI gate on public pages; contrast audit of authenticated screens + 200% zoom still pending |
| A-5 | Tooling: eslint-jsx-a11y ✅, `/accessibility` page ✅, `@axe-core/playwright` in CI ✅ (public pages) | 🟡 Partial — authenticated-page coverage pending a seeded test user |

**A-4 and A-5 are scheduled for v1.2 (Theming release).** See [`docs/releases/v1.2-theming.md`](releases/v1.2-theming.md).

---

## Sprint A-1: Quick Wins ✅

### A-1.1 `prefers-reduced-motion` ✅
All animations in `globals.css` and components gated behind the media query.

### A-1.2 Skip Link ✅
`<a href="#main-content">Skip to content</a>` in `app/layout.tsx`, `<main id="main-content">` on all pages.

### A-1.3 ARIA Landmarks ✅
| Element | Role |
|---|---|
| `RssSidebar` | `role="navigation" aria-label="Feed navigation"` |
| Article list panel | `role="region" aria-label="Article list"` |
| Article Reader | `role="region" aria-label="Article reader"` |

### A-1.4 Icon-only Buttons ✅
`aria-label` added to all icon buttons in `mobile-bottom-controls.tsx`, `rss-header.tsx`, `article-reader.tsx`, `rss-sidebar.tsx`.

### A-1.5 Keyboard Shortcut Dialog ✅
All shortcut-triggered actions are also reachable via UI.

---

## Sprint A-2: Screen Reader ✅

### A-2.1 Search result count live region ✅
### A-2.2 Unread count badge live region ✅
### A-2.3 Article Reader semantics ✅ (single `<h1>`, proper heading hierarchy, semantic author/date markup)
### A-2.4 Focus management in modals ✅ (focus trap, restore on close)
### A-2.5 Toast/Sonner notifications ✅ (verified with `aria-live="polite"`)

---

## Sprint A-3: Keyboard Navigation ✅

### A-3.1 Feed cards keyboard accessible ✅
### A-3.2 Roving tabindex in feed list ✅
### A-3.3 `@dnd-kit` drag-and-reorder keyboard announcements ✅
### A-3.4 All dialogs closeable with Esc ✅
### A-3.5 Form inputs with labels ✅ (PR #37)

---

## Sprint A-4: Visuals & Contrast 🟡

### A-4.1 Contrast Audit 🟡 — automated on public pages, manual audit of authenticated screens still scheduled v1.2
The `@axe-core/playwright` CI gate (see A-5.2 below) now runs axe's `color-contrast`
check (part of the `wcag2aa`/`wcag21aa` tag set) against every public page on
every PR, so WCAG AA contrast regressions on `/setup`, `/register`, and
`/accessibility` fail the build automatically. This does **not** yet cover
authenticated screens (Home, Feed Management, Server Management, Reader,
Settings) — those need a seeded test user before they can be added to the
e2e suite (see A-5.2). A manual/tooling audit of those screens remains
pending.

Critical areas:
- `text-muted-foreground` on card backgrounds
- `text-muted-foreground/40` chips and tags
- Swipe-progress backdrop
- User-configured accent colors: `getContrastColor` helper from `theme-color-applier.tsx` must be used everywhere accent is a background

Target: WCAG AA (4.5:1 body text, 3:1 large text and UI components).
Tool: axe DevTools, WAVE, or [contrast.tools](https://contrast.tools).

### A-4.2 200% Browser Zoom ⬜ — scheduled v1.2
Test all critical screens at 200% in Chrome and Firefox:
- No horizontal body scrolling
- All actions reachable
- Modals do not overflow viewport

Screens: Home (3-column), Feed Management, Server Management, Reader, Settings.

### A-4.3 Font-Size Slider ✅ (PR #44)
Reader font size configurable via `--reader-font-size` CSS custom property.

### A-4.4 `prefers-contrast: more` ⬜ — post-v1.2
Increase border weight, replace translucent surfaces with solid when OS high-contrast mode is active.

---

## Sprint A-5: Tooling & Process 🟡

### A-5.1 `eslint-plugin-jsx-a11y` ✅
Active in `.eslintrc.json`.

### A-5.2 `@axe-core/playwright` in CI ✅ (public pages)
Implemented in [`e2e/accessibility.spec.ts`](../e2e/accessibility.spec.ts) using
`AxeBuilder` (the maintained `@axe-core/playwright` integration, not the
older `axe-playwright`/`checkA11y`). Runs in a dedicated `accessibility` job
in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) on every PR.

Checks WCAG 2.1 A/AA (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` tags,
including `color-contrast`) and fails the build on any `serious`/`critical`
violation; `minor`/`moderate` findings are logged but not yet gated (that
threshold can be tightened once the backlog of lower-severity findings is
cleared).

Screens covered: `/setup`, `/register`, `/accessibility` — the pages an
unauthenticated visitor actually reaches on a fresh install (see the
route-discovery comment at the top of the spec file for why `/` and `/login`
aren't audited separately: both redirect client-side to `/setup` when no
user exists yet, so there's no distinct page content to check).

**Follow-up (not yet done):** authenticated screens (Home, Feed Management,
Server Management, Reader, Settings) are NOT covered. That requires CI to
seed a test user (and a signed-in session) before running the spec — e.g. a
Prisma seed script plus a Playwright `storageState`/login helper — which is
out of scope for this pass.

### A-5.3 `/accessibility` Statement Page ✅
Public page listing supported features, known gaps, WCAG 2.2 AA goal, and how to report issues.

---

## Post-v1.2 Backlog

- High-contrast theme variant (ties into 2.7 Theming)
- Full RTL (Arabic, Hebrew, Persian) — foundation in place, completion in v1.1 i18n
- Screen reader smoke tests in release checklist (NVDA+Chrome, VoiceOver+Safari)
- Configurable swipe sensitivity (motor accessibility)
- "Confirm before destructive action" user preference

---

## References

- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [WAI-ARIA Authoring Practices Guide](https://www.w3.org/WAI/ARIA/apg/)
- [Inclusive Components](https://inclusive-components.design/)
- [A11y Project Checklist](https://www.a11yproject.com/checklist/)
- [axe-core](https://github.com/dequelabs/axe-core)
