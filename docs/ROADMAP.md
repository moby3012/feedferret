# FeedFerret Roadmap

> Zuletzt aktualisiert: 2026-05-16  
> Aktueller Status: **Pre-Launch — Finale Härtungs- & Polishing-Phase**

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
| GDPR: Self-Service Account-Deletion | `docs/gdpr.md` |
| Admin Onboarding Wizard | — |
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

#### 0.2.1 Rate Limiting

Schutz vor Brute-Force, Credential-Stuffing und API-Abuse:

| Endpoint-Gruppe | Limit | Fenster |
|---|---|---|
| `POST /api/auth/signin` | 10 Versuche | 15 Minuten |
| `POST /api/auth/sendverificationrequest` (Magic Link) | 3 Versuche | 10 Minuten |
| `POST /api/v1/*` (schreibend) | 60 Requests | 1 Minute |
| `GET /api/v1/*` (lesend) | 200 Requests | 1 Minute |
| `POST /api/internal/*` | 30 Requests | 1 Minute |
| `POST /api/mcp` | 100 Requests | 1 Minute |

Implementierung: `@upstash/ratelimit` (Redis-backed) für Production, oder einfaches In-Memory-LRU als Fallback für Single-Instance.

Acceptance Criteria:
- [ ] Rate-Limit-Response: HTTP 429 mit `Retry-After`-Header
- [ ] Admin-IPs können optional exempted werden
- [ ] Rate Limits in `docs/security.md` dokumentiert

#### 0.2.2 Security Headers

In `next.config.mjs` via `headers()`:

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; ...
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

Zusätzlich: HSTS via Reverse Proxy (Nginx/Caddy/Traefik) dokumentieren.

Acceptance Criteria:
- [ ] Mozilla Observatory Score ≥ B+
- [ ] Keine Browser-Konsolenwarnungen durch CSP in normaler Nutzung

#### 0.2.3 API Token Hardening

Aktueller Stand: Token im Klartext in DB gespeichert.

Ziel-Stand:
- [ ] Token-Hashing: SHA-256 des Tokens in DB speichern, nie den Klartext
- [ ] Token-Präfix für einfache Identifizierung: `ff_` + 32 Random-Bytes (Base58)
- [ ] Token nur einmalig beim Erstellen anzeigen ✓ (bereits implementiert)
- [ ] Token-Rotation invalidiert sofort den alten Token
- [ ] Optional: Token-Ablaufdatum konfigurierbar

Hinweis: Breaking Change für bestehende Tokens — Migration-Plan ausarbeiten.

#### 0.2.4 Input Validation Audit

- [ ] Alle Server Actions auf Zod-Schemas prüfen — wo fehlen Validierungen?
- [ ] API v1 Inputs: Feldlängen, Typen, Ranges validieren
- [ ] OPML Import: Max-Größe, Max-Feeds-Count, XML-Injection prüfen
- [ ] Search Query: Keine ReDoS-Anfälligkeiten im Parser
- [ ] Feed URLs: SSRF-Schutz greift ✓, aber URL-Format-Validierung vor dem Fetch?

#### 0.2.5 Dependency Audit & Updates

```bash
pnpm audit
pnpm outdated
```

- [ ] Alle Critical/High CVEs beheben
- [ ] Moderate CVEs bewerten und ggf. beheben
- [ ] Node.js Version: 22-slim im Dockerfile prüfen (aktuell LTS?)
- [ ] Prisma auf aktuelle Version (5.x → 6.x Bruch-Potential prüfen)
- [ ] next-auth auf aktuellste 5.x

#### 0.2.6 Admin & Session Hardening

- [ ] 2FA-Pflicht für Admin-Accounts als Server-Setting konfigurierbar machen
- [ ] Audit-Log für Admin-Aktionen: User löschen, Rollen ändern, Settings ändern (als `AdminLog`-Tabelle oder strukturiertes Server-Log)
- [ ] Session-Invalidierung sicherstellen: Nach Passwortänderung, nach Account-Suspension, nach 2FA-Aktivierung alle Sessions terminieren
- [ ] Fehlgeschlagene Login-Versuche loggen (User-ID, IP, Timestamp) — für Admin-Audit

#### 0.2.7 Docker & Deployment Security

- [ ] **Postgres-Port:** In `docker-compose.yaml` den `ports: "5432:5432"` Eintrag entfernen oder mit Kommentar versehen ("nur für Maintenance — für Produktion entfernen"). Die App kommuniziert intern über Docker-Netzwerk.
- [ ] **Healthcheck für FeedFerret-Service** in `docker-compose.yaml` hinzufügen: `curl -f http://localhost:3000/api/health` oder ähnlich
- [ ] **Default-Passwort-Warnung:** Startup-Log warnt wenn `POSTGRES_PASSWORD=feedferret-change-me` erkannt wird
- [ ] **Auth-Secret-Validierung:** Startup-Fehler wenn `AUTH_SECRET` kürzer als 32 Zeichen
- [ ] **SQLite Volume:** `feedferret_db_data` in `docker-compose.yaml` als Named Volume für SQLite-Pfad ergänzen

#### 0.2.8 Secrets & Environment Validation

- [ ] Startup-Validation (`instrumentation.ts` oder `next.config.mjs`): Alle Pflicht-ENV-Vars prüfen und bei Fehler klare Fehlermeldung ausgeben
- [ ] `AUTH_URL` muss gültiges `https://`-URL sein (ausgenommen localhost-Entwicklung)
- [ ] Prisma Query Logging in Production deaktivieren (keine Queries mit Parametern in Logs)
- [ ] Kein `console.log` mit Secrets oder User-Daten in Production

---

### 0.3 Accessibility (WCAG 2.2 AA)

**Ziel:** Grundlegende WCAG 2.2 AA-Konformität zum Launch. Vollständige Details in `docs/accessibility-todo.md`.

#### Sprint A-1: Quick Wins (Priorität: Hoch, Aufwand: 1–2 Tage)

- [ ] `prefers-reduced-motion`: Alle Animationen (`animate-fade-in`, `animate-slide-in-right`, Swipe-Transforms, Pull-to-Refresh) hinter `@media (prefers-reduced-motion: no-preference)` schieben
- [ ] **Skip Link:** Sichtbarer Focus-Link über der `RssSidebar` zu `<main role="main">`
- [ ] **ARIA Landmarks:** `role="navigation"` (Sidebar), `role="region" aria-label="Article list"` (Feed-View), `role="region" aria-label="Article reader"` (Reader)
- [ ] **Icon-only Buttons:** Systematischer Sweep mit `aria-label` in `mobile-bottom-controls.tsx`, `rss-header.tsx`, `article-reader.tsx`
- [ ] Keyboard-Shortcut-Dialog: Jede Aktion muss auch per normaler UI erreichbar sein

#### Sprint A-2: Screen Reader (Priorität: Hoch, Aufwand: 2–3 Tage)

- [ ] `aria-live="polite"` Region für Suchergebnis-Count
- [ ] `aria-live` für Unread-Count-Badge-Änderungen in Sidebar
- [ ] Article Reader: `h1` eindeutig, Überschriften-Hierarchie korrekt, Original-URL als echtes `<a>`
- [ ] Focus Management: Bei Modal-Open → Focus ins Modal, bei Close → Focus zurück zum Trigger
- [ ] Toast/Sonner: `aria-live`-Region prüfen und ggf. verkabeln

#### Sprint A-3: Keyboard Navigation (Priorität: Mittel, Aufwand: 2–3 Tage)

- [ ] Feed-Karten: `tabIndex={0}` + `onKeyDown Enter/Space` für vollständige Keyboard-Bedienbarkeit
- [ ] Roving-Tabindex-Pattern für Feed-Liste (Pfeiltasten zwischen Zeilen)
- [ ] `@dnd-kit` Drag-and-Reorder: Keyboard-Sensor-Wiring und Screen-Reader-Announcements verifizieren
- [ ] Alle Dialoge per `Esc` schließbar (systematischer Test)

#### Sprint A-4: Visuals & Kontrast (Priorität: Mittel, Aufwand: 1–2 Tage)

- [ ] Kontrast-Audit: `text-muted-foreground` Varianten auf allen Backgrounds messen
- [ ] `getContrastColor` Helper bei User-Accent-Colors durchsetzen
- [ ] 200% Browser-Zoom: Alle kritischen Screens ohne horizontales Scrollen
- [ ] Font-Size-Slider für Reader-Typografie (small / regular / large / x-large)

#### Sprint A-5: Tooling & Prozess (Priorität: Mittel, Aufwand: 1 Tag)

- [ ] `eslint-plugin-jsx-a11y` aktivieren und Warnungen beheben
- [ ] `@axe-core/playwright` für kritische Screens in CI (Login, Home, Reader, Settings)
- [ ] `/accessibility` Seite: Features, bekannte Einschränkungen, Feedback-Kanal

---

### 0.4 UI Polish & UX-Verfeinerung

**Ziel:** Produktionsreifes Look & Feel. Keine groben Unebenheiten im UX-Flow.

#### 0.4.1 Empty States (Aufwand: 1 Tag)

- [ ] Konsistente Empty-State-Komponente (Icon + Headline + CTA) für: leere Feed-Liste, keine Artikel in View, keine Suchergebnisse, keine Labels, keine Alerts, keine Webhooks, keine Saved Searches
- [ ] Jeder Empty State hat einen klaren nächsten Schritt ("Add your first feed", "Create a label", etc.)

#### 0.4.2 Loading States & Error Handling (Aufwand: 1–2 Tage)

- [ ] Skeleton-Loader in allen Artikel-Listen konsistent einsetzen
- [ ] Optimistic Updates für Read/Star/Later (Latenz verstecken)
- [ ] Sync-Fehler-Feedback: Feed-Karten zeigen Fehler-Icon wenn letzter Sync fehlschlug
- [ ] Netzwerkfehler im Article-Reader: Klarer Hinweis, nicht leere Seite

#### 0.4.3 Onboarding-Flow Review (Aufwand: 1 Tag)

- [ ] Alle 5 Setup-Wizard-Schritte vollständig durchklicken und Bugs dokumentieren
- [ ] Copy verbessern: prägnanter, weniger technisch
- [ ] Post-Setup: Nutzer direkt in "Feed hinzufügen"-Flow leiten, nicht auf leere Home-Seite
- [ ] Starter Pack Auswahl prominenter im Setup-Wizard (Schritt 3 oder 4)
- [ ] Erste-Sync-Erlebnis: Animiertes Feedback während Feeds laden

#### 0.4.4 Feed-Sync-Status-Verbesserungen (Aufwand: 0.5 Tage)

- [ ] Visuelles Feedback im Header während globaler Sync läuft
- [ ] Letzte Sync-Zeit global anzeigbar (z.B. Tooltip auf Refresh-Button)
- [ ] Per-Feed Sync-Status-Indikator in Feed-Liste

#### 0.4.5 Notification UX (Aufwand: 0.5 Tage)

- [ ] Bell-Menu: "Alle als gelesen markieren" Button
- [ ] Notification-Typen visuell unterscheiden (Alert Match vs. System)
- [ ] Leere Notifications-Ansicht mit erklärenden Text ("Set up keyword alerts to get notified...")

#### 0.4.6 Dark Mode & Theming Audit (Aufwand: 1 Tag)

- [ ] Systematischer Dark-Mode-Sweep aller Komponenten (axe Kontrast oder visuell)
- [ ] Accent-Color-Kontrast: `getContrastColor`-Helper überall einsetzen
- [ ] `prefers-color-scheme` System-Theme korrekt als Default respektieren

#### 0.4.7 Copy & Microcopy (Aufwand: 0.5 Tage)

- [ ] Fehlermeldungen: Handlungsorientiert ("Failed to load feed. Check the URL and try again.")
- [ ] Bestätigungsdialoge: Konsistente Formulierung
- [ ] Tooltips auf Icon-Buttons ohne Text: Alle haben `title` oder `aria-label` als Tooltip-Source
- [ ] Destruktive Aktionen: Klare Warnung + Bestätigung

#### 0.4.8 Mobile UX Final Pass (Aufwand: 1 Tag)

- [ ] Hit-Targets: Alle Buttons ≥ 44×44 px auf Mobile (WCAG 2.5.5)
- [ ] Swipe-Gesten: Edge-Case bei sehr schnellem Swipe testen
- [ ] Safe Area Insets: Prüfung auf neuesten iPhone/Android Modellen
- [ ] Landscape-Mode: Keine gebrochenen Layouts

---

### 0.5 Docker Deployment & Dokumentation Review

**Ziel:** Problemloser Self-Hosting-Einstieg, fehlerfreie Docker-Deployments, vollständige Onboarding-Doku.

#### 0.5.1 Dockerfile Audit (Aufwand: 0.5 Tage)

Aktuelle Beobachtungen und Aufgaben:

- [ ] **Image-Größe messen:** `docker image inspect feedferret --format='{{.Size}}'` — Ziel < 400 MB
- [ ] **`libvips-dev` prüfen:** Wird sharp/libvips wirklich benötigt? Wenn nicht, entfernen (spart ~30 MB)
- [ ] **Prisma Global Install:** `npm install -g prisma@5.22.0` im Runner-Image pinned — besser via `node_modules/.bin/prisma` aus Builder-Stage kopieren
- [ ] **Node.js 22-slim:** Prüfen ob aktuelle LTS, oder auf Node.js 22 LTS pinnen
- [ ] **Build-Args Defaults:** `AUTH_SECRET` und `AUTH_URL` als ARG ohne Default (nicht mit leerem String) — verhindert versehentliche leere Werte

#### 0.5.2 docker-compose.yaml Verbesserungen (Aufwand: 0.5 Tage)

- [ ] **Postgres Port:** `ports: "${POSTGRES_PORT:-5432}:5432"` mit Kommentar "Remove for production — app uses internal network" oder als opt-in kommentieren
- [ ] **FeedFerret Healthcheck hinzufügen:**
  ```yaml
  healthcheck:
    test: ["CMD-SHELL", "curl -f http://localhost:3000/api/health || exit 1"]
    interval: 30s
    timeout: 10s
    retries: 3
    start_period: 60s
  ```
- [ ] **SQLite Volume definieren:** `feedferret_db_data` als Named Volume hinzufügen (für SQLite-Only-Deployments)
- [ ] **Explizites Netzwerk:** `networks: feedferret_net` für bessere Isolation definieren

#### 0.5.3 `start.sh` Audit (Aufwand: 0.5 Tage)

- [ ] Startup-Script lesen und Fehler-Handling prüfen
- [ ] Was passiert wenn `prisma db push` fehlschlägt? → App sollte nicht starten
- [ ] Timestamps in Startup-Log-Meldungen
- [ ] Exit-Codes korrekt setzen

#### 0.5.4 `/api/health` Endpoint (Aufwand: 0.5 Tage)

- [ ] Neuen `GET /api/health` Endpoint implementieren: `{ "status": "ok", "db": "ok", "version": "..." }`
- [ ] DB-Ping-Check einbauen
- [ ] Für Docker-Healthcheck und Monitoring nutzbar

#### 0.5.5 Coolify & Reverse Proxy Dokumentation (Aufwand: 1 Tag)

- [ ] Coolify-Guide in `README.md` auf Aktualität prüfen — alle dokumentierten Schritte durchführen
- [ ] Häufige Probleme als Troubleshooting-Tabelle: AUTH_TRUST_HOST, Build Args, Passwort-Mismatch
- [ ] **Neues Dokument:** `docs/reverse-proxy.md` mit Nginx, Caddy und Traefik Beispiel-Configs
- [ ] HSTS, HTTP→HTTPS Redirect, WebSocket (falls relevant) dokumentieren

#### 0.5.6 Self-Hosting Guide & Onboarding Doku (Aufwand: 1 Tag)

- [ ] **Neues Dokument:** `docs/self-hosting.md` — vollständiger Guide: Anforderungen, Installation, Konfiguration, Updates, Backup
- [ ] `.env.example` aufräumen: Pflichtfelder oben, optionale Felder mit Kommentaren gruppieren
- [ ] README Quick-Start auf < 5 Minuten optimieren: Nur das Nötigste, Links für Details
- [ ] Upgrade-Prozedur dokumentieren: `git pull && docker compose up -d --build`
- [ ] Backup-Anleitung in Self-Hosting-Guide einbauen (existiert in `docs/database.md` — verlinken)

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

- [ ] `metadata` in `app/layout.tsx`: `title`, `description`, `openGraph`, `twitter`
- [ ] `sitemap.ts` generieren
- [ ] `robots.txt`
- [ ] Schema.org `SoftwareApplication` Markup auf Landing Page

---

## Phase 1: Launch

### Pre-Launch Checklist

Alle Punkte müssen abgeschlossen sein:

**Security:**
- [ ] Rate Limiting aktiv (0.2.1)
- [ ] Security Headers konfiguriert (0.2.2)
- [ ] Dependency Audit: keine Critical/High CVEs (0.2.5)
- [ ] Docker Secrets-Warnung aktiv (0.2.7)

**Quality:**
- [ ] Accessibility Sprint A-1 und A-2 abgeschlossen (0.3)
- [ ] Empty States in allen Views (0.4.1)
- [ ] Onboarding-Flow getestet (0.4.3)
- [ ] `/api/health` Endpoint live (0.5.4)

**Deployment:**
- [ ] Docker Compose reviewed und gehärtet (0.5.2)
- [ ] Self-Hosting Guide vollständig (0.5.6)
- [ ] Coolify-Guide verifiziert (0.5.5)

**Marketing:**
- [ ] Landing Page live mit allen Sektionen (0.6.2)
- [ ] Screenshots fertig (0.6.3)
- [ ] SEO-Basics aktiv (0.6.4)

**Operations:**
- [ ] Monitoring: Sentry oder Axiom für Error-Tracking konfiguriert
- [ ] Backup-Strategie dokumentiert und einmal getestet
- [ ] Support-Kanal definiert (GitHub Issues / Discord)
- [ ] GitHub Releases mit Changelog-Template vorbereitet

---

## Phase 2: Post-Launch Roadmap

Nach stabilem Launch und erstem Nutzer-Feedback.

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

**Motivation:** Nicht alle Nutzer wollen Browser-Push. Telegram und Gotify sind in der Homelab-Community Standard.

#### 2.4.1 Telegram-Bot-Integration

- [ ] **Bot-Token-Konfiguration:** Nutzer gibt eigenen Telegram-Bot-Token ein (via @BotFather erstellt)
- [ ] **Chat-ID-Verknüpfung:** `/start`-Befehl im Bot liefert Chat-ID zurück, FeedFerret speichert sie
- [ ] **Nachrichten-Format:** Artikel-Titel + Kurz-Excerpt + Link (Telegram Markdown)
- [ ] **Trigger-Konfiguration:** Gleiche Logik wie bestehende Keyword-Alerts (Query-basiert)
- [ ] **Rate Limiting:** Max. N Nachrichten pro Stunde (Telegram-API-Limits beachten)
- [ ] **Inline-Buttons:** "Als gelesen markieren" direkt aus Telegram heraus (Webhook-Rückkanal)
- [ ] Settings: Telegram-Abschnitt in Notification-Settings

#### 2.4.2 Gotify-Integration

- [ ] **Server-URL + Token:** Nutzer gibt eigene Gotify-Instanz ein
- [ ] **Priorität konfigurierbar:** Low / Normal / High pro Alert-Regel
- [ ] **Nachrichten-Format:** Titel + Excerpt, Markdown wenn von Gotify-Client unterstützt
- [ ] **Verbindungstest:** "Send test notification" Button in Settings
- [ ] Settings: Gotify-Abschnitt in Notification-Settings

#### 2.4.3 ntfy.sh-Integration

- [ ] **Topic-URL:** Nutzer gibt `https://ntfy.sh/my-topic` oder eigene Instanz ein
- [ ] **Auth-Header:** Optionales Bearer-Token für private Topics
- [ ] **Priority:** Mapped auf ntfy-Prioritäten (urgent/high/default/low/min)
- [ ] **Tags/Emoji:** Konfigurierbar pro Alert-Typ
- [ ] Kein eigener Server nötig — ntfy.sh kostenlos nutzbar

#### 2.4.4 Generisches Notification-Framework

Alle drei Services teilen eine gemeinsame Abstraktion:

- [ ] `NotificationChannel`-Interface: `send(event, article) => Promise<void>`
- [ ] Implementierungen: `TelegramChannel`, `GotifyChannel`, `NtfyChannel`, `WebhookChannel` (bereits vorhanden), `EmailChannel` (bereits vorhanden), `PushChannel` (bereits vorhanden)
- [ ] Settings: Pro-Channel Enable/Disable, Test-Button, Channel-spezifische Konfiguration
- [ ] Alert-Regeln: Welche Channels werden für welche Alerts verwendet (Multi-Select)

---

### 2.5 Google Reader API — Client-Kompatibilitäts-QA

- [ ] Reeder (macOS/iOS) End-to-End-Test gegen Prod-Instanz
- [ ] NetNewsWire End-to-End-Test
- [ ] FeedMe (Android) End-to-End-Test
- [ ] ReadKit End-to-End-Test
- [ ] Client-spezifische Quirks und bewährte Base-URLs dokumentieren
- [ ] Blocking Compatibility Gaps beheben
- [ ] Fever API: Entscheidung basierend auf tatsächlichem Client-Bedarf

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
| RTL-Vollständigkeit (Arabisch, Hebräisch, Persisch) | Mittel | Bestehende RTL-Basis ✓ |
| Internationalisierung (i18n) mit next-intl | Hoch | — |
| Team-Shares / Kollaboration | Sehr hoch | — |
| Native iOS/Android App (Capacitor oder React Native) | Sehr hoch | PWA-Basis ✓ |
