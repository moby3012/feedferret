# FeedFerret Roadmap

> Zuletzt aktualisiert: 2026-05-18 (v1.0.0 — Public Release)  
> Aktueller Status: **🚀 v1.0.0 Released — Post-Launch-Betrieb**

## Status-Übersicht (Stand 2026-05-18 — v1.0.0)

| Bereich | Status | Post-Launch |
|---|---|---|
| 🛡️ Security & Hardening | ✅ Abgeschlossen | Observatory-Score messen |
| ♿ Accessibility (WCAG 2.2 AA) | ✅ A1–A3 / 🟡 A4–A5 teilweise | Kontrast-Audit, Roving-Tabindex, axe-Playwright in CI |
| 🎨 UI Polish & UX | ✅ Abgeschlossen | Dark-Mode-Sweep, Landscape-Mode |
| 🐳 Docker & Deployment | ✅ Abgeschlossen | Image-Größe messen |
| 📣 Marketing & SEO | ✅ Landing Page + SEO | Screenshots nach Launch |
| 🔔 Notification-Kanäle | ✅ Telegram, Gotify, ntfy live | — |
| 📡 Google Reader API | ✅ API-Fixes live | Device-Tests (Reeder, NNW, FeedMe, ReadKit) |
| 🔧 Maintenance & Dependencies | ✅ Dep-Updates, Logger, CI | Major-Upgrades (Prisma 7, Zod 4, ESLint 9) |
| 🧪 Test-Coverage | — | E2E + Unit-Tests (Post-Launch) |
| 🚢 Launch-Operations | ✅ Docs, Support, Changelog, v1.0.0 | Sentry-Setup, Backup-Drill |

**Build-Status:** `pnpm run build` ✅ • `pnpm run lint` ✅ • `tsc --noEmit` ✅ • CI ✅

---

## Abgeschlossene Features (Baseline)

Die folgenden Bereiche sind vollständig implementiert und dokumentiert:

| Feature | Dokumentation |
|---|---|
| RSS/Atom/JSONFeed/HTML/XML Sync | — |
| Multi-User mit Datenisolierung | — |
| Lokale Auth, OAuth (Google/GitHub), Authelia OIDC | `docs/self-hosting-auth-email.md` |
| Optionales TOTP 2FA | `docs/self-hosting-auth-email.md` |
| Advanced Search + Saved Searches | — |
| Saved Search Sharing (öffentliche Seite + RSS) | — |
| Auto-Mark-as-Read Rules mit Preview | — |
| Keyword Alerts (In-App, Push, E-Mail, Webhook) | — |
| Browser Push Notifications + PWA | — |
| AI Article Summaries (BYOK: OpenAI, Anthropic, Gemini, OpenRouter, Ollama) | — |
| Full-Text Extraction (Scout Studio) | `docs/scout-studio.md` |
| Scout Studio Extended OPML Import/Export | — |
| Feed Authentication & Fetch Options | — |
| Retention Policies & Feed Health Dashboard | — |
| Outbound Webhooks (HMAC-signiert, Retry) | `docs/webhooks.md` |
| Duplicate Detection (SHA-256 URL-Hash) | — |
| Feed Discovery (Same-Domain + Starter Packs) | — |
| Google Reader API Compatibility (Phase 1) | `docs/google-reader-api.md` |
| Public REST API v1 + MCP Endpoint | `docs/api.md`, `docs/mcp.md` |
| OPML Import/Export (selektiv) + JSON-Export | — |
| PostgreSQL + SQLite Dual-Provider | `docs/database.md` |
| SSRF-Schutz für Feed-Fetching | `docs/security.md` |
| API Token Hardening (SHA-256, ff_-Prefix) | `docs/security.md` |
| Input Validation (URL, OPML, Search, Labels) | `docs/security.md` |
| Admin & Session Hardening (Audit-Log, 2FA-Pflicht, Session-Invalidierung, Login-Logging) | `docs/security.md` |
| GDPR: Self-Service Account-Deletion | `docs/gdpr.md` |
| Admin Onboarding Wizard (6-Schritte-Wizard + Starter Packs) | — |
| Self-Hosting & Reverse Proxy Guide | `docs/self-hosting.md`, `docs/reverse-proxy.md` |
| SaaS Provisioning API (Internal API) | `docs/internal-api.md` |
| Admin: Instance Branding, Starter Packs, User-Verwaltung | `docs/admin-customization.md` |
| Unified Settings Shell UX | `docs/unified-settings-ux.md` |
| Mobile UX (Bottom Navigation, Swipe-Gesten, PWA) | — |
| E-Mail-Digests (SMTP, Resend, Postmark, Mailgun, SendGrid) | — |
| Keyboard Shortcuts | — |
| Dark Mode + Dynamic Theming (Accent Colors) | — |

---

## Phase 0: Pre-Launch (Aktiver Sprint)

Ziel: Produkt in Produktionsreife bringen. Fokus auf Qualität, Sicherheit und Positionierung — keine großen neuen Features.

---

### 0.1 Wettbewerbsanalyse & Feature Intelligence

**Ziel:** Informierte Entscheidungen für Pre-Launch-Priorisierung und Positionierung treffen.

#### 0.1.1 Primäre Wettbewerber kartieren

Markt-Segmente und relevante Player:

| Segment | Player |
|---|---|
| SaaS RSS-Reader | Feedly, Inoreader, NewsBlur, The Old Reader |
| Self-Hosted RSS | Miniflux, FreshRSS, Tiny Tiny RSS, Selfoss, Yarr |
| Read-Later / Research | Readwise Reader, Matter, Omnivore (OSS, archived) |
| Native RSS Clients | Reeder 5/6, NetNewsWire, Lire, ReadKit, FeedMe (Android) |
| AI-enhanced Reading | Readwise, Feedly AI, Artifact (App) |

Deliverable: Vergleichstabelle Features × Wettbewerber als `docs/competitor-analysis.md`.

#### 0.1.2 Feature-Gap-Analyse

- Alle Features identifizieren, die Top-3-Wettbewerber bieten, FeedFerret nicht.
- Jedes Gap nach **Kundennutzen** (1–5) × **Implementierungsaufwand** (Low/Med/High) gewichten.
- Quick-Wins (Hoher Nutzen, geringer Aufwand) für Pre-Launch-Berücksichtigung markieren.
- Must-haves vs. Nice-to-haves vs. Differenzierings-Features trennen.

Deliverable: Priorisierte Gap-Liste in `docs/competitor-analysis.md`.

#### 0.1.3 Preismodell & Tier-Analyse

- Preismodelle der Wettbewerber dokumentieren (Free, Personal, Pro, Team, Enterprise).
- Feature-Gating-Strategie: Was ist kostenlos (Self-Hosted), was ist SaaS-exklusiv?
- Empfehlung für FeedFerret SaaS Pricing-Tiers ableiten.
- Stripe-Integration-Implikationen prüfen (Internal API bereits vorbereitet).

Deliverable: Pricing-Empfehlung als Abschnitt in `docs/competitor-analysis.md`.

#### 0.1.4 UX-Benchmark

- Onboarding-Flow bei Feedly, Inoreader, Miniflux screenshotten/dokumentieren.
- Mobile UX der Top-3 vergleichen (Gesten, Navigation, Reader-Komfort).
- 5–10 konkrete UX-Verbesserungsideen ableiten (für Phase 0.4 Polish).
- Besondere Stärken und Schwächen von FeedFerret ehrlich bewerten.

Deliverable: UX-Benchmark-Abschnitt in `docs/competitor-analysis.md`.

#### 0.1.5 Positionierungs-Schärfung

- Einzigartigen Differenziator schärfen: Self-Hosted + Modern UX + Power-User-Depth.
- Primäre Zielgruppe priorisieren (Homelab-User, Teams, Migrations-Kandidaten von Feedly?).
- Key Messages für Landing Page und ProductHunt finalisieren.

Deliverable: Positionierungsbriefing als Abschnitt in `docs/marketing-landing-page-brief.md`.

---

### 0.2 Security & Hardening

**Ziel:** Produktionsreife Sicherheit. Keine bekannten kritischen Schwachstellen zum Launch.

#### 0.2.1 Rate Limiting ✅ Implementiert

Schutz vor Brute-Force, Credential-Stuffing und API-Abuse.

Implementierung: In-Memory Sliding Window in `lib/rate-limit.ts` (bereits vorhanden, um neue Presets erweitert).

| Endpoint-Gruppe | Limit | Fenster | Status |
|---|---|---|---|
| `POST /api/auth/*` (Sign-In) | 10 Versuche | 15 Minuten | ✅ |
| Magic Link Requests | 3 Versuche | 10 Minuten | ✅ |
| `POST /api/mcp` | 100 Requests | 1 Minute | ✅ |
| `POST /api/internal/*` | 30 Requests | 1 Minute | ✅ |
| `GET /api/v1/*` (lesend) | 200 Requests | 1 Minute | ✅ in Route-Handler verdrahtet |
| `POST /api/v1/*` (schreibend) | 60 Requests | 1 Minute | ✅ in Route-Handler verdrahtet |

- [x] Rate Limiting auf alle `/api/v1/*` Routen angewendet (per-user, in `app/api/v1/[...path]/route.ts`)
- [x] Rate-Limit-Headers (`X-RateLimit-Remaining`, `X-RateLimit-Reset`) in allen Responses

#### 0.2.2 Security Headers ✅ Implementiert

In `next.config.mjs` via `headers()` — gilt für alle Routen:

```
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; ...
```

HSTS wird über den Reverse Proxy (Nginx/Caddy/Traefik) gesetzt.

Offene Follow-ups:
- [ ] Mozilla Observatory Score messen (Ziel ≥ B+)
- [ ] CSP schrittweise von `unsafe-inline`/`unsafe-eval` befreien (erfordert Nonce-basiertes Next.js Setup)

#### 0.2.3 API Token Hardening ✅ Implementiert

- [x] Token-Hashing: SHA-256 des Tokens in DB gespeichert (`lib/token.ts`)
- [x] Token-Präfix `ff_` + base64url(32 Random-Bytes) — leicht erkennbares Format
- [x] Token nur einmalig beim Erstellen anzeigen ✓ (war bereits implementiert)
- [x] Token-Rotation invalidiert sofort den alten Token (neues POST überschreibt Hash)
- [ ] Optional: Token-Ablaufdatum konfigurierbar (Zukunft)

⚠️ Breaking Change: Bestehende Plain-Text-Tokens werden ungültig — Nutzer müssen Token neu generieren.

#### 0.2.4 Input Validation Audit ✅ Implementiert

- [x] `lib/validation.ts` mit zentralen Limits erstellt (URL 2 KB, OPML 5 MB, Label 100 Zeichen, Search 1000 Zeichen)
- [x] Feed URL Format-Validierung vor SSRF-Check (server action + API v1)
- [x] OPML Import: 5-MB-Größenlimit in Server Action und API v1
- [x] Search Query: Max. 500 Zeichen im Discovery-Endpoint
- [x] Label-Namen: Max. 100 Zeichen
- [x] Saved Search Name/Query: Max. 255 / 1000 Zeichen
- [ ] Vollständige Zod-Schemas für alle Server Actions (Zukunft — größerer Refactor)

#### 0.2.5 Dependency Audit & Updates ✅ Teilweise implementiert

- [x] High CVE `glob`: via `pnpm.overrides` auf ≥10.5.0 gepatcht (war bereits vorhanden)
- [x] Moderate CVE `postcss`: via `pnpm.overrides` auf ≥8.5.14 gepatcht (war bereits vorhanden)
- [x] `eslint-config-next` 14.2.23 → 14.2.35 (neuestes ESLint-8-kompatibles Release)
- [x] Node.js 22-slim im Dockerfile ✓ (bereits LTS)
- [ ] ESLint 8 → 9 + Flat Config Migration nötig für eslint-config-next 16.x (eigenes Arbeitspaket)
- [ ] Prisma 5.x → 6.x/7.x: Breaking-Change-Analyse ausstehend
- [ ] next-auth beta.31 → stable 5.0.0: Kompatibilitätsprüfung ausstehend

#### 0.2.6 Admin & Session Hardening ✅ Implementiert

- [x] 2FA-Pflicht für Admin-Accounts als Server-Setting konfigurierbar machen (`require2FAForAdmins` in GlobalSettings, geprüft in `checkAdmin()`)
- [x] Audit-Log für Admin-Aktionen: User löschen, Rollen ändern, Settings ändern (`AdminAuditLog`-Tabelle, `logAdminAction()` Helper in `admin.ts`)
- [x] Session-Invalidierung nach 2FA-Aktivierung/-Deaktivierung (JWT `sessionVersion`-Pattern — `token.sv` vs `user.sessionVersion`)
- [x] Fehlgeschlagene Login-Versuche loggen (User-ID, IP, Timestamp) — `LoginAttempt`-Tabelle, befüllt in `authorize()`-Callback in `auth.ts`
- [x] Admin-UI: Audit-Log-Tab in Server Management Dialog (Admin Actions + Login Attempts Tabellen)

#### 0.2.7 Docker & Deployment Security ✅ Implementiert

- [x] **Postgres-Port:** Erklärender Kommentar in `docker-compose.yaml` ergänzt ("For public servers: remove or comment out this entry")
- [x] **Healthcheck für FeedFerret-Service** hinzugefügt: `curl -f http://localhost:3000/api/health` mit 30s Interval, 60s Start-Period
- [x] **`/api/health` Endpoint** implementiert (`app/api/health/route.ts`): gibt `{ status, db, version, uptime }` zurück; HTTP 503 wenn DB nicht erreichbar
- [x] **Default-Passwort-Warnung** in `instrumentation.ts`: Startup-Log warnt bei `POSTGRES_PASSWORD=feedferret-change-me`, kurzem `AUTH_SECRET` und Placeholder-URLs
- [x] **SQLite Volume** als Kommentar in `docker-compose.yaml` ergänzt (auskommentiert, Anleitung vorhanden)

#### 0.2.8 Secrets & Environment Validation ✅ Implementiert

- [x] **Startup-Validation** in `instrumentation.ts`: Prüft `AUTH_SECRET` (Länge ≥ 32, kein Placeholder), `POSTGRES_PASSWORD` (kein Default), `AUTH_URL` (kein Placeholder). Klare `⚠️`-Warnungen im Server-Log.
- [x] Prisma Query Logging: nur `"error"` level in Production (`lib/db.ts`)
- [x] `AUTH_URL` Format-Validierung: Startup-Check auf Placeholder-URLs in `instrumentation.ts`

---

### 0.3 Accessibility (WCAG 2.2 AA)

**Ziel:** Grundlegende WCAG 2.2 AA-Konformität zum Launch. Vollständige Details in `docs/accessibility-todo.md`.

#### Sprint A-1: Quick Wins ✅ Implementiert (PR #35)

- [x] `prefers-reduced-motion`: Alle Animationsklassen hinter `@media (prefers-reduced-motion: no-preference)` in `globals.css`
- [x] **Skip Link:** Focus-Link "Skip to content" in `layout.tsx`, sichtbar bei Keyboard-Fokus
- [x] **ARIA Landmarks:** `role="navigation"` (Sidebar), `role="region" aria-label="Article list"` (Feed-View), `role="region" aria-label="Article reader"` (Reader) — Desktop + Mobile
- [x] **Icon-only Buttons:** Systematischer `aria-label`-Sweep in `rss-header.tsx`, `article-reader.tsx`, `rss-sidebar.tsx`, `mobile-bottom-controls.tsx`
- [ ] Keyboard-Shortcut-Dialog: Jede Aktion muss auch per normaler UI erreichbar sein

#### Sprint A-2: Screen Reader ✅ Implementiert (PR #35)

- [x] `aria-live="polite"` Region für Unread-Count in `page.tsx`
- [x] `aria-live` für Unread-Count-Badge-Änderungen in Sidebar
- [x] Article Reader: `<h1 id>` + `aria-labelledby`, Autor in `<address>`, Datum in `<time>`
- [x] Focus Management: Radix UI-Dialoge (Dialog, DropdownMenu, Sheet) trappen Focus automatisch
- [ ] Toast/Sonner: `aria-live`-Region verifizieren (Sonner nutzt intern eine Live Region — noch nicht auditiert)

#### Sprint A-3: Keyboard Navigation ✅ Implementiert (PR #35)

- [x] Artikel-Karten: `tabIndex={0}` + `role="button"` + `onKeyDown Enter/Space` in allen drei View-Modi + `focus-visible:ring`
- [x] `aria-pressed` auf allen Toggle-Buttons (Star, Read-Later, Read/Unread, Filter)
- [ ] Roving-Tabindex-Pattern für Feed-Sidebar-Liste (Pfeiltasten zwischen Zeilen)
- [ ] `@dnd-kit` Drag-and-Reorder: Keyboard-Sensor-Wiring und Screen-Reader-Announcements verifizieren
- [ ] Alle Dialoge per `Esc` schließbar (systematischer manueller Test)

#### Sprint A-4: Visuals & Kontrast 🟡 Teilweise implementiert

- [x] Font-Size-Slider für Reader-Typografie (small / medium / large / xl) — `readerFontSize` in User-Schema, Settings → Appearance, `ArticleReader`-Prop
- [ ] Kontrast-Audit: `text-muted-foreground` Varianten auf allen Backgrounds messen
- [ ] `getContrastColor` Helper bei User-Accent-Colors durchsetzen
- [ ] 200% Browser-Zoom: Alle kritischen Screens ohne horizontales Scrollen

#### Sprint A-5: Tooling & Prozess 🟡 Teilweise

- [x] `eslint-plugin-jsx-a11y` installiert und in `.eslintrc.json` aktiviert
- [x] `/accessibility` Seite erstellt (`app/accessibility/page.tsx`)
- [ ] `@axe-core/playwright` für kritische Screens in CI (Login, Home, Reader, Settings)

---

### 0.4 UI Polish & UX-Verfeinerung

**Ziel:** Produktionsreifes Look & Feel. Keine groben Unebenheiten im UX-Flow.

#### 0.4.1 Empty States ✅ Implementiert (PR #37)

- [x] Konsistente Empty-State-Komponente (Icon + Headline + CTA) für: leere Feed-Liste, keine Artikel in View, keine Labels, keine Alerts, keine Rules, keine Saved Searches
- [x] Jeder Empty State hat einen klaren nächsten Schritt ("Add your first feed", "Create a label", etc.)
- [x] Server-Management Users-Suche ohne Treffer
- [x] Shared Search Page

#### 0.4.2 Loading States & Error Handling ✅ Implementiert

- [x] Skeleton-Loader für initiales Laden der Artikelliste (List, Magazine, Minimal View) — `ArticleSkeleton` Komponente in `article-list.tsx`
- [x] Optimistic Updates für Read/Star/Later (bereits vorhanden über `sessionReadArticles` State)
- [x] Handlungsorientierte Fehlermeldungen in allen `use-rss-data.ts` Mutations
- [x] Sync-Fehler-Feedback: Feed-Karten zeigen bereits `AlertCircle` wenn `lastStatus="error"` (war implementiert)
- [x] Netzwerkfehler im Article-Reader: "No content available" Empty State mit Link zum Original-Artikel

#### 0.4.3 Onboarding-Flow Review ✅ Implementiert

- [x] Alle 6 Setup-Wizard-Schritte vollständig implementiert (account → instance → email → security → starters → done)
- [x] Copy verbessert: prägnanter, nutzerfreundlicher
- [x] Post-Setup: Nutzer direkt in "Feed hinzufügen"-Flow geleitet (`/?addFeed=1`)
- [x] Starter Pack Auswahl als eigener Schritt im Setup-Wizard (Schritt 5)
- [ ] Erste-Sync-Erlebnis: Animiertes Feedback während Feeds laden

#### 0.4.4 Feed-Sync-Status-Verbesserungen ✅ Implementiert (PR #37)

- [x] Visuelles Feedback im Header während globaler Sync läuft (isRefreshing → Spin)
- [x] Letzte Sync-Zeit im Refresh-Button Tooltip ("Last synced HH:MM")
- [x] Per-Feed Fehler-Indikator in Feed-Liste (AlertCircle wenn lastStatus = "error")

#### 0.4.5 Notification UX ✅ Implementiert (PR #37)

- [x] Bell-Menu: "Alle als gelesen markieren" Button (Desktop + Mobile)
- [x] Notification-Typen visuell unterscheiden: keyword_alert → Bell, rule_match → Play, feed_error → AlertCircle, digest_sent → Mail
- [x] Leere Notifications-Ansicht mit Hinweis auf Keyword Alerts

#### 0.4.6 Dark Mode & Theming Audit (Aufwand: 1 Tag)

- [ ] Systematischer Dark-Mode-Sweep aller Komponenten (axe Kontrast oder visuell)
- [ ] Accent-Color-Kontrast: `getContrastColor`-Helper überall einsetzen
- [ ] `prefers-color-scheme` System-Theme korrekt als Default respektieren

#### 0.4.7 Copy & Microcopy ✅ Implementiert

- [x] Fehlermeldungen: Alle generischen Fallbacks in `use-rss-data.ts` handlungsorientiert formuliert ("Check your connection and try again", "Check the code and try again", etc.)
- [x] Destruktive Aktionen: Feed-Löschen nutzt `AlertDialog` mit Konsequenz-Beschreibung statt `window.confirm()`
- [ ] Weitere Stellen (Label, Category löschen) auf AlertDialog-Muster prüfen
- [ ] Tooltips auf Icon-Buttons ohne Text: Alle haben `title` oder `aria-label`

#### 0.4.8 Mobile UX Final Pass ✅ Implementiert

- [x] Hit-Targets: Mobile Bottom Controls und Article Reader Buttons auf 44×44 px (h-11 w-11) erhöht
- [x] Safe Area Insets: `env(safe-area-inset-bottom)` bereits in allen Mobile-Komponenten vorhanden
- [ ] Swipe-Gesten: Edge-Case bei sehr schnellem Swipe (manuelle Tests empfohlen)
- [ ] Landscape-Mode: Manuelle Prüfung empfohlen

---

### 0.5 Docker Deployment & Dokumentation Review

**Ziel:** Problemloser Self-Hosting-Einstieg, fehlerfreie Docker-Deployments, vollständige Onboarding-Doku.

#### 0.5.1 Dockerfile Audit ✅ Implementiert

- [x] **Stages aufgetrennt:** `base-runtime` (nur openssl + curl) und `base-build` (+ python3, make, g++) — Build-Tools landen nicht mehr im Runner-Image
- [x] **`libvips-dev` entfernt:** War nicht als Abhängigkeit benötigt (kein `sharp` im Projekt)
- [x] **Prisma aus deps-Stage kopiert:** `COPY --from=deps /app/node_modules/prisma` statt `npm install -g prisma` — spart globalen Install-Schritt und hält Versionen automatisch synchron
- [x] **Node.js 22-slim:** Aktuelles LTS — keine Änderung nötig
- [ ] **Image-Größe messen:** Ziel < 400 MB — lokales Messen nach nächstem Build empfohlen

#### 0.5.2 docker-compose.yaml Verbesserungen ✅ Implementiert (PR #35 + PR #37)

- [x] **Postgres Port:** `"${POSTGRES_PORT:-5432}:5432"` mit erklärendem Kommentar
- [x] **FeedFerret Healthcheck:** `curl -f http://localhost:3000/api/health`, 30s Interval, 60s Start-Period
- [x] **SQLite Volume** als Kommentar (opt-in)
- [x] **Explizites Netzwerk:** `feedferret_net` Bridge-Netzwerk für Service-Isolation

#### 0.5.3 `start.sh` Audit ✅ Implementiert (PR #37)

- [x] `set -e` stellt sicher dass Fehler (inkl. `prisma db push`) die App-Start verhindern
- [x] Timestamps in allen Startup-Log-Meldungen via `log()` Helper
- [x] Exit-Codes korrekt über `set -e` + explizite `exit 1`

#### 0.5.4 `/api/health` Endpoint ✅ Implementiert

- [x] `GET /api/health` implementiert: `{ "status": "ok", "db": "ok", "version": "...", "uptime": N }`
- [x] DB-Ping-Check eingebaut — HTTP 503 wenn Datenbank nicht erreichbar
- [x] Als Docker-Healthcheck-Target in `docker-compose.yaml` eingetragen

#### 0.5.5 Coolify & Reverse Proxy Dokumentation ✅ Abgeschlossen (2026-05-18)

- [x] Coolify-Guide in `docs/self-hosting.md` vollständig ausgebaut — Step-by-Step mit Schritt-für-Schritt-Anleitung
- [x] Häufige Probleme als Troubleshooting-Tabelle: `AUTH_TRUST_HOST`, Gateway Timeout, DB-Passwort-Mismatch, Force-Rebuild
- [x] **Neues Dokument:** `docs/reverse-proxy.md` mit Nginx, Caddy und Traefik Beispiel-Configs
- [x] HSTS, HTTP→HTTPS Redirect, WebSocket dokumentiert

#### 0.5.6 Self-Hosting Guide & Onboarding Doku ✅ Implementiert

- [x] **Neues Dokument:** `docs/self-hosting.md` — vollständiger Guide: Anforderungen, Installation, Konfiguration, Updates, Backup
- [x] `.env.example` überarbeitet: Pflichtfelder oben mit `← change this!`-Hinweisen, optionale Felder gruppiert, SMTP-Sektion ergänzt, klarere Kommentare
- [ ] README Quick-Start auf < 5 Minuten optimieren: Nur das Nötigste, Links für Details
- [x] Upgrade-Prozedur dokumentiert: `git pull && docker compose up -d --build`
- [x] Backup-Anleitung in Self-Hosting-Guide eingebaut

---

### 0.6 Marketing & SaaS Landing Page

**Ziel:** Startklar für Launch-Marketing. Landing Page Content finalisiert, Screenshots bereit.

#### 0.6.1 Marketing Brief aktualisieren (Aufwand: 0.5 Tage)

- [ ] `docs/marketing-landing-page-brief.md` mit allen seit letztem Update hinzugekommenen Features ergänzen:
  - AI Article Summaries (BYOK)
  - Outbound Webhooks
  - Keyword Alerts (vollständig)
  - Duplicate Detection
  - Feed Discovery + Starter Packs
  - MCP Endpoint für AI-Agenten
  - Admin Customizable Starter Packs
- [ ] Dokument als Vorlage für Landing-Page-Texter/Designer strukturieren
- [ ] Pricing-Empfehlung aus Wettbewerbsanalyse einarbeiten

#### 0.6.2 Landing Page Sektion-Architektur (Aufwand: 0.5 Tage)

Empfohlene Sektion-Reihenfolge:

1. **Hero:** Headline, Subline, CTA (Demo / Self-Host), Hero-Screenshot
2. **Social Proof:** "Trusted by X self-hosters" / GitHub Stars / frühe Nutzer-Quotes
3. **Product Promise:** 3 Kernwerte (Privat, Modern, Mächtig)
4. **Reading Experience:** Screenshots Reader Desktop + Mobile
5. **Mobile & PWA:** iPhone/Android Screenshots, "Feels like a native app"
6. **Power-User Features:** Suche, Rules, Alerts, Labels, Webhooks, API
7. **Native Client Compat:** Google Reader API → Reeder, NetNewsWire, etc.
8. **Self-Hosting:** Docker one-liner, Coolify-Screenshot, "Your server, your data"
9. **Auth & Security:** SSO, 2FA, GDPR, per-user isolation
10. **Preise:** Free (Self-Hosted) / SaaS Tiers
11. **FAQ:** Top 5 Fragen
12. **CTA:** Start Free / Deploy Now

#### 0.6.3 Screenshot-Anforderungen (Aufwand: 1 Tag)

Benötigte Screenshots (Light + Dark Mode):

- [ ] Desktop: Reader mit Artikel (volle Breite)
- [ ] Desktop: Feed-Liste + Artikel-Liste (3-Spalten)
- [ ] Mobile: Artikel-Reader (iPhone 15 Pro Frame)
- [ ] Mobile: Feed-Liste mit Bottom-Navigation
- [ ] Desktop: Search mit Advanced Syntax
- [ ] Desktop: Settings / Admin-Panel
- [ ] Desktop: Rules-Editor
- OG-Image (1200×630): Logo + Tagline

#### 0.6.4 SEO-Grundlagen (Aufwand: 0.5 Tage)

- [x] `metadata` in `app/layout.tsx`: `title`, `description`, `openGraph`, `twitter` — PR #45
- [x] `sitemap.ts` generieren — PR #45
- [x] `robots.txt` — PR #45
- [ ] Schema.org `SoftwareApplication` Markup auf Landing Page

---

### 0.7 Maintenance, Dependencies & Code-Quality (Audit 2026-05-17)

**Ziel:** Sichere und aktuelle Abhängigkeiten, sauberer Code, klares Refactor-Backlog für die Skalierung nach Launch.

**Audit-Status:**
- ✅ `pnpm run build` clean — alle Routen kompilieren, inkl. neuer `/robots.txt` und `/sitemap.xml`
- ✅ `pnpm run lint` clean — keine ESLint- oder jsx-a11y-Warnungen
- ✅ `npx tsc --noEmit` clean — TypeScript Strict ohne Fehler
- ✅ Patch/Minor-Dependency-Updates eingespielt (0.7.1): Radix UI, React 19.2.6, TailwindCSS 4.3, TanStack Query 5.100, u.v.m.
- ✅ Zentraler Logger `lib/logger.ts` live — alle 56 `console.*`-Statements in Server-Code migriert (0.7.3)
- ⚠️ 2 CVEs in transitiven Abhängigkeiten — Build-Tool-Only, kein Produktions-Risiko (0.7.4)
- ⚠️ 6 Komponenten > 600 Zeilen, größte Datei mit 2 867 Zeilen — Refactor-Kandidaten (0.7.3, noch offen)
- ⚠️ 117 `any`-Vorkommen — schrittweise Typisierung sinnvoll (0.7.3, noch offen)

---

#### 0.7.1 Patch- & Minor-Dependency-Updates ✅ Quick Win (Aufwand: 0.5 Tage)

Risikoarme Updates ohne Breaking Changes:

| Gruppe | Beispiele | Update-Strategie |
|---|---|---|
| Radix-UI-Primitives (~20 Pakete) | `@radix-ui/react-dialog 1.1.4 → 1.1.15`, `react-tabs 1.1.2 → 1.1.13` | `pnpm up "@radix-ui/*"` |
| React 19 Patches | `react 19.2.0 → 19.2.6`, `react-dom 19.2.0 → 19.2.6` | `pnpm up react react-dom` |
| TanStack Query | `5.90.20 → 5.100.10` | Reguläres Update |
| TailwindCSS v4 | `4.1.18 → 4.3.0`, `@tailwindcss/postcss` ebenso | Reguläres Update |
| Utility-Packages | `tailwind-merge`, `cmdk`, `input-otp`, `embla-carousel-react`, `react-hook-form` | Reguläres Update |
| `@types/react` | `19.2.10 → 19.2.14` | Dev-Dep, kein Risiko |

- [x] Batch-Update via `pnpm up` für oben genannte Gruppen — alle Pakete aktualisiert (2026-05-18)
- [x] `pnpm run build && pnpm run lint && npx tsc --noEmit` nach Update grün ✅
- [ ] Smoke-Test im Dev-Server: Login, Reader, Settings, Manage Feeds, Server Settings

#### 0.7.2 Major-Dependency-Upgrades (Aufwand: 3–5 Tage, eigenständige PRs)

Jede Major-Version erfordert separate Validierung. **Reihenfolge der Empfehlung:**

| Priorität | Paket | Aktuell | Ziel | Risiko | Hinweise |
|---|---|---|---|---|---|
| **Hoch** | `@types/bcryptjs` | 3.0.0 | **Entfernen** | Keins | Paket ist deprecated, `bcryptjs` bringt eigene Typen mit |
| **Hoch** | `eslint` + `eslint-config-next` | 8.57 / 14.2.35 | 9.x / 16.2.6 | Mittel | Flat-Config-Migration nötig (`eslint.config.js`); löst auch glob-CVE (siehe 0.7.4) |
| **Hoch** | `next-auth` | 5.0.0-beta.31 | 5.0.0 stable | Mittel | Beta-zu-GA-Diff — JWT- und Session-Callback-Signaturen prüfen |
| **Hoch** | `zod` | 3.25 | 4.4 | Mittel | API-Breaking Changes in `.parse()`, neue `z.coerce`-Semantik |
| **Mittel** | `prisma` + `@prisma/client` | 5.22 | 6.x → 7.x | Hoch | Zweistufig: erst 6 (Migration-API-Änderungen), dann 7 (Engine-Änderungen) |
| **Mittel** | `typescript` | 5.9 | 6.0 | Niedrig | Evtl. neue strict-Defaults — Build-Output prüfen |
| **Mittel** | `sonner` | 1.7 | 2.0 | Niedrig | Toast-API-Diff, kosmetisch |
| **Mittel** | `react-resizable-panels` | 2.1 | 4.11 | Mittel | UX-Regression-Test für 3-Spalten-Layout |
| **Niedrig** | `lucide-react` | 0.454 | 1.16 | Niedrig | Icon-Renames möglich (z.B. Lucide v1 hat einige Rebrandings) |
| **Niedrig** | `react-day-picker` | 9.8 | 10.0 | Niedrig | Calendar-API-Diff |
| **Niedrig** | `@hookform/resolvers` | 3.10 | 5.2 | Niedrig | Schema-Adapter-API-Diff |
| **Niedrig** | `undici` | 7 | 8 | Niedrig | Fetch-Edge-Cases |
| **Niedrig** | `@types/nodemailer` | 7 | 8 | Niedrig | Reine Typen-Update |
| **Niedrig** | `@types/node` | 22 | 25 | Niedrig | Node 22 LTS bleibt — Typen kompatibel |
| **Niedrig** | `@types/jsdom` / `jsdom` | 27 / 27.4 | 28 / 29.1 | Niedrig | Reines Library-Update |

- [ ] Pro Major-Paket eigener Branch + PR
- [ ] Changelog-Diff in PR-Beschreibung dokumentieren
- [ ] Build, Lint, Type-Check, Smoke-Test in jedem PR

#### 0.7.3 Code-Qualität — Logger, Refactor, Typing (Aufwand: 3 Tage)

**Zentraler Logger (`lib/logger.ts`):** ✅ implementiert (2026-05-18)
- [x] `log` / `info` / `warn` / `error` / `debug` Levels — in Produktion nur `warn`/`error`, in Dev alle Levels
- [x] **10 Dateien** mit **56** `console.*`-Statements migriert: `lib/rss-sync.ts`, `lib/auto-read-rules.ts`, `lib/keyword-alerts.ts`, `lib/background-sync.ts`, `lib/push.ts`, `lib/digest-scheduler.ts`, `lib/feed-fetcher.ts`, `lib/dynamic-opml.ts`, `app/api/discovery/search/route.ts`, u.a.
- [ ] `instrumentation.ts` Startup-Warnungen unverändert lassen (intentional, vor Logger-Init)

**Komponenten-Refactor (sinnvoll vor Theme- und i18n-Arbeit aus Phase 2):**

| Datei | Zeilen | Splitting-Plan |
|---|---|---|
| `components/feed-management.tsx` | **2 867** | Tabs aufteilen: `FeedsTab`, `CategoriesTab`, `LabelsTab`, `RulesTab`, `AlertsTab`, `SearchesTab` |
| `components/settings-form.tsx` | **1 781** | Sektionen: `AppearanceSection`, `ReadingSection`, `NotificationsSection`, `AISection`, `IntegrationsSection` |
| `components/server-management-dialog.tsx` | **1 473** | Tabs: `UsersTab`, `SettingsTab`, `EmailTab`, `AuditTab`, `BrandingTab`, `StarterPacksTab` |
| `components/rss-sidebar.tsx` | **1 355** | `SidebarHeader`, `FeedList`, `CategoryTree`, `SidebarFooter` extrahieren |
| `app/actions/feeds.ts` | **1 666** | Domain-Module: `feeds-crud.ts`, `feeds-sync.ts`, `opml.ts`, `categories.ts`, `articles-query.ts` |
| `components/article-list.tsx` | **873** | View-Mode-Komponenten in Unterordner: `ListView`, `MagazineView`, `MinimalView` |
| `components/article-reader.tsx` | **746** | `ReaderHeader`, `ReaderBody`, `ReaderActions` extrahieren |

- [ ] Pro Refactor ein PR, keine funktionalen Änderungen mitliefern
- [ ] Vorher/Nachher Bundle-Size-Diff dokumentieren

**TypeScript-Strictness:**
- [ ] **117** `: any` / `as any` Vorkommen schrittweise reduzieren (kein Big-Bang)
- [ ] Top-Sünder: `feed-management.tsx` (38), `rss-sidebar.tsx` (22), `server-management-dialog.tsx` (13), `use-rss-data.ts` (9)
- [ ] Bevorzugt korrekte Prisma-Typen aus `@prisma/client` verwenden (statt `any` auf API-Responses)
- [ ] `next.config.mjs`: `typescript.ignoreBuildErrors` nicht aktivieren — bleibt false

#### 0.7.4 CVE-Re-Audit & Override-Analyse (Aufwand: 0.5 Tage)

`pnpm audit` Befund am 2026-05-17 — beide CVEs sind **Build-Tool-Findings (kein Produktions-Risiko)**:

| Severity | Paket | Pfad | Exploitbarkeit | Fix-Pfad |
|---|---|---|---|---|
| **HIGH** | `glob 10.3.10` (CWE-78) | `eslint-config-next 14 → @next/eslint-plugin-next → glob` | ⚠️ Nur via `glob -c "cmd"` CLI-Flag; eslint nutzt glob als API → **false positive** | ESLint 9-Upgrade (0.7.2): `eslint-config-next@16` nutzt `fast-glob`, kein `glob@10.x` mehr |
| **MODERATE** | `postcss 8.4.31` (CWE-79) | `next → postcss`, `next-auth → next → postcss` | ⚠️ Betrifft nur dynamisch in HTML eingebettetes CSS-Output; Next.js schreibt CSS als statische Dateien → **false positive** | Next.js-Update: neuere Versionen bundeln neueres postcss |

**Analyse:** pnpm `overrides` (`glob ^10.5.0`, `postcss ^8.5.14`) greifen für eigene Packages korrekt, aber `@next/eslint-plugin-next@14.2.35` pinnt `glob` auf exakt `10.3.10` und `next` pinnt `postcss` auf `8.4.31` — hardgepinnte Transitive überschreiben die pnpm-Overrides nicht zuverlässig in v11.

- [x] Overrides in `package.json` (`glob ^10.5.0`, `postcss ^8.5.14`) korrekt gesetzt
- [x] Beide CVEs als Build-Tool-Only (nicht production-relevant) klassifiziert und dokumentiert
- [ ] **Dauerhafter Fix glob**: ESLint 9-Upgrade (0.7.2) → `eslint-config-next@16` → `@next/eslint-plugin-next@16` (nutzt `fast-glob`, kein `glob@10.x`)
- [ ] **Dauerhafter Fix postcss**: Next.js-Version-Update wenn neuere Version postcss@8.5+ bundelt
- [ ] Mozilla Observatory Score auf Produktions-Domain messen (Ziel: ≥ B+)
- [ ] `npm audit signatures` für Supply-Chain-Integrität (npm 9+)

#### 0.7.5 Build-Artefakte & Docker-Image-Größe (Aufwand: 0.5 Tage)

- [ ] `docker image inspect feedferret:latest --format='{{.Size}}'` — aktuelle Größe dokumentieren
- [ ] Ziel: < 400 MB. Bei Überschreitung:
  - Source-Maps in Production weglassen (`productionBrowserSourceMaps: false`)
  - `.next/cache` aus Runner-Stage prunen
  - `pnpm prune --prod` nach Build (falls noch nötig)
- [ ] CI (sobald vorhanden, 0.7.6): Image-Größe als Step-Output reporten, Warnung bei +20% Drift gegenüber `main`

#### 0.7.6 Test-Coverage & CI (Pre-Launch Quality-Gate) (Aufwand: 2 Tage)

**Aktueller Stand:** CI-Pipeline live. Lokale Validation über `pnpm run lint` + `pnpm run build` + `tsc --noEmit`.

**CI-Status:**
- [x] **GitHub Actions Workflow** (`.github/workflows/ci.yml`) — aktiv:
  - `pnpm install --frozen-lockfile`
  - `pnpm run lint`
  - `npx tsc --noEmit`
  - `pnpm run build`
  - Caching: `pnpm store` + `.next/cache` via `actions/cache`

**Noch ausstehend — Empfohlene Minimum-Test-Pyramide:**

- [ ] **Playwright E2E** (kritische User-Journeys):
  - Login + 2FA-Flow
  - Onboarding-Wizard (6 Schritte)
  - Feed hinzufügen → Sync → Artikel lesen
  - OPML-Import + Export
  - Saved Search erstellen + teilen
  - Account löschen (GDPR)
- [ ] **Vitest Unit-Tests** für reine Funktionen:
  - `lib/search.ts` — Query-Parser, alle Token-Typen
  - `lib/validation.ts` — Limit-Boundaries
  - `lib/token.ts` — Hashing, Format-Check
  - `lib/rate-limit.ts` — Sliding-Window-Verhalten
  - `lib/feed-fetcher.ts` — URL-Normalisierung, SSRF-Blacklist
- [ ] Optional lokal: `.husky/pre-commit` mit `pnpm lint-staged`

#### 0.7.7 Doc-Sync & Lifecycle ✅ Abgeschlossen (2026-05-18)

- [x] `docs/marketing-landing-page-brief.md`: Telegram/Gotify/ntfy + Google Reader API ergänzt; SaaS-Pricing als "Post-OSS-Launch" markiert
- [x] `CHANGELOG.md` aufgesetzt (Keep-a-Changelog-Format) mit v0.9.0, v0.8.0, v0.1.0
- [x] `package.json` Version 0.1.0 → **0.9.0**
- [ ] `docs/scout-studio.md`: GA-Features klar von "Future Extensions" trennen (Post-Launch)
- [ ] `docs/accessibility-todo.md`: A-4 und A-5 Status aktualisieren (Post-Launch)
- [ ] `docs/mcp.md`: MCP-Tools cross-checken (Post-Launch)
- [ ] `docs/api.md`: OpenAPI-Schema gegen v1-Routen abgleichen (Post-Launch)

---

### 0.8 Erweiterte Notification-Kanäle (Telegram, Gotify, ntfy) — Pre-Launch

**Motivation:** Nicht alle Nutzer wollen Browser-Push. Telegram und Gotify sind in der Homelab-Community Standard — ohne diese Kanäle verlieren wir Self-Hoster, die Push-Notifications bereits an ihrem Notification-Hub zentralisiert haben.

**Vorbedingung:** Generisches `NotificationChannel`-Framework (0.8.4) zuerst aufbauen, dann Kanäle einzeln draufsetzen.

#### 0.8.1 Telegram-Bot-Integration

- [ ] **Bot-Token-Konfiguration:** Nutzer gibt eigenen Telegram-Bot-Token ein (via @BotFather erstellt)
- [ ] **Chat-ID-Verknüpfung:** `/start`-Befehl im Bot liefert Chat-ID zurück, FeedFerret speichert sie
- [ ] **Nachrichten-Format:** Artikel-Titel + Kurz-Excerpt + Link (Telegram Markdown)
- [ ] **Trigger-Konfiguration:** Gleiche Logik wie bestehende Keyword-Alerts (Query-basiert)
- [ ] **Rate Limiting:** Max. N Nachrichten pro Stunde (Telegram-API-Limits beachten)
- [ ] **Inline-Buttons:** "Als gelesen markieren" direkt aus Telegram heraus (Webhook-Rückkanal)
- [ ] Settings: Telegram-Abschnitt in Notification-Settings

#### 0.8.2 Gotify-Integration

- [ ] **Server-URL + Token:** Nutzer gibt eigene Gotify-Instanz ein
- [ ] **Priorität konfigurierbar:** Low / Normal / High pro Alert-Regel
- [ ] **Nachrichten-Format:** Titel + Excerpt, Markdown wenn von Gotify-Client unterstützt
- [ ] **Verbindungstest:** "Send test notification" Button in Settings
- [ ] Settings: Gotify-Abschnitt in Notification-Settings

#### 0.8.3 ntfy.sh-Integration

- [ ] **Topic-URL:** Nutzer gibt `https://ntfy.sh/my-topic` oder eigene Instanz ein
- [ ] **Auth-Header:** Optionales Bearer-Token für private Topics
- [ ] **Priority:** Mapped auf ntfy-Prioritäten (urgent/high/default/low/min)
- [ ] **Tags/Emoji:** Konfigurierbar pro Alert-Typ
- [ ] Kein eigener Server nötig — ntfy.sh kostenlos nutzbar

#### 0.8.4 Generisches Notification-Framework (Fundament)

Alle drei Services teilen eine gemeinsame Abstraktion:

- [ ] `NotificationChannel`-Interface: `send(event, article) => Promise<void>`
- [ ] Implementierungen: `TelegramChannel`, `GotifyChannel`, `NtfyChannel`, `WebhookChannel` (bereits vorhanden), `EmailChannel` (bereits vorhanden), `PushChannel` (bereits vorhanden)
- [ ] Settings: Pro-Channel Enable/Disable, Test-Button, Channel-spezifische Konfiguration
- [ ] Alert-Regeln: Welche Channels werden für welche Alerts verwendet (Multi-Select)

---

### 0.9 Google Reader API — Client-Kompatibilitäts-QA — Pre-Launch

**Motivation:** Google Reader API ist bereits implementiert (`docs/google-reader-api.md`). Vor dem Launch müssen echte Clients getestet werden — ungeprüfte Kompatibilität ist kein Verkaufsargument.

**Code-Fixes (2026-05-18):**

- [x] `POST stream/items/contents` implementiert — Reeder, NNW, FeedMe, ReadKit nutzen diesen Endpoint nach `GET stream/items/ids`
- [x] `r=o` (oldest-first) Sortierung in `getArticlesForStream()` unterstützt
- [x] `ot` (older-than Unix-Sekunden) Filter in `buildStreamWhere()` implementiert
- [x] `mark-all-as-read` mit `ts`-Cutoff (Unix-Mikrosekunden) — verhindert, dass frisch gesynkte Artikel als gelesen markiert werden
- [x] `user-info.signupTimeSec` mit echtem Timestamp (statt 0)
- [x] `unread-count` gibt echte `newestItemTimestampUsec`-Werte zurück (global, starred, pro Feed)
- [x] Client-spezifische Setup-Anleitungen in `docs/google-reader-api.md` dokumentiert

**Noch ausstehend (Device-Tests):**

- [ ] Reeder (macOS/iOS) End-to-End-Test gegen Prod-Instanz
- [ ] NetNewsWire End-to-End-Test
- [ ] FeedMe (Android) End-to-End-Test
- [ ] ReadKit End-to-End-Test
- [ ] Fever API: Entscheidung basierend auf tatsächlichem Client-Bedarf (NetNewsWire nutzt Fever als Alternative)

---

## Phase 1: Launch

### Pre-Launch Checklist

Alle Punkte müssen abgeschlossen sein:

**Security:**
- [x] Rate Limiting aktiv (0.2.1) — Auth, MCP, Internal, v1 Read/Write
- [x] Security Headers konfiguriert (0.2.2)
- [x] API Token Hardening: SHA-256-Hashing, ff_-Prefix (0.2.3)
- [x] Input Validation: URL/OPML/Längen-Limits (0.2.4)
- [x] High/Moderate CVEs gepatcht via pnpm.overrides (0.2.5)
- [x] Admin & Session Hardening: Audit-Log, 2FA-Pflicht, Session-Invalidierung (0.2.6)
- [x] Docker Secrets-Warnung aktiv (0.2.7)

**Quality:**
- [x] Accessibility Sprint A-1, A-2, A-3 abgeschlossen (0.3) — PR #35
- [x] Empty States in allen Views (0.4.1) — PR #37
- [x] Onboarding-Flow überarbeitet — 6 Schritte, Starter Packs (0.4.3) — PR #38
- [x] `/api/health` Endpoint live (0.5.4)

**Deployment:**
- [x] Docker Compose reviewed und gehärtet (0.5.2) — PR #37
- [x] Self-Hosting Guide vollständig (0.5.6) — PR #38
- [x] Coolify-Guide vollständig in `docs/self-hosting.md` — Step-by-Step + Troubleshooting (0.5.5)

**Marketing:**
- [x] Landing Page aktualisiert (eigenes Repo) — Brief in `docs/marketing-landing-page-brief.md` (0.6.2)
- [ ] Screenshots fertig (0.6.3) — nach Launch mit laufender Instanz
- [x] SEO-Basics aktiv (0.6.4) — PR #45
- [x] SaaS-Pricing explizit auf "Post-OSS-Launch" verschoben (0.7.7)

**Notification-Kanäle:**
- [x] Telegram, Gotify, ntfy vollständig implementiert — Settings UI, Dispatch, Test-Button (0.8)
- [x] `notify_telegram`, `notify_gotify`, `notify_ntfy` in Keyword Alerts + Auto-Read Rules (0.8)

**Google Reader API QA:**
- [x] Blocking Compatibility Gaps behoben: POST stream/items/contents, ot/r/ts-Params, unread-count-Timestamps (0.9)
- [x] Client-spezifische Quirks und Setup-Anleitungen in `docs/google-reader-api.md` dokumentiert (0.9)
- ~~Device-Tests (Reeder, NNW, FeedMe, ReadKit) → Post-Launch (brauchen laufende Prod-Instanz)~~

**Maintenance & Quality:**
- [x] CVEs als Build-Tool-Only klassifiziert — kein Produktions-Risiko; Fix-Pfad dokumentiert (0.7.4)
- [x] CI-Pipeline aktiv (Lint + Type-Check + Build pro PR) — `.github/workflows/ci.yml` (0.7.6)
- [x] Patch- & Minor-Updates eingespielt — Radix UI, React 19.2.6, Tailwind 4.3, TanStack Query 5.100 u.a. (0.7.1)
- [x] Logger-Utility live (`lib/logger.ts`), alle 56 `console.*` in Server-Code migriert (0.7.3)
- [x] README auf < 5 Minuten gekürzt (0.5.6)
- ~~E2E + Unit Test-Suite → Post-Launch (0.7.6)~~

**Operations:**
- [x] Backup-Strategie vollständig dokumentiert (`pg_dump` + SQLite) in `docs/self-hosting.md` (0.5.6)
- [x] Support-Kanal: GitHub Issues aktiv, Issue-Templates (Bug Report + Feature Request) live (0.7.7)
- [x] `CHANGELOG.md` aufgesetzt — v1.0.0 / v0.9.0 / v0.8.0 / v0.1.0 (0.7.7)
- [x] Version auf `1.0.0` gebumpt (0.7.7)
- ~~Monitoring (Sentry/Axiom) → Post-Launch (2.0)~~

---

## Phase 2: Post-Launch Roadmap

Nach stabilem Launch und erstem Nutzer-Feedback.

---

### 2.0 Operations & Monitoring (direkt nach Launch)

- [ ] **Sentry** einrichten — `@sentry/nextjs`, DSN in `.env.example`, `lib/logger.ts` ruft intern `Sentry.captureException()` auf
- [ ] **Source Maps** über Sentry-Webpack-Plugin hochladen (Stack Traces auf Original-TypeScript)
- [ ] **Backup-Drill** — einmaligen `pg_dump`-Restore auf separater DB durchführen, Ablauf dokumentieren
- [ ] **Support-Kanal** — GitHub Issues aktivieren, Issue-Templates (Bug, Feature Request) anlegen
- [ ] Optional: Axiom für strukturierte Log-Aggregation (passt zu `lib/logger.ts`)

---

### 2.1 Podcast-Abonnements

**Motivation:** Podcasts sind RSS — FeedFerret hat die Infrastruktur bereits. Eine native Podcast-Unterstützung hebt das Produkt von reinen "Text-RSS-Readern" ab.

**Analyse-Fragen vorab:**
- Wie groß ist der Überschneidungsmarkt zwischen RSS-Power-Usern und Podcast-Hörern?
- Konkurrenz: AntennaPod (Android), Overcast (iOS), Pocket Casts, Spotify
- Differenziator: Self-Hosted Podcast-Sync + Text-Reader in einer App

#### 2.1.1 Podcast-Feed-Erkennung & -Parsing

- [ ] `<enclosure>`-Tags in RSS-Feeds erkennen und als Podcast-Episode speichern
- [ ] iTunes/Apple Podcast Namespace (`<itunes:*>`) parsen: Artwork, Dauer, Staffel, Folge, Typ
- [ ] `<podcast:*>` Namespace (Podcasting 2.0) vorbereiten
- [ ] Feed-Typ automatisch als `PODCAST` markieren wenn Enclosures dominant
- [ ] Schema: `Episode`-Model mit `audioUrl`, `duration`, `fileSize`, `mimeType`, `episodeNumber`, `season`, `artwork`

#### 2.1.2 Audio-Player-Integration

- [ ] Persistenter Mini-Player am unteren Rand (wie Spotify/Pocket Casts)
- [ ] Vollbild-Player-Ansicht
- [ ] Playback-Kontrollen: Play/Pause, Seek, 15s vor/zurück, Wiedergabegeschwindigkeit (0.5×–2×)
- [ ] Episode-Progress tracken (Timestamp in DB), Auto-Resume
- [ ] Hintergrund-Wiedergabe im Browser (Media Session API)
- [ ] PWA: Lockscreen-Kontrollen via Media Session API

#### 2.1.3 Podcast-spezifische UX

- [ ] Podcast-View in Sidebar (separater Bereich oder gefilterte View)
- [ ] "Ungehört"-Zähler für Podcast-Feeds
- [ ] Queue-Funktion: Nächste Episode in Warteschlange
- [ ] Kapitel-Unterstützung (Podcasting 2.0 `<podcast:chapters>`)
- [ ] Download für Offline-Wiedergabe (PWA Service Worker)

#### 2.1.4 Abonnement-Verwaltung

- [ ] Podcast-Feeds importieren (OPML mit Enclosure-Feeds)
- [ ] OPML-Export schließt Podcast-Feeds ein
- [ ] Automatisches Archivieren älterer Episoden (Retention Policy)

---

### 2.2 Text-to-Speech (On-Device / API)

**Motivation:** Artikel vorlesen lassen (Commute, Sport, Kochen) ist ein stark nachgefragtes Feature. Datenschutz-first: Priorität auf lokale/On-Device-Lösung.

**Strategie-Entscheidung (muss evaluiert werden):**

| Ansatz | Datenschutz | Qualität | Kosten | Latenz |
|---|---|---|---|---|
| Web Speech API (Browser) | ✅ On-Device | ⚠️ Mittel | ✅ Kostenlos | ✅ Sofort |
| Kokoro TTS (WebAssembly) | ✅ On-Device | ✅ Gut | ✅ Kostenlos | ⚠️ ~2s Erststart |
| Piper TTS (Server-Side) | ✅ Self-Hosted | ✅ Gut | ✅ Kostenlos | ✅ Gering |
| OpenAI TTS API (BYOK) | ⚠️ Cloud | ✅ Sehr gut | ⚠️ ~$0.015/1k chars | ✅ Gering |
| ElevenLabs API (BYOK) | ⚠️ Cloud | ✅ Excellent | ⚠️ Teurer | ✅ Gering |

**Empfohlene Implementierungsreihenfolge:**
1. Web Speech API als MVP (Browser-nativ, kein Backend)
2. Kokoro TTS via WebAssembly als On-Device-Alternative (Qualitätssprung)
3. OpenAI TTS als BYOK-Option für Cloud-Qualität

#### 2.2.1 Web Speech API MVP

- [ ] `SpeechSynthesis`-Integration im Article Reader
- [ ] Play/Pause/Stop-Kontrollen im Reader-Header
- [ ] Stimme und Sprache auswählen (basierend auf Artikel-Sprache-Detection)
- [ ] Wiedergabegeschwindigkeit (0.5×–2×)
- [ ] Aktuellen Satz/Absatz highlighten während Vorlesen (`SpeechSynthesisEvent.charIndex`)
- [ ] Fortschritt speichern (Resume-Funktion)

#### 2.2.2 Kokoro TTS (On-Device WebAssembly)

- [ ] Kokoro-82M-Modell evaluieren (< 100 MB, läuft im Browser)
- [ ] `@huggingface/transformers.js` oder `onnxruntime-web` Integration
- [ ] Service Worker für Modell-Caching (nur einmalig laden)
- [ ] Progressive Enhancement: Web Speech API Fallback wenn Kokoro nicht geladen
- [ ] Datenschutz-Hinweis: "Audio wird lokal generiert, kein Server-Kontakt"

#### 2.2.3 Cloud TTS (BYOK)

- [ ] OpenAI TTS (`tts-1`, `tts-1-hd`) via bestehenden AI-Provider-Mechanismus integrieren
- [ ] Stimmen-Auswahl (alloy, echo, fable, onyx, nova, shimmer)
- [ ] Kosten-Warnung in Settings ("~$0.015 pro 1.000 Zeichen")
- [ ] Generierte Audio-Datei optional cachen (DB oder Dateisystem)

#### 2.2.4 TTS Settings & UX

- [ ] Settings: TTS-Provider wählen (Browser / On-Device / Cloud BYOK)
- [ ] Global default Stimme + Geschwindigkeit
- [ ] TTS-Button im Article Reader (Play-Icon)
- [ ] Vorlesen-Modus: Automatisch zum nächsten Artikel weitergehen

---

### 2.3 Tages-Digest als Audio ("Morning Briefing")

**Motivation:** "Ich will meine Top-10-Artikel anhören während ich Kaffee trinke."

**Evaluation nötig:**
- Technisch: TTS (2.2) muss stabil sein als Voraussetzung
- Qualität: Artikeltexte direkt vorlesen vs. KI-generierte Zusammenfassung vorlesen?
- Länge: Wie lang soll ein Digest-Audio sein? Konfigurierbares Limit?
- Format: Streaming im Browser vs. generierte MP3-Datei vs. persönlicher Podcast-Feed

#### 2.3.1 Konzept & Evaluation

- [ ] User Research: Wird dieses Feature gewünscht? (Frühe-Nutzer-Befragung)
- [ ] Technische Machbarkeit: Audio-Generierung serverseitig (Piper/OpenAI) für zuverlässige Qualität
- [ ] Persönlicher Podcast-Feed als Output: Automatisch generierter RSS-Feed mit Audio-Episoden (`/api/v1/audio-digest/[token]/feed.xml`)
- [ ] Entscheidung: Implementieren wenn TTS stabil und Nutzer-Feedback positiv

#### 2.3.2 Implementierung (wenn Entscheidung positiv)

- [ ] Täglich/wöchentlich einen Digest generieren (Cron-Job oder Scheduler)
- [ ] Konfiguration: Welche Feeds/Labels/Suche → Quelle des Digests
- [ ] Artikel-Auswahl-Logik: Top-N ungelesene, sortiert nach Aktualität oder KI-Relevanz
- [ ] Audio-Generierung via TTS-Backend
- [ ] Persönlicher Podcast-Feed-Endpoint mit Basic-Auth-Schutz
- [ ] Im Media Player abspielbar (integriert mit 2.2)

---

### 2.4 Erweiterte Notification-Dienste

> **→ Vorgezogen in Phase 0 als Abschnitt 0.8** (Telegram, Gotify, ntfy). Vollständige Details und Checkliste dort.

---

### 2.5 Google Reader API — Client-Kompatibilitäts-QA

> **→ Vorgezogen in Phase 0 als Abschnitt 0.9** (End-to-End-Tests: Reeder, NetNewsWire, FeedMe, ReadKit). Vollständige Details und Checkliste dort.

---

### 2.6 Weitere geplante Features

| Feature | Aufwand | Abhängigkeiten |
|---|---|---|
| Saved Search Admin Policy (globaler Kill-Switch für öffentliche Shares) | Klein | — |
| Website Scraping Feeds (HTML+CSS/XPath ohne RSS) | Hoch | Scout Studio Grundlage ✓ |
| WebSub / PubSubHubbub (Instant-Updates) | Hoch | Feed-Infrastruktur ✓ |
| Batch API Endpoints (`POST /api/v1/articles/batch`) | Mittel | REST API v1 ✓ |
| API Token Scopes (read/write/admin statt globalem Token) | Mittel | Token-Hashing (0.2.3) |
| Offline-First Mutations (Read/Star ohne Netz) | Hoch | Service Worker ✓ |
| Team-Shares / Kollaboration | Sehr hoch | — |
| Native iOS/Android App (Capacitor oder React Native) | Sehr hoch | PWA-Basis ✓ |
| Theming & Layout Customization | Mittel–Hoch | → Abschnitt 2.7 |
| Multilingual / i18n | Hoch | → Abschnitt 2.8 |

---

### 2.7 Theming & Layout Customization

**Motivation:** Nutzer, die FeedFerret täglich stundenlang nutzen, wollen eine Oberfläche die sich wirklich nach ihnen anfühlt — nicht nur Dark Mode und eine Akzentfarbe. Theming ist auch ein starkes Differenzierungsmerkmal gegenüber Miniflux und FreshRSS, die kaum Anpassungsoptionen bieten.

**Aktueller Stand:** Accent Color Picker ✓, Secondary Color Picker ✓, Dark/Light Mode Toggle ✓, Reader Width ✓, CSS Custom Properties-Grundlage ✓

---

#### 2.7.1 Theme System — Architektur (Fundament)

Ziel: Alle visuellen Tokens zentral steuerbar machen, bevor weitere Features drauf aufbauen.

- [ ] **CSS Custom Properties inventarisieren:** Alle bestehenden `--color-*`, `--radius`, `--font-*` Tokens in `globals.css` dokumentieren und konsolidieren
- [ ] **Token-Hierarchie definieren:** Semantische Tokens (`--sidebar-bg`, `--reader-bg`, `--article-border`) statt nur Primitive Tokens; so können Theme-Presets semantisch korrekt angewendet werden
- [ ] **Theme-Shape definieren:** TypeScript-Interface `FeedFerretTheme { colors: {...}, radius: string, fontFamily: {...} }` für konsistente Validierung und Serialisierung
- [ ] **`theme-color-applier.tsx` erweitern:** Aktuell nur Accent/Secondary — vollständige Theme-Anwendung einbauen
- [ ] **Theme-Persistenz:** `User.themeJson` als JSON-Blob in DB speichern (statt einzelner Felder pro Farbe)
- [ ] **Rückwärtskompatibilität:** Bestehende Accent/Secondary-Felder in neues Schema migrieren; keine Breaking Change für bestehende Nutzer

#### 2.7.2 Theme-Presets

Built-in Themes als Ausgangspunkt und schnelle Option:

| Preset | Charakteristik |
|---|---|
| **Default Light** | Aktuelles Light Theme ✓ |
| **Default Dark** | Aktuelles Dark Theme ✓ |
| **OLED Black** | Reines #000000 Schwarz für OLED-Displays, maximale Akku-Schonung |
| **Solarized Light** | Klassisches Low-Contrast-Theme (Ethan Schoonover Palette) |
| **Solarized Dark** | Solarized Dark Variante |
| **Catppuccin Mocha** | Beliebtes Community-Theme, warm-dunkle Pastell-Töne |
| **Catppuccin Latte** | Catppuccin Light-Variante |
| **Gruvbox Dark** | Retro-warm, stark in der Terminal/Vim-Community |
| **High Contrast Dark** | WCAG AAA Kontrast für Sehbeeinträchtigungen |

Implementierung:
- [ ] Preset-Definitionen als TypeScript-Konstanten in `lib/themes.ts`
- [ ] Preset-Picker in Settings → Appearance (Gallery-View mit Mini-Vorschau)
- [ ] Preset als Ausgangspunkt laden + dann einzeln anpassen

#### 2.7.3 Farb-Customization (Advanced)

Über die bestehenden zwei Color Picker hinaus:

- [ ] **Sidebar:** Hintergrund, Text, aktive Zeile, Hover-Effekt
- [ ] **Article List Panel:** Hintergrund, Artikel-Karten-Hintergrund, Border, gelesen/ungelesen Unterschied
- [ ] **Reader:** Hintergrund, Text-Farbe, Link-Farbe
- [ ] **Header/Topbar:** Hintergrund
- [ ] **Border Radius:** Global konfigurierbar (0 = eckig, bis 12px = sehr rund)
- [ ] **HSL-Sliders** für Feinabstimmung (Hue, Saturation, Lightness) statt nur Hex Color Picker
- [ ] **Live-Vorschau** während Anpassung (ohne Speichern)
- [ ] **Kontrast-Warnung:** Echtzeit-Feedback wenn Kontrast < WCAG AA (4.5:1)

#### 2.7.4 Reader Typografie

Für optimalen Lese-Komfort ist Typografie entscheidend:

- [ ] **Schriftfamilie für Reader:**
  - System Default (sans-serif)
  - Serif (Georgia, Lora, Merriweather)
  - Monospace (für Tech-Inhalte)
  - OpenDyslexic (Barrierefreiheit)
  - Atkinson Hyperlegible (Barrierefreiheit)
  - Custom Google Font URL (advanced)
- [ ] **Schriftgröße:** Slider 14px → 24px (bestehende Accessibility-Aufgabe — hier integrieren)
- [ ] **Zeilenhöhe:** 1.4 / 1.6 / 1.8 / 2.0
- [ ] **Maximale Zeilenbreite (Measure):** 60ch / 70ch / 80ch / unbegrenzt
- [ ] **Buchstabenabstand (Letter Spacing):** Normal / Weit (für Legasthenie-Unterstützung)
- [ ] **Fließtext-Ausrichtung:** Links / Blocksatz
- [ ] Alle Einstellungen via CSS Custom Properties auf `[data-reader]`-Container anwenden — kein Chrome beeinflusst

#### 2.7.5 Layout-Optionen

- [ ] **Informationsdichte:** Comfortable / Compact / Cozy — skaliert Padding, Schriftgröße und Zeilenhöhe der Artikel-Liste
- [ ] **Artikel-Listen-Layout** (per View):
  - **List:** Aktuelle Standardansicht (Titel + Excerpt + Meta)
  - **Compact:** Nur Titel + Feed + Datum, maximale Dichte
  - **Magazine:** Thumbnail prominent, breitere Karten
  - **Cards:** Kachelansicht mit Bild oben (für bild-reiche Feeds)
- [ ] **Sidebar-Breite:** Konfigurierbar per Drag oder Preset (Schmal / Normal / Breit)
- [ ] **Zweispalten-Modus auf Tablet:** Sidebar + Artikelliste nebeneinander (ohne Reader), Reader springt auf volle Breite
- [ ] **Fokus-Modus / Zen Reading:** Sidebar und Artikel-Liste ausblenden, nur Reader, per Shortcut `z` oder `f` aufrufbar

#### 2.7.6 Kategorie-Farbkodierung

- [ ] Optionale Custom-Farbe pro Kategorie (farbiger Sidebar-Indikator)
- [ ] Farbe beeinflusst Artikel-Listen-Header-Farbe wenn Kategorie gefiltert
- [ ] Kein Pflichtfeld — Default ist Accent-Color

#### 2.7.7 Theme-Export & -Import

- [ ] **Export:** Theme als JSON-Datei herunterladen (`feedferret-theme-my-theme.json`)
- [ ] **Import:** JSON-Datei hochladen, Vorschau vor Anwenden
- [ ] **Shareable URL:** Theme als Base64-encoded URL-Parameter (`/settings?theme=eyJ...`)
- [ ] **Admin-Default-Theme:** Admins können ein Theme als Instance-Default setzen (neue Nutzer starten damit)
- [ ] **Community-Theme-Gallery** (langfristig): Öffentliche Sammlung von Community-Themes auf einem separaten Hub

---

### 2.8 Multilingual / i18n

**Motivation:** FeedFerret hat eine klare internationale Community (Self-Hosters sind global). Deutsch liegt nahe da die Entwicklung auf Deutsch stattfindet. RTL-Support ist bereits angelegt. Mit i18n wird FeedFerret für nicht-englischsprachige Nutzer deutlich zugänglicher.

**Strategische Entscheidungen vorab:**

| Frage | Empfehlung |
|---|---|
| Library | `next-intl` — beste Next.js App Router Integration, SSR-freundlich |
| URL-Strategie | Cookie/Header-basiert ohne URL-Prefix — keine Breaking URLs |
| Erste Sprache | Deutsch (Nähe zum Dev-Team, schnelles Review möglich) |
| Zweite Sprache | Französisch oder Arabisch (RTL-Test) |
| Translations-Workflow | GitHub-basiert als Einstieg, dann Weblate für Community |

---

#### 2.8.1 i18n-Fundament (Architektur)

- [ ] **`next-intl` installieren und konfigurieren:** `pnpm add next-intl`
- [ ] **Middleware einrichten:** Locale-Detection via `Accept-Language`-Header und User-Setting; Cookie als Override
- [ ] **Message-Datei-Struktur:** `messages/en.json` als Source of Truth, alle anderen Sprachen davon ableiten
- [ ] **Namespace-Konvention:** Hierarchisch nach Feature (`sidebar.*`, `reader.*`, `settings.*`, `admin.*`, `auth.*`, `errors.*`)
- [ ] **Pluralisierung:** ICU Message Format für korrekte Plural-Formen (en: "1 article / 2 articles", de: "1 Artikel / 2 Artikel")
- [ ] **Interpolation:** Variablen (`{count}`, `{feedName}`, `{date}`) in allen Strings von Beginn an einplanen
- [ ] **Datum/Uhrzeit:** Alle `new Date().toLocaleDateString()` durch `next-intl` `useFormatter()` ersetzen — korrekte Lokalisierung automatisch
- [ ] **RTL-Konfiguration:** Locale-basiertes `dir`-Attribut auf `<html>`-Element via `next-intl`

#### 2.8.2 String-Extraktion (größter Aufwand)

- [ ] **Vollständiges String-Inventar:** Alle UI-Strings in allen `.tsx`-Komponenten und Server Actions erfassen
- [ ] **Schätzung:** ~500–800 einzelne Strings; Tool wie `i18next-parser` oder manueller Sweep
- [ ] **`messages/en.json` erstellen:** Erste vollständige Englisch-Datei als Basis
- [ ] **Codebase migrieren:** `"Add Feed"` → `t('sidebar.addFeed')` in allen Komponenten — großer Refactor, sollte in einem Zug passieren
- [ ] **Error Messages:** Alle Fehlertexte aus Server Actions in i18n überführen (komplexer: Server-Side-Context nötig)
- [ ] **Dynamische Strings:** Strings die Variablen enthalten (`"${count} unread articles"`) korrekt als ICU migrieren

#### 2.8.3 Deutsche Übersetzung (erste vollständige Sprache)

- [ ] **`messages/de.json` erstellen:** Vollständige Übersetzung aller ~500–800 Strings
- [ ] **Qualitätssicherung:** Native-Speaker-Review (gesamtes UI durchklicken)
- [ ] **Fallthroughs prüfen:** Kein englischer String darf in der deutschen UI erscheinen
- [ ] **Sprachspezifika:** Grammatikalisch korrekte Pluralisierung, Groß-/Kleinschreibung (de: "Artikel", "Feed", "Einstellungen")
- [ ] **User-Setting:** `User.uiLanguage` Feld in Schema + Sprachauswahl in Settings → Appearance

#### 2.8.4 RTL-Support abschließen

Das RTL-Toggle (`User.layoutDirection`) ist bereits vorhanden — fehlende Teile:

- [ ] **Icon-Audit:** Alle `lucide-react` Icons auf Richtungsabhängigkeit prüfen: Chevrons, Back-Arrows, Swipe-Progress-Indikatoren, Wand-Icons → `rtl:scale-x-[-1]` anwenden
- [ ] **Logische CSS-Properties:** Alle `ml-`, `mr-`, `left-`, `right-`, `pl-`, `pr-` in Komponenten durch `ms-`, `me-`, `ps-`, `pe-`, `start-`, `end-` ersetzen
- [ ] **Swipe-Gesten unter RTL:** Aktuell fest kodiert (links = star, rechts = read) → unter RTL umkehren basierend auf `document.documentElement.dir`
- [ ] **Erste RTL-Sprache:** Arabisch (`ar`) oder Hebräisch (`he`) als Test-Locale einrichten
- [ ] **Bidirektionaler Content:** Arabische UI mit englischen Feed-Titeln muss korrekt gerendert werden (LTR innerhalb RTL-Container)

#### 2.8.5 Community-Translations-Workflow

- [ ] **Beitragsleitfaden:** `docs/contributing-translations.md` — wie man eine neue Sprache hinzufügt
- [ ] **GitHub-Workflow als Einstieg:** PRs mit `messages/[locale].json` direkt auf GitHub
- [ ] **Weblate-Integration (wenn Community wächst):** Hosted Weblate oder Selfhosted für einfachere Community-Beiträge ohne Git-Kenntnisse
- [ ] **Translation-Vollständigkeits-Badge:** Automatisch berechnen wie viel % einer Sprache übersetzt ist
- [ ] **Fallback-Strategie:** Fehlende Übersetzungen fallen auf Englisch zurück (kein leerer String)
- [ ] **Prioritäten für Community:** Deutsch ✓ (Dev-Team), Französisch, Spanisch, Japanisch, Chinesisch (vereinfacht), Arabisch, Niederländisch

#### 2.8.6 Sprach-Settings & Admin

- [ ] **User-Setting:** Bevorzugte UI-Sprache (überschreibt Browser-Locale)
- [ ] **Admin-Default:** Instance-weite Default-Sprache für neue Nutzer (in Server Management)
- [ ] **Sprachauswahl-UI:** Dropdown in Settings → Appearance mit Sprachnamen in ihrer eigenen Sprache ("Deutsch", "Français", "العربية")
- [ ] **Kein Auto-Redirect:** Sprache wird ohne URL-Änderung gesetzt (Cookie + DB-Wert)
- [ ] **E-Mail-Templates:** Digest-E-Mails und transaktionale Mails in der User-Sprache senden (Templates pro Locale)

#### 2.8.7 Artikel-Sprach-Erkennung (optional, längerfristig)

- [ ] **Sprach-Metadaten aus Feed nutzen:** `<language>` in RSS, `xml:lang` in Atom
- [ ] **Fallback:** Sprach-Detection via `franc` oder `langdetect` für Feeds ohne Metadaten
- [ ] **Artikel-Sprache speichern:** `Article.language` Feld
- [ ] **Filter nach Sprache:** "Nur Artikel auf Deutsch anzeigen" als Suchsyntax `lang:de`
- [ ] **TTS-Sprache automatisch wählen** basierend auf Artikel-Sprache (Integration mit 2.2)
