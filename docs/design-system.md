# FeedFerret Design System

> Single source of truth for the visual conventions the codebase already follows. It formalizes the scales and component patterns so new code stays consistent instead of drifting. Created 2026-07-15 to close design-audit findings V-14 (radius), V-15 (icon sizes) and V-16 (modal convention) — those audit items were about **documenting** the existing, deliberate scales rather than rewriting them.

All colors, radii and spacing come from the design tokens in [`app/globals.css`](../app/globals.css). Prefer semantic Tailwind classes (`bg-background`, `text-muted-foreground`, `border-border`, …) over hardcoded values so both light and dark themes stay correct — see the token reference at the bottom of `globals.css` and the notes in [`archive/design-audit-todo.md`](archive/design-audit-todo.md).

---

## 1. Border radius

The base token is `--radius: 1rem`, with the shadcn-derived steps `--radius-sm/md/lg/xl` (`globals.css`). On top of that, the app uses an intentional, consistently-reused scale — **not** an accident, which is why it is documented rather than "normalized":

| Class | ~Value | Use for |
|---|---|---|
| `rounded-md` | 0.5rem | Small inline chips, badges, compact controls |
| `rounded-lg` | ~0.875rem | Buttons, inputs, select triggers, small controls |
| `rounded-xl` | ~1.25rem | Standard cards, list rows, popovers, menu surfaces |
| `rounded-2xl` | ~1.5rem | Larger cards, section panels, primary content surfaces |
| `rounded-3xl` / `rounded-[2rem]` | ~1.75–2rem | Full dialogs, sheets, hero/onboarding surfaces, mobile bottom bars |
| `rounded-full` | pill | Avatars, icon-only round buttons, toggle knobs, count pills |

**Guidance for new code**
- Reach for a named step (`rounded-lg`/`xl`/`2xl`/`3xl`) before an arbitrary value.
- The large one-off values (`rounded-[2rem]`, `rounded-[1.5rem]`) are the established "big surface" radius — reuse the existing value in that context (e.g. match the sibling dialog) rather than inventing a new arbitrary radius.
- Buttons/inputs → `rounded-lg`; cards/rows → `rounded-xl`/`2xl`; dialogs/sheets → `rounded-3xl`/`[2rem]`.

---

## 2. Icon sizes

Icons are `lucide-react` SVGs. The app uses three sizes by context; keep to them:

| Class | Size | Use for |
|---|---|---|
| `size-3` (`w-3 h-3`) | 12px | Badge/metadata icons, timestamps, dense inline hints |
| `size-4` (`w-4 h-4`) | 16px | **Default** — form-field icons, inline-with-text icons, buttons, menu items |
| `size-5` (`w-5 h-5`) | 20px | Section/step headers, primary nav, prominent affordances |

Larger avatar/button wrappers (`h-7`/`h-8`/`h-9`) are container sizes, not icon sizes — the icon inside still uses one of the three above.

**Guidance for new code**
- Default to `size-4`. Only go to `size-5` for headers/primary emphasis, `size-3` for badges/metadata.
- Prefer the `size-N` shorthand over `w-N h-N` in new code (both exist in the tree; `size-N` is the direction of travel).
- The `Button` component already enforces `size-4` for un-sized child SVGs — don't override unless the context calls for `size-3`/`size-5`.

---

## 3. Dialogs & modals

Two primitives, chosen by intent — do not hand-roll a modal:

| Primitive | Use when |
|---|---|
| **`Dialog`** (`components/ui/dialog.tsx`) | The user is doing something — editing a feed, viewing settings, running a flow. Dismissible by backdrop/Escape/X. |
| **`AlertDialog`** (`components/ui/alert-dialog.tsx`) | You need an explicit yes/no decision, especially destructive or irreversible ones — delete feed/label/account, revoke token, discard unsaved changes. Not dismissible by backdrop; forces a Cancel/Confirm choice. |

**Conventions**
- Every modal renders through `DialogContent` / `AlertDialogContent` — never a bare positioned `div`.
- Destructive confirms use the destructive button styling (`bg-destructive text-destructive-foreground`) on the confirm action and a clear "Cancel"/"Keep …" on the cancel action. See the delete-feed confirm in [`components/feed-management.tsx`](../components/feed-management.tsx) and the unsaved-changes confirm in [`components/feed-edit-dialog.tsx`](../components/feed-edit-dialog.tsx) as the reference patterns.
- When a form dialog can hold unsaved edits, guard its close with an `AlertDialog` (dirty-check → "Discard unsaved changes?") — pattern established in `feed-edit-dialog.tsx`.
- The frosted-glass surface treatments `.ui-surface` (anchored) and `.ui-floating-surface` (popovers/menus) in `globals.css` are the app's standard elevated-surface look; reuse them instead of ad-hoc gradient/shadow/blur stacks.
- Focus management, Escape handling and scroll-locking come from the Radix primitives — don't reimplement them.

---

## 4. Color & theming (reference)

- Use semantic tokens (`bg-background`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-card`, `bg-muted`, `bg-accent`, `text-primary`, `ring-ring`, sidebar tokens). They have both light and dark definitions in `globals.css`.
- Never hardcode `bg-black`/`text-white`/`text-zinc-*`/hex colors in app UI — they break one of the two themes. (The audit fixed the auth pages that violated this; keep new code compliant.)
- Focus states use `focus-visible:ring-2 focus-visible:ring-ring` — never remove a focus indicator with `focus:ring-0`/`outline-none` without a replacement (WCAG 2.4.7).
- The Google OAuth icon's `#4285F4` is the one sanctioned hardcoded color (mandated brand color).
- Animations are gated behind `@media (prefers-reduced-motion: no-preference)` — keep new motion inside that guard.

---

*This document formalizes existing conventions; it does not mandate a sweeping rewrite. When touching a component, bring it in line with the tables above rather than doing a separate large-scale refactor.*
