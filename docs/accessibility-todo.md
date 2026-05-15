# Accessibility (a11y) — Todo & Ideas

Status: research only. Nothing here is implemented yet. Pick items in priority
order when planning work.

## Scope

FeedFerret is consumed on desktop browsers, tablets, mobile (Android/iOS) and
as an installed PWA. The goal is conformance with WCAG 2.2 AA where reasonable,
covering motor, visual, cognitive and screen-reader users.

## Quick wins (low risk, high impact)

- **Keyboard map dialog**: already exists. Audit each shortcut for a visible
  focus indicator and ensure every action it triggers is also reachable from
  the regular UI.
- **`prefers-reduced-motion`**: gate animations in `globals.css`
  (`animate-fade-in`, `animate-slide-in-right`, swipe progress transforms,
  pull-to-refresh translate) behind `@media (prefers-reduced-motion: no-preference)`.
- **Skip link** (visible on focus) above `RssSidebar` that jumps to
  `<main role="main">` for keyboard users on the home page.
- **Explicit landmarks**: tag the three columns as `role="navigation"`
  (sidebar), `role="region" aria-label="Article list"` (feed view), and
  `role="region" aria-label="Article reader"` (reader). Currently only the
  outer page has implicit structure.
- **Color-contrast pass**: muted-foreground over card backgrounds, the
  `text-muted-foreground/40` chips, and the swipe-progress backdrops should
  be re-measured. Several places use the user-set accent without a contrast
  check; reuse the `getContrastColor` helper in `theme-color-applier.tsx`.
- **`aria-label` on icon-only buttons** in `mobile-bottom-controls.tsx`,
  `rss-header.tsx`, and `article-reader.tsx`. Most are labelled already;
  do a final sweep with axe or @axe-core/playwright.

## Screen reader / semantics

- Replace decorative emoji feed icons with `aria-hidden="true"` and surface
  the feed name in the accessible name of the row.
- Announce search-result count via an `aria-live="polite"` region so VoiceOver
  / NVDA / TalkBack feedback users know when the result count changes.
- Announce unread-count badge changes (sidebar) as polite live updates.
- Toast/`sonner` notifications: confirm they're rendered into an `aria-live`
  region or wire one up; surface key actions (rule fired, push enabled,
  errors) via this channel.
- Article reader: ensure `h1` is unique on the page, headings step by one
  level only, and the original article URL is exposed as a real link, not
  a `div` with an onClick.

## Keyboard navigation

- The whole feed list must be focusable. Today individual cards rely on
  click handlers; convert the outer `<article>` to a real `<button>` or add
  `tabIndex={0}` + `onKeyDown` for Enter/Space.
- Sidebar drag-to-reorder uses `@dnd-kit`. Verify keyboard sensor wiring
  produces the expected screen-reader announcements ("Picked up feed Y,
  press arrow keys to move…").
- Add a roving-tabindex pattern for the feed list so arrow keys move focus
  between rows without tabbing through every action button.
- Confirm Esc closes every dialog (search modal, keyboard-shortcuts dialog,
  feed edit dialog, alert/rule editor).

## Forms

- Pair every `<Input>` with a `<Label htmlFor>` (or wrap). Several
  `placeholder`-only inputs in settings and rule-creation need explicit
  labels.
- Fieldset/legend the SMTP, AI, and rule-action groups so SR users
  understand boundaries.
- Inline validation errors should reference the input via `aria-describedby`
  and `aria-invalid`.

## Visual / low-vision

- High-contrast / "dark-high-contrast" theme variant alongside the existing
  dark mode.
- Font-size slider in reading preferences (small / regular / large /
  x-large) that scales reader typography only, not chrome.
- Optional dyslexia-friendly font (OpenDyslexic / Atkinson Hyperlegible).
- Honour `prefers-contrast: more` by boosting border weights and removing
  translucent surfaces.
- Validate that all UI still works at 200% browser zoom without horizontal
  scrolling on common breakpoints.

## Motor

- Bigger hit targets on mobile bottom bar (currently 40 px; WCAG 2.5.5
  target size AA is 24 px AAA is 44 px — bump to 44 px).
- Configurable swipe sensitivity (or full disable) for the per-article
  star/read gesture and the header feed-switch swipe.
- A "Confirm before destructive action" preference (delete rule, delete
  feed) — partly there for feeds, missing on rules and bulk operations.

## Cognitive

- Reading-mode toggle that strips the article reader to a single column
  with adjustable measure (line-length cap), generous leading, and no
  inline images. Pair with the existing reader-width preference.
- Plain-English mode for the rules tutorial (currently very dense and
  jargon-heavy with operators).
- Persistent "what's new" hint for newly added features so users aren't
  surprised by behaviour changes (e.g., the merge of Rules + Alerts).
- Optional "are you sure?" delays on destructive batch actions
  (mark-all-read with thousands of unread, delete-rule with notifications
  attached).

## Internationalisation / RTL

- The RTL toggle (`User.layoutDirection`) ships as of WP28. Still needed:
  - Audit every `lucide-react` icon for direction: chevrons, back arrows,
    swipe-progress, magic-link wand. Mirror with `rtl:scale-x-[-1]`
    where appropriate.
  - Logical CSS properties (`ms-/me-`, `ps-/pe-`, `start-/end-`) instead
    of `ml-/mr-` and `left/right` in the few places they still appear.
  - The per-article swipe gesture currently hard-codes left = star,
    right = read. Under RTL the user's intuition reverses; swap based on
    `document.documentElement.dir`.
- Translation infrastructure: pick a library (`next-intl`, `react-i18next`),
  extract strings, and start with German + Arabic to cover both LTR and RTL
  in a real localisation.

## Tooling / process

- Run `@axe-core/playwright` against critical screens in CI (login, home,
  manage-feeds, settings, server-settings, article reader).
- Add a manual screen-reader smoke test in `docs/release-checklist.md`
  covering NVDA + Chrome on Windows and VoiceOver + Safari on macOS / iOS.
- Lint rule: enable `eslint-plugin-jsx-a11y` and stop ignoring its warnings.
- Add an "accessibility statement" page at `/accessibility` explaining the
  features available, known limitations, and how to report issues.

## Reference

- WCAG 2.2 — https://www.w3.org/TR/WCAG22/
- WAI-ARIA Authoring Practices — https://www.w3.org/WAI/ARIA/apg/
- MDN Accessibility — https://developer.mozilla.org/en-US/docs/Web/Accessibility
- Inclusive Components — https://inclusive-components.design/
- A11y Project Checklist — https://www.a11yproject.com/checklist/
