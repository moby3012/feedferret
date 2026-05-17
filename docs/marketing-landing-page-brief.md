# FeedFerret — Marketing & SaaS Landing Page Brief

> Zuletzt aktualisiert: 2026-05-17 (Feature-Inventar gegen Code synchronisiert, Pricing-Sektion klargestellt)  
> Zweck: Vorlage für die OSS-Landing Page, ProductHunt-Launch, Vergleichsseiten und Pressematerial.  
> Status: **OSS-Launch ist Priorität**; SaaS-Tier-Definition kommt nach Wettbewerbsanalyse (Roadmap 0.1.3).

---

## 1. Produkt-Zusammenfassung

**FeedFerret** ist ein selbst hostbarer, Mehr-Benutzer-fähiger RSS-Reader für Menschen, die Kontrolle, Geschwindigkeit, Datenschutz und ein poliertes Lese-Erlebnis wollen.

Er kombiniert:
- ein modernes Lese-Interface
- starke Self-Hosting-Unterstützung mit Docker
- strikte Mehr-Benutzer-Datenisolierung
- Automatisierungs- und Filter-Werkzeuge
- mobiloptimierte Leseoberfläche mit Gesten
- installierbare PWA-Unterstützung
- E-Mail-Digests und flexible Mail-Infrastruktur
- KI-gestützte Artikel-Zusammenfassungen (BYOK)
- Kompatibilität mit nativen RSS-Clients via Google Reader API
- REST API + MCP-Endpoint für Automatisierungen und AI-Agenten
- Ausgehende Webhooks für n8n, Zapier und eigene Systeme
- Keyword-Alerts mit Push-, E-Mail- und Webhook-Delivery

FeedFerret ist gebaut für den Homelab-Nutzer, Teams, Datenschutzinteressierte und Power-User, die mehr Kontrolle wollen als kommerzielle Feed-Reader bieten.

---

## 2. Positionierung & Differenzierung

### Hauptwert-Proposition

> FeedFerret gibt dir die Kontrolle über deinen Informationsfluss zurück — mit einem Lese-Erlebnis das sich modern anfühlt, nicht wie eine Datenbank-Verwaltung.

### Zielgruppe (priorisiert)

1. **Self-Hosters & Homelab-Enthusiasten** — wollen eigene Infrastruktur, kein SaaS-Abo
2. **RSS Power-User** — wollen erweiterte Suche, Labels, Rules, Webhooks, API
3. **Datenschutzbewusste Nutzer** — wollen ihre Lesegewohnheiten nicht bei Feedly/Google
4. **Researcher & Analysten** — wollen Feeds aggregieren, filtern, exportieren, automatisieren
5. **Teams & kleine Organisationen** — ein Server für alle, Mehr-Benutzer mit Isolation
6. **Feedly/Inoreader Migranten** — wollen weg von SaaS, suchen modernen Self-Hosting-Ersatz

### Kern-Differenziatoren

| Differenziator | Warum wichtig |
|---|---|
| **Self-Hosted + Multi-User** | Feedly/Inoreader sind SaaS. Miniflux/TinyTinyRSS haben ältere UX. |
| **Modernes Mobile UX** | Bottom Navigation, Swipe-Gesten, Thumb-Reach — wie Reeder/Pocket Casts |
| **Power-User-Tiefe ohne UX-Chaos** | Rules, Labels, Advanced Search, Alerts, API — aber trotzdem intuitiv bedienbar |
| **KI optional und privat** | BYOK: OpenAI, Anthropic, Gemini, Ollama — kein Lock-in, Schlüssel verschlüsselt |
| **Native Client Kompatibilität** | Google Reader API → Reeder, NetNewsWire, FeedMe, ReadKit |
| **Automation-First** | Webhooks (HMAC), REST API v1, MCP für AI-Agenten, n8n-Beispiele |
| **Flexible Auth** | Local, OAuth (Google/GitHub), Authelia OIDC, optionales TOTP 2FA |
| **Setup in 5 Minuten** | `docker compose up` → Setup-Wizard → fertig |

---

## 3. Feature-Inventar (vollständig)

### 3.1 Lese-Erlebnis

- Sauberes Artikel-Reader-Interface
- Mehrere Artikel-Listen-Layouts
- Dynamisches Theming (Accent- und Sekundärfarbe via Color Picker)
- Dark Mode + System-Theme-Präferenz
- Konfigurierbare Reader-Breite
- Automatisches Mark-as-Read nach konfigurierbarer Verzögerung
- "Open Original" standardmäßig konfigurierbar
- Standardmäßige Sortierreihenfolge (Neuste / Älteste / Zuletzt gelesen)

### 3.2 Mobile UX

- Mobile Bottom Navigation für Daumen-Erreichbarkeit
- Bottom Drawer statt Sidebar auf Mobilgeräten
- Swipe-Gesten für Artikel-Navigation (nächster/vorheriger Artikel)
- Swipe für schnelles Read/Star
- Scroll-to-Top-Button im Reader
- Safe-Area-Handling für moderne iPhones/Android
- Reduzierter visueller Lärm im mobilen Header
- Mobile Reader Bottom Controls

### 3.3 PWA

- Installierbar auf iPhone, Android, Desktop (Chrome/Edge)
- Add-to-Home-Screen Anleitung beim ersten Besuch
- App-Icon-Badges (best-effort, Browser-Support variiert)
- Offline-Fallback für gecachte Artikel
- Service Worker mit Stale-While-Revalidate
- App Shortcuts (Unread, Starred, Read Later, Settings)
- Deep-Link-Handling für Shortcuts und Notification-Links
- Manifest Screenshots für Install-Prompts

### 3.4 Feeds & Kategorien

- Feed hinzufügen, bearbeiten, löschen
- Kategorien (hierarchisch)
- Kategorien-Verwaltung
- Reihenfolge von Feeds und Kategorien
- Manueller Refresh (global oder pro Feed)
- **Feed Discovery:** gleiche Domain crawlen, kuratierte Starter Packs

**Erweiterte Feed-Optionen:**
- HTTP Basic Auth pro Feed
- Custom User-Agent
- Request Timeout
- SSL-Verifikation konfigurierbar
- Content-Größen-Limit
- Update-Frequenz pro Feed überschreiben

### 3.5 Suche & Saved Searches

**Erweiterte Suchsyntax:**

| Token | Beschreibung |
|---|---|
| Freitext | Titel, Content, Autor, URL, Feed, Labels |
| `is:unread / is:starred / is:readlater` | Statusfilter |
| `feed:name / category:name / label:name` | Scope-Filter |
| `after:7d / before:2026-01-01` | Datumsfilter |
| `intitle: / intext: / author:` | Feldfilter |
| `-term / !term` | Negation |

- Saved Searches mit Quick-Access
- **Saved Search Sharing:** Öffentliche HTML-Seite + RSS-Feed via geheimem Token
- Teilen aktivieren/deaktivieren pro Suche (Token wird sofort invalidiert)

### 3.6 Labels, Starred, Read Later

- Labels erstellen, bearbeiten, löschen
- Farbcodierte Labels
- Labels Artikeln zuweisen (auch per Auto-Rule)
- Starred-Workflow
- Read-Later-Workflow
- Unread/Read State Tracking

### 3.7 Auto-Rules & Automatisierung

**Auto-Mark-as-Read Rules:**
- Rule erstellen, bearbeiten, löschen, sortieren
- Query-basiertes Matching (gleiche Syntax wie Suche)
- Aktionen: Als gelesen markieren, Stern setzen, Label zuweisen
- Preview vor Aktivierung (welche Artikel würden matchen?)
- "Jetzt anwenden" Button
- Läuft automatisch nach jedem Sync

**Keyword Alerts:**
- Alerts für gespeicherte Queries
- Scope: alle Feeds, ein Feed oder eine Kategorie
- Delivery-Kanäle: In-App Bell, Browser Push, E-Mail, Outbound Webhook
- Alert-History mit Read/Unread-Status
- Match-Count-Badge pro Alert

### 3.8 KI-Zusammenfassungen (BYOK)

- Unterstützte Provider: OpenAI, Anthropic, Google Gemini, OpenRouter, Ollama
- Default-Modelle: gpt-4o-mini, claude-haiku-4-5, gemini-1.5-flash, llama3
- On-Demand-Zusammenfassung per Button im Reader
- Auto-Zusammenfassung beim Sync (optional, mit Limit)
- API-Schlüssel verschlüsselt gespeichert (AES-256-GCM)
- Sprache der Zusammenfassung konfigurierbar
- Zusammenfassungen in E-Mail-Digests

### 3.9 Volltext-Extraktion (Scout Studio)

- Per-Feed CSS-Selector für Artikel-Body
- Remove-Selectors (Werbung, Navbars, etc.)
- Extractions-Vorschau mit gerankten Kandidaten
- Auto-Fetch beim Sync
- Scout Studio Advanced Tab: XPath, JSON, HTTP-Optionen, Unicity, Filter
- Scout Studio Extended OPML Import/Export (`ffx:*`-Namespace)

### 3.10 Retention Policies & Feed Health

- Retention-Fenster pro Feed
- Dry-Run-Vorschau (welche Artikel würden gelöscht?)
- Geschützte Artikel: Starred + Labeled werden nie gelöscht
- Minimum Article Count pro Feed
- Health Dashboard: Artikelzahl, Unread-Count, Letzter Sync, Ø Artikel/Tag, Error Rate

### 3.11 Outbound Webhooks

- Webhook-Endpoints konfigurieren mit Secret
- Events: `new_article`, `keyword_match`, `feed_error`, `test`
- HMAC-SHA256-Signierung (Format identisch zu GitHub Webhooks)
- Retry-Strategie: 5 Versuche mit exponential Backoff (0, 5min, 30min, 2h, 8h)
- Feed-Filter: Webhooks nur für bestimmte Feeds
- Delivery-Log pro Webhook

### 3.12 Duplicate Detection

- Cross-Feed-Deduplizierung via SHA-256 URL-Hash
- URL-Normalisierung: HTTPS, www-Strip, Tracking-Parameter entfernen (`utm_*`, etc.)
- User-Setting: Duplikate anzeigen oder ausblenden
- Badge-UI für Duplikat-Count

### 3.13 Browser Push Notifications

- Web Push API mit VAPID
- Per-Gerät aktivieren/deaktivieren
- Benachrichtigungs-Frequenz: sofort / stündlich / täglich / aus
- Feed-Filter: Nur Push für bestimmte Feeds
- Privacy Toggle: Generische vs. Titel-enthaltende Payloads
- Badge-Updates (App-Icon-Zähler) via Service Worker

### 3.14 E-Mail-Digests

- Aktivieren/Deaktivieren pro User
- Frequenz, Wochentag und Uhrzeit konfigurierbar
- Scope-Filter: Alle Feeds, bestimmte Feeds/Kategorien
- Test-Digest senden
- Abmelde-Links in Digest-Mails
- KI-Zusammenfassungen in Digests (wenn aktiviert)

### 3.15 Flexible E-Mail-Delivery

| Provider | Konfiguration |
|---|---|
| SMTP | Admin UI oder ENV |
| Resend | `RESEND_API_KEY` |
| Postmark | `POSTMARK_SERVER_TOKEN` |
| Mailgun | `MAILGUN_API_KEY` + Domain |
| SendGrid | `SENDGRID_API_KEY` |

- Provider-Auswahl im Admin UI
- Credentials verschlüsselt gespeichert
- Test-Mail aus Admin UI

### 3.16 REST API v1 + MCP + Google Reader API

**REST API v1 (`/api/v1/*`):**
- Artikel: Suchen, lesen, Status ändern, Bulk-Mark-as-Read
- Feeds: Listen, hinzufügen, bearbeiten, löschen, synchronisieren
- Kategorien: Listen, erstellen, bearbeiten, löschen
- Labels: Listen, erstellen, bearbeiten, löschen
- Saved Searches: Listen, erstellen, bearbeiten, löschen, teilen
- OPML: Exportieren, importieren
- Sync: Alle Feeds synchronisieren
- OpenAPI Schema unter `/api/v1/openapi.json`

**MCP Endpoint (`/api/mcp`):**
- JSON-RPC 2.0 über HTTP (Streamable HTTP)
- Tools: `search_articles`, `get_article`, `update_article_state`, `list_feeds`, `add_feed`, `sync_feeds`, `list_categories`, `list_labels`, `create_label`, `mark_all_read`
- Für AI-Agenten, Claude, GPT, LangChain etc.

**Google Reader API:**
- Kompatibel mit Reeder, NetNewsWire, FeedMe, ReadKit
- Cursor-basierte Paginierung
- Streams, Tags, Subscriptions, Preferences
- Docs: `docs/google-reader-api.md`

### 3.17 Import & Export

- OPML-Import mit Duplikat-Erkennung
- Selektiver OPML-Export (nach Kategorie/Feed)
- Scout Studio Extended OPML Import/Export
- Vollständiger JSON-Daten-Export
- Keyboard Shortcuts für schnellen Import-Workflow

### 3.18 Keyboard Shortcuts

| Shortcut | Aktion |
|---|---|
| `/` | Suche öffnen |
| `Esc` | Suche/Dialog schließen |
| `j` / `k` | Nächster / Vorheriger Artikel |
| `n` / `p` | Nächster / Vorheriger ungelesener Artikel |
| `s` | Stern setzen/entfernen |
| `m` | Gelesen/Ungelesen togglen |
| `o` | Original-URL öffnen |
| `r` | Feeds aktualisieren |
| `Shift+S` | Aktuelle Suche speichern |
| `Shift+A` | Alle als gelesen markieren |
| `?` | Shortcut-Hilfe anzeigen |

### 3.19 Hintergrund-Sync

- In-Process-Scheduler (kein externer Cron nötig)
- Konfigurierbares Sync-Intervall
- Per-Feed Update-Frequenz
- Externer Sync-API-Endpoint (`GET /api/sync`)
- Status-Endpoint (`GET /api/sync/status`)
- Admin UI: Sync-Interval und Status

### 3.20 Admin-Funktionen

- Benutzerverwaltung (Roles, Suspend/Reactivate, Löschen)
- Registrierungen global ein-/ausschalten
- E-Mail-Provider und Mail-Service konfigurieren
- Instanz-Branding (Name, Icon/Logo)
- Admin-anpassbare Starter Packs (erstellen, bearbeiten, importieren, exportieren)
- SSRF-Einstellungen (Trusted Internal Feeds)
- SaaS Provisioning API (`/api/internal/*`)

### 3.21 Auth & Sicherheit

- Lokale E-Mail/Passwort-Accounts
- Magic Link (Passwortlos via E-Mail)
- Google OAuth
- GitHub OAuth
- Authelia OIDC (für Homelab SSO)
- Optionales TOTP 2FA (für lokale Accounts)
- Verschlüsselte API-Credentials (AES-256-GCM)
- SSRF-Schutz für server-seitige Fetches
- Content-Sanitization (DOMPurify)
- GDPR: Self-Service Account-Deletion (vollständiger Cascade)

### 3.22 Self-Hosting & Deployment

- Docker Compose mit PostgreSQL (Standard) oder SQLite
- Coolify-kompatibel (Docker Compose Deployment Type)
- Admin Onboarding Wizard (5-Schritt Setup)
- Automatische DB-Migrations via `prisma db push` beim Start
- Background Sync ohne externen Cron
- SQLite für minimale Infrastruktur, PostgreSQL für Produktion

---

## 4. Landing Page Architektur

### Empfohlene Sektionsreihenfolge

```
1. Hero
2. Proof / Trust Signals
3. Reading Experience
4. Mobile & PWA
5. Organization (Feeds, Categories, Labels)
6. Power-User (Rules, Alerts, Search, API, Webhooks, KI)
7. Native Client Compatibility
8. Self-Hosting & Admin
9. Authentication & Security
10. Pricing
11. FAQ
12. CTA
```

### Sektion 1: Hero

**Headline-Varianten (zum Testen):**
- "The self-hosted RSS reader that finally feels modern."
- "Own your feeds. Enjoy reading again."
- "A beautiful RSS reader for self-hosters and power users."
- "Your personal reading command center."

**Subheadline:**
> Read, filter, organize, and automate your RSS feeds — on your own server, in a polished interface built for both desktop and mobile.

**CTA-Buttons:**
- Primary: "Deploy with Docker" → `#deploy`
- Secondary: "See the features" → `#features`

**Hero Asset:** Desktop-Screenshot mit Reader + Feed-Liste (3-Spalten-Layout, Dark Mode)

### Sektion 2: Trust Signals

- GitHub Stars
- Docker Pulls
- "Used by X self-hosters" (wenn verfügbar)
- Frühe Nutzer-Quotes / Testimonials
- "Open Source, MIT License"
- Kompatible App-Icons: Reeder, NetNewsWire, n8n, etc.

### Sektion 3: Reading Experience

**Headline:** "Built for actual reading, not just feed storage."

Content:
- Screenshot: Article Reader (Desktop, Light Mode)
- Screenshot: Article Reader (Mobile, Dark Mode)
- Feature-Bullets: Multiple Layouts, Reader Width, Mark-as-Read Timing, Dark Mode, Keyboard Navigation

### Sektion 4: Mobile & PWA

**Headline:** "A self-hosted RSS reader that actually feels good on a phone."

Content:
- iPhone Screenshot: Bottom Navigation + Reader
- Android Screenshot: Feed-Liste
- Feature-Bullets: Swipe-Gesten, PWA Install, Offline-Fallback, One-Handed Reading

### Sektion 5: Organize Everything

**Headline:** "Use categories for structure, labels for meaning, saved searches for intelligence."

Content:
- Screenshot: Sidebar mit Kategorien + Labels
- Screenshot: Saved Search Sharing
- Feature-Grid: Feeds, Categories, Labels, Saved Searches, Shared Searches

### Sektion 6: Power-User Features

**Headline:** "From inbox-style reading to research automation."

Feature-Cards (je mit Icon + kurzer Beschreibung):
- **Smart Rules:** Auto-mark, star, label — with preview before enabling
- **Keyword Alerts:** Notify via push, email, or webhook when articles match
- **Advanced Search:** 15+ search tokens, save and share as RSS
- **REST API + MCP:** Automate via n8n, connect AI agents
- **Outbound Webhooks:** HMAC-signed, with retry logic
- **AI Summaries:** BYOK — OpenAI, Anthropic, Gemini, Ollama
- **Full-Text Extraction:** Per-feed CSS selectors for truncated feeds
- **Feed Health:** Stats, error rates, retention policies

### Sektion 7: Native Client Compatibility

**Headline:** "Use FeedFerret as your server backend while keeping your favorite RSS client."

Content:
- App-Icons: Reeder, NetNewsWire, FeedMe, ReadKit
- "Google Reader API compatible"
- Code-Snippet: Base URL konfigurieren

### Sektion 8: Self-Hosting & Admin

**Headline:** "Simple enough for a homelab, structured enough for a team."

```bash
git clone ... && cd feedferret
cp .env.example .env
docker compose up -d --build
```

Feature-Bullets:
- PostgreSQL oder SQLite
- Coolify-kompatibel
- Multi-User mit Admin-UI
- Instanz-Branding, Starter Packs, Benutzerverwaltung
- Keine externen Dienste erforderlich

### Sektion 9: Auth & Security

**Headline:** "Sign in your way. Keep your data private."

- Login-Optionen-Grid: Password, Magic Link, Google, GitHub, Authelia OIDC
- Optional TOTP 2FA
- "Your data stays on your server"
- GDPR: Vollständige Account-Löschung
- AES-256-GCM verschlüsselte API-Credentials
- SSRF-Schutz für Feed-Fetching

### Sektion 10: Preise

**Self-Hosted (Kostenlos, MIT License) — verfügbar zum OSS-Launch:**
- Alle Features
- Unbegrenzte Nutzer
- PostgreSQL oder SQLite
- Community-Support via GitHub Issues

**SaaS — coming soon:**

> **Status:** Die SaaS-Variante ist nach dem OSS-Launch geplant. Tier-Definition und Pricing werden nach Abschluss der Wettbewerbsanalyse (Roadmap 0.1.3) finalisiert.

Erwartete Tiers:
- **Personal** — Managed Hosting für Einzelnutzer, automatische Updates, E-Mail-Support
- **Team** — Mehrere Nutzer mit Isolation, Priority-Support, SSO

Für die OSS-Landing Page zum Launch: SaaS-Sektion als "Coming Soon"-Teaser mit Mail-Capture (z.B. Listmonk, Mailchimp, Buttondown) statt fester Preise rendern.

### Sektion 11: FAQ

Top-5-Fragen (Entwurf):
1. Was ist der Unterschied zwischen Self-Hosted und dem SaaS-Angebot?
2. Kann ich meine Feedly/Inoreader-Abonnements importieren?
3. Welche nativen RSS-Apps sind kompatibel?
4. Wie werden meine Daten gesichert?
5. Brauche ich technisches Wissen für den Self-Hosted-Betrieb?

### Sektion 12: CTA

- "Deploy FeedFerret" → GitHub Repo
- "Try the SaaS version" → Signup
- "Read the Docs" → Dokumentation

---

## 5. Marketing-Copy Entwürfe

### Kurzbeschreibungen

**1 Satz:**
> FeedFerret ist ein selbst hostbarer RSS-Reader mit moderner UX, Mehr-Benutzer-Unterstützung, mobilen Gesten und Power-User-Werkzeugen.

**2-3 Sätze:**
> FeedFerret ist ein polierter, selbst hostbarer RSS-Reader für Nutzer, die Datenschutz, Kontrolle und ein besseres Leseerlebnis wollen. Er kombiniert mobiles Design, Labels, Saved Searches, Automatisierungs-Rules, E-Mail-Digests, flexible Auth und native Client-Kompatibilität in einer modernen App. Auf deinem Server. Für deine Daten.

**Ausführlich (ProductHunt / Press):**
> FeedFerret ist eine Self-Hosted RSS-Plattform für ernsthafte Leser. Sammle und organisiere Feeds, filtere automatisch Rauschen heraus, speichere und teile leistungsstarke Suchen, lies komfortabel auf Desktop und Mobile, installiere die App als PWA, verbinde native RSS-Clients via Google Reader API, und verwalte Auth via lokale Accounts, 2FA, OAuth oder Authelia. Gebaut um leistungsstark zu sein ohne veraltet zu wirken.

### ProductHunt-Tagline (Entwurf)

> The self-hosted RSS reader that finally feels modern

### Vergleichs-Positionierung

| vs. Feedly | FeedFerret ist self-hosted, keine Daten auf fremden Servern, kein SaaS-Abo |
| vs. Inoreader | Gleiche Power-Features, aber vollständig unter deiner Kontrolle |
| vs. Miniflux | Modernere UX, Mobile-First, KI-Integration, Google Reader API |
| vs. FreshRSS | Schöneres Interface, bessere Mobile UX, API, Webhooks, KI |

---

## 6. Neue Features seit letztem Update (Mai 2026)

Diese Features sind besonders stark für Launch-Messaging:

| Feature | Botschaft |
|---|---|
| **KI-Zusammenfassungen (BYOK)** | Deine KI, dein Schlüssel — OpenAI, Anthropic, Gemini, Ollama |
| **Outbound Webhooks** | Sofort-Benachrichtigung bei neuen Artikeln → n8n, Zapier, eigene Systeme |
| **Keyword Alerts (vollständig)** | Push + E-Mail + Webhook wenn Artikel deiner Query matchen |
| **Duplicate Detection** | Gleiche Geschichte aus 5 Feeds? Nur einmal zeigen |
| **Feed Discovery** | Gibt es RSS? FeedFerret findet es. Oder starte mit kurierten Packs |
| **Admin Starter Packs** | Vorkonfigurierte Feed-Sammlungen für neue Nutzer anpassen |
| **MCP Endpoint** | AI-Agenten (Claude, GPT, LangChain) direkt in den Reader integrieren |
| **REST API v1 vollständig** | Alle Kern-Daten via API — für Automationen, Dashboards, Apps |

---

## 7. Screenshot-Anforderungen

Benötigte Assets für Launch:

| Asset | Spezifikation | Priorität |
|---|---|---|
| Hero Screenshot Desktop | 1440×900, Light + Dark | Kritisch |
| Reader Desktop | 1440×900, Light + Dark | Kritisch |
| Mobile Reader iPhone | 393×852 (iPhone 15 Pro), Light + Dark | Kritisch |
| Mobile Feed-Liste | 393×852, Light + Dark | Hoch |
| OG Image | 1200×630, Logo + Tagline | Kritisch |
| ProductHunt Gallery | 5 Bilder à 1270×952 | Hoch |
| Favicon Set | bereits vorhanden ✓ | — |
| Apple Touch Icon | bereits vorhanden ✓ | — |

---

## 8. SEO-Zielseiten

Empfohlene Seiten für organische Reichweite:

- `/` — Haupt-Landing Page
- `/self-hosting` — Self-Hosting Guide
- `/compare/feedly` — FeedFerret vs. Feedly
- `/compare/inoreader` — FeedFerret vs. Inoreader
- `/compare/miniflux` — FeedFerret vs. Miniflux
- `/blog/rss-reader-2026` — "Best Self-Hosted RSS Readers 2026"
- `/docs` — Dokumentations-Hub
- `/changelog` — Release Notes

---

## 9. Launch-Kanäle (Empfehlung)

| Kanal | Timing | Format |
|---|---|---|
| GitHub Release | Launch-Tag | Changelog + Screenshots |
| ProductHunt | Launch-Tag | Launch mit Gallery + Demo-GIF |
| Hacker News (Show HN) | Launch-Tag oder +1 Tag | Kurzer Pitch + Tech-Stack |
| Reddit r/selfhosted | Launch-Woche | Screenshot-Post |
| Reddit r/rss | Launch-Woche | Feature-Fokus |
| Twitter/X | Laufend | Screenshots, Quick-Tips |
| Mastodon / Fediverse | Laufend | Self-Hosting Community |
