# Accessibility (a11y) — Arbeitspakete

Ziel: WCAG 2.2 AA-Konformität. Vollständiger Überblick und Priorisierung für die Pre-Launch-Phase.  
Detaillierte Sprint-Planung steht in `docs/ROADMAP.md` Abschnitt 0.3.

---

## Status

| Sprint | Inhalt | Status |
|---|---|---|
| A-1 Quick Wins | Motion, Skip Link, ARIA Landmarks, Icon Labels | ✅ Implementiert |
| A-2 Screen Reader | Live Regions, Focus Management, Semantik | ✅ Implementiert |
| A-3 Keyboard Navigation | Feed-Karten Tastatur, Artikel-Actions | ✅ Implementiert |
| A-4 Visuals & Kontrast | Kontrast-Audit, Zoom, Font-Slider | ⬜ Offen (post-launch) |
| A-5 Tooling & Prozess | eslint-jsx-a11y ✅, /accessibility-Seite ✅, Playwright axe ⬜ | 🟡 Teilweise |

---

## Sprint A-1: Quick Wins

**Aufwand:** 1–2 Tage | **Priorität:** Hoch (vor Launch)

### A-1.1 `prefers-reduced-motion`

Alle Animationen und Übergänge in `globals.css` und Komponenten hinter die Media Query schieben:

```css
@media (prefers-reduced-motion: no-preference) {
  .animate-fade-in { animation: fade-in 0.2s ease; }
  .animate-slide-in-right { animation: slide-in-right 0.2s ease; }
  /* Swipe-Progress Transforms */
  /* Pull-to-Refresh translate */
}
```

Betroffen: `globals.css`, `mobile-bottom-controls.tsx` (Swipe-Animationen), Pull-to-Refresh.

### A-1.2 Skip Link

Sichtbarer Focus-Link ganz oben in der App-Shell, vor der `RssSidebar`:

```html
<a href="#main-content" class="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 ...">
  Skip to content
</a>
```

`<main>` braucht `id="main-content"` und `role="main"`.

### A-1.3 ARIA Landmarks

Drei Hauptbereiche explizit auszeichnen:

| Element | Rolle |
|---|---|
| `RssSidebar` | `role="navigation" aria-label="Feed navigation"` |
| Artikel-Listen-Panel | `role="region" aria-label="Article list"` |
| Article Reader | `role="region" aria-label="Article reader"` |

### A-1.4 Icon-only Buttons — Systemischer Sweep

Komponenten prüfen und fehlende `aria-label`s ergänzen:

- `mobile-bottom-controls.tsx` — alle Buttons
- `rss-header.tsx` — Refresh, Filter, Sort
- `article-reader.tsx` — Star, Mark-Read, External-Link, Summary-Button
- `rss-sidebar.tsx` — Add Feed, Settings, Feed-Action-Buttons

Tool: `npx axe-core` oder Browser-DevTools Accessibility Panel.

### A-1.5 Keyboard-Shortcut-Dialog Audit

Jede Aktion, die per Keyboard-Shortcut ausgelöst werden kann, muss auch per UI erreichbar sein (WCAG 2.1.1). Systematisch prüfen.

---

## Sprint A-2: Screen Reader Basics

**Aufwand:** 2–3 Tage | **Priorität:** Hoch (vor Launch)

### A-2.1 Suchergebnis-Count Live Region

VoiceOver/NVDA/TalkBack müssen hören, wenn sich die Artikel-Anzahl ändert:

```html
<div aria-live="polite" aria-atomic="true" class="sr-only">
  {count} articles found
</div>
```

Ort: über der Artikel-Liste, aktualisiert wenn `filteredArticles.length` sich ändert.

### A-2.2 Unread-Count-Badge Live Region

Sidebar-Badge-Änderungen ankündigen:

```html
<span aria-live="polite" aria-label={`${unreadCount} unread articles`}>
  {unreadCount}
</span>
```

### A-2.3 Article Reader Semantik

- `<h1>` im Reader muss eindeutig auf der Seite sein (nicht mehrfach)
- Überschriften im Artikel-Content: Hierarchie muss korrekt sein (h1 → h2 → h3, keine Sprünge)
- Original-URL: Muss ein echtes `<a href="...">` sein, kein `div` mit onClick
- Autor, Feed-Name, Datum: Semantisch korrekt markieren

### A-2.4 Focus Management bei Modals

- Modal öffnen → Focus muss ins Modal wandern (auf erstes interaktives Element oder `[role="dialog"]`)
- Modal schließen → Focus muss zum auslösenden Button zurückwandern
- Focus darf nicht aus dem Modal heraus "entkommen" (Focus Trap)

Betroffen: Feed Edit Dialog, Server Management, Feed Management, Search Modal.

### A-2.5 Toast/Sonner Notifications

Prüfen ob Toasts in einem `aria-live="assertive"` (Fehler) oder `aria-live="polite"` (Erfolg) Container gerendert werden. Sonner nutzt ggf. bereits eine Live Region — verifizieren.

---

## Sprint A-3: Keyboard Navigation

**Aufwand:** 2–3 Tage | **Priorität:** Mittel (vor Launch)

### A-3.1 Feed-Karten per Tastatur bedienen

Aktuell sind Feed-Karten nur per Click auswählbar. Lösung:

```tsx
<article
  tabIndex={0}
  role="button"
  onKeyDown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') handleSelect();
  }}
>
```

Alternativ: `<button>` als Wrapper.

### A-3.2 Roving Tabindex für Feed-Liste

Statt Tab durch jedes Element → Pfeiltasten navigieren zwischen Feed-Zeilen:

- Tab → fokussiert die Liste
- ArrowDown/Up → navigiert zwischen Feeds
- Enter/Space → wählt Feed aus
- Tab innerhalb einer Zeile → zwischen Action-Buttons

Referenz: [WAI-ARIA Listbox Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/)

### A-3.3 `@dnd-kit` Drag-and-Reorder — Keyboard-Verification

Testen ob die Keyboard-Sensoren von `@dnd-kit` korrekte Screen-Reader-Announcements produzieren:
- "Picked up feed X, press Arrow keys to move, press Space or Enter to drop, press Escape to cancel"
- Docs: https://docs.dndkit.com/api-documentation/sensors/keyboard

### A-3.4 Alle Dialoge per Esc schließbar

Systematischer Test: jeden Dialog öffnen, Esc drücken. Betrifft:
- Search Modal, Keyboard-Shortcut-Dialog, Feed Edit Dialog, Alert/Rule Editor, Delete-Confirmations, Server Management, Feed Management

### A-3.5 Form Inputs mit Labels ✅ Implementiert (PR #37)

Alle `<Input>` und `<Select>` in Settings, Feed-Management und Setup mit `htmlFor`/`id`-Assoziierungen versehen. Betroffene Bereiche: Accent Colors, Push Frequency, 2FA, Digest Settings, AI Settings, Category Settings, Keyword Alerts, Auto-Read-Rules, Setup Wizard.

---

## Sprint A-4: Visuals & Kontrast

**Aufwand:** 1–2 Tage | **Priorität:** Mittel

### A-4.1 Kontrast-Audit

Tools: axe DevTools, WAVE, oder [contrast.tools](https://contrast.tools)

Kritische Stellen:
- `text-muted-foreground` auf Card-Backgrounds
- `text-muted-foreground/40` Chips und Tags
- Swipe-Progress-Backdrop
- User-konfigurierter Accent-Color: `getContrastColor`-Helper aus `theme-color-applier.tsx` überall einsetzen wo Accent als Background verwendet wird

Ziel: WCAG AA (4.5:1 für Fließtext, 3:1 für großen Text und UI-Komponenten)

### A-4.2 200% Browser-Zoom

Alle kritischen Screens bei 200% Browser-Zoom testen (Chrome/Firefox):
- Kein horizontales Body-Scrolling
- Alle Aktionen weiterhin erreichbar
- Modals/Dialoge brechen nicht aus dem Viewport

Kritische Screens: Home (3-Spalten), Feed Management, Server Management, Reader, Settings.

### A-4.3 Font-Size-Slider im Reader

Reader-Typografie skalierbar machen ohne Chrome zu ändern:

```tsx
// User-Setting: readerFontSize: 'sm' | 'base' | 'lg' | 'xl'
// Implementierung via CSS Custom Property: --reader-font-size
```

Optional: Dyslexia-freundliche Schrift (OpenDyslexic oder Atkinson Hyperlegible) als Setting.

### A-4.4 `prefers-contrast: more`

Optional für post-Launch: Bei `@media (prefers-contrast: more)` Border-Stärken erhöhen, transluzente Surfaces durch solide ersetzen.

---

## Sprint A-5: Tooling & Prozess

**Aufwand:** 1 Tag | **Priorität:** Mittel

### A-5.1 `eslint-plugin-jsx-a11y` aktivieren

In `.eslintrc.json`:

```json
{
  "extends": ["next/core-web-vitals", "plugin:jsx-a11y/recommended"],
  "plugins": ["jsx-a11y"]
}
```

`pnpm add -D eslint-plugin-jsx-a11y`, Warnungen beheben.

### A-5.2 `@axe-core/playwright` in CI

```typescript
// e2e/accessibility.spec.ts
import { checkA11y } from 'axe-playwright';

test('Home page has no accessibility violations', async ({ page }) => {
  await page.goto('/');
  await checkA11y(page, null, {
    detailedReport: true,
    detailedReportOptions: { html: true }
  });
});
```

Kritische Screens: Login, Home, Feed Management, Settings, Reader.

### A-5.3 `/accessibility` Statement-Seite

Öffentliche Seite auf `/accessibility`:
- Welche Features vorhanden sind (Shortcuts, Landmarks, etc.)
- Bekannte Einschränkungen
- Wie man Feedback gibt / Issues meldet
- WCAG 2.2 AA als Ziel angeben

---

## Referenzen

- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [WAI-ARIA Authoring Practices Guide](https://www.w3.org/WAI/ARIA/apg/)
- [MDN Accessibility](https://developer.mozilla.org/en-US/docs/Web/Accessibility)
- [Inclusive Components](https://inclusive-components.design/)
- [A11y Project Checklist](https://www.a11yproject.com/checklist/)
- [axe-core](https://github.com/dequelabs/axe-core)

## Langfristig (Post-Launch)

- High-Contrast-Theme-Variante
- RTL-Vollständigkeit (Arabisch, Hebräisch, Persisch) — Grundlage vorhanden
- Internationalisierung (i18n) mit `next-intl`
- Screen-Reader-Smoke-Tests im Release-Checklist (NVDA+Chrome, VoiceOver+Safari)
- Konfigurierbare Swipe-Empfindlichkeit (für motorische Einschränkungen)
- "Bestätigung vor destruktiver Aktion" Präferenz
