# FeedFerret — Marketing & SaaS Landing Page Brief

> Zuletzt aktualisiert: 2026-07-20 (Nachmittag) — großes Update seit v1.1.0 (2026-05-21): komplett neue "Feed Intelligence"-Produktsäule (jede Webseite wird zum Feed, KI richtet Feeds automatisch ein, KI-Volltext-Fallback, KI-Auto-Tagging), Anti-Bot/Heavy-Fetch-Stack, zwei optionale Connectoren (RSSHub für Plattform-Feeds, changedetection.io für "jede Seite als Änderungs-Feed"), "Send to"-Exportziele (Obsidian, Wallabag), Feed-Auto-Mute mit Benachrichtigung, PWA-Share-Target ("Share → FeedFerret" direkt aus dem OS-Share-Sheet), zweite Sicherheits-Härtungsrunde, indizierte Volltextsuche, zwei komplette UX/A11y-Audit-Runden. Noch nicht als nummerierte Version veröffentlicht (siehe `CHANGELOG.md` → „Unreleased" für den vollständigen PR-Verlauf) — dieses Dokument beschreibt den tatsächlichen Code-Stand, nicht den Release-Stand.  
> Zweck: Vorlage für die OSS-Landing Page, ProductHunt-Launch, Vergleichsseiten und Pressematerial.  
> Status: **Bereit für ein großes Feature-Update der Landing Page — die "Feed Intelligence"-Säule ist aktuell komplett unkommuniziert und ist aus Marketing-Sicht das stärkste neue Alleinstellungsmerkmal.**
>
> **Durchgängiges Leitprinzip für dieses Dokument:** Jede KI-Funktion und jede externe Integration ist **strikt optional**. FeedFerret funktioniert vollständig ohne einen einzigen KI-Schlüssel, ohne einen einzigen Connector und ohne einen einzigen externen Dienst. Jede Erwähnung von KI oder einer Integration auf der Landing Page sollte das explizit mittragen ("optional", "bring your own key", "nur wenn aktiviert") — siehe Abschnitt 4 für die vollständige, für Marketing-Zwecke aufbereitete Integrationsliste.

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
- **"Feed Intelligence": macht praktisch jede Webseite zu einem Feed** — auch ohne eigenen RSS-Feed der Quelle (siehe Abschnitt 3.9)
- **KI-gestützte Funktionen — durchgehend optional, Bring-Your-Own-Key (BYOK), niemals verpflichtend:** Artikel-Zusammenfassungen, automatisches Einrichten neuer Feeds per URL, Volltext-Extraktions-Fallback für hartnäckige Seiten, automatisches Artikel-Tagging
- Kompatibilität mit nativen RSS-Clients via Google Reader API
- REST API + MCP-Endpoint für Automatisierungen und AI-Agenten
- Ausgehende Webhooks für n8n, Zapier und eigene Systeme
- Zwei optionale, selbst gehostete Connectoren: **RSSHub** (Plattform-Feeds — YouTube, Reddit, GitHub & Co.) und **changedetection.io** (jede Seite als Änderungs-Feed, inkl. JS-gerenderter Seiten)
- **"Send to" — Artikel an Obsidian oder Wallabag schicken**, jeweils optional konfigurierbar
- PWA-Share-Target: aus jeder App direkt "Share → FeedFerret", landet automatisch im Seite→Feed-Baukasten
- Feed-Auto-Mute: dauerhaft fehlschlagende Feeds werden automatisch stummgeschaltet statt endlos weiterzuversuchen, mit einmaliger Benachrichtigung
- Keyword-Alerts mit Push-, E-Mail-, Webhook- und externem Channel-Delivery (Telegram, Gotify, ntfy)

FeedFerret ist gebaut für den Homelab-Nutzer, Teams, Datenschutzinteressierte und Power-User, die mehr Kontrolle wollen als kommerzielle Feed-Reader bieten — und für alle, die von KI und Zusatzdiensten profitieren wollen, ohne sie zu brauchen: **alles läuft standardmäßig aus, mit reinen RSS/Atom-Feeds, ganz ohne KI oder externe Dienste — jede zusätzliche Fähigkeit ist eine bewusste Entscheidung des Nutzers oder Admins, nie eine Voraussetzung.**

---

## 2. Positionierung & Differenzierung

### Hauptwert-Proposition

> FeedFerret gibt dir die Kontrolle über deinen Informationsfluss zurück — mit einem Lese-Erlebnis das sich modern anfühlt, nicht wie eine Datenbank-Verwaltung. Und wenn eine Seite keinen RSS-Feed hat? FeedFerret baut dir einen.

### Zielgruppe (priorisiert)

1. **Self-Hosters & Homelab-Enthusiasten** — wollen eigene Infrastruktur, kein SaaS-Abo
2. **RSS Power-User** — wollen erweiterte Suche, Labels, Rules, Webhooks, API
3. **Datenschutzbewusste Nutzer** — wollen ihre Lesegewohnheiten nicht bei Feedly/Google, und wollen KI (falls überhaupt) nur mit eigenem Schlüssel und expliziter Zustimmung
4. **Researcher & Analysten** — wollen Feeds aggregieren, filtern, exportieren, automatisieren — auch von Quellen ganz ohne eigenen RSS-Feed
5. **Teams & kleine Organisationen** — ein Server für alle, Mehr-Benutzer mit Isolation
6. **Feedly/Inoreader Migranten** — wollen weg von SaaS, suchen modernen Self-Hosting-Ersatz

### Kern-Differenziatoren

| Differenziator | Warum wichtig |
|---|---|
| **Self-Hosted + Multi-User** | Feedly/Inoreader sind SaaS. Miniflux/TinyTinyRSS haben ältere UX. |
| **Jede Webseite wird zum Feed** ⭐ | Listing-Seite ohne RSS? Aus der URL wird automatisch ein sich selbst aktualisierender Feed — mit oder ohne KI-Unterstützung. |
| **Modernes Mobile UX** | Bottom Navigation, Swipe-Gesten, Thumb-Reach — wie Reeder/Pocket Casts |
| **Power-User-Tiefe ohne UX-Chaos** | Rules, Labels, Advanced Search, Alerts, API — aber trotzdem intuitiv bedienbar |
| **KI komplett optional, privat und BYOK** ⭐ | Zusammenfassungen, Feed-Einrichtung, Volltext-Fallback, Auto-Tagging — alles standardmäßig **aus**, alles mit *deinem eigenen* Schlüssel (OpenAI, Anthropic, Gemini, OpenRouter oder komplett lokal via Ollama), nichts davon ist zum Betrieb nötig. Kein Lock-in, Schlüssel verschlüsselt gespeichert. |
| **Anti-Bot & Volltext-Stack — alles optional/selbst gehostet** | Vier gestaffelte, jeweils einzeln abschaltbare Ebenen (Browser-Fingerprinting, 1000+ vorgefertigte Seiten-Regeln, optionaler eigener Render-Sidecar, optionaler BYOK-Hosted-Fetch) — nichts davon sendet Daten irgendwohin, wenn es nicht ausdrücklich aktiviert wird. |
| **Native Client Kompatibilität** | Google Reader API → Reeder, NetNewsWire, FeedMe, ReadKit |
| **Automation-First** | Webhooks (HMAC), REST API v1, MCP für AI-Agenten, n8n-Beispiele, zwei optionale Connectoren (RSSHub, changedetection.io) |
| **"Send to" & Share-Target** | Artikel per Klick an Obsidian oder Wallabag schicken, oder per OS-Share-Sheet direkt eine Seite an FeedFerret teilen — beides optional |
| **Flexible Auth** | Local, OAuth (Google/GitHub), Authelia OIDC, optionales TOTP 2FA |
| **Setup in 5 Minuten** | `docker compose up` → Setup-Wizard → fertig, komplett ohne jede optionale Integration lauffähig |

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
- Reicher Volltext-Renderer: Tabellen, syntax-hervorgehobener Code, Mathe-Formeln (KaTeX), Aufgabenlisten, verzögert ladende Bilder — alles ganz ohne KI, reine Markdown/HTML-Darstellung

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
- **Share-Target:** "Share → FeedFerret" aus jeder App (Browser, Social-App, Notizen-App) — die geteilte URL landet direkt im Seite→Feed-Baukasten (3.9.2), vorausgefüllt
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

Volltext-indiziert (SQLite FTS5-Trigram / PostgreSQL `pg_trgm`) — schnell auch bei großen Artikel-Mengen.

**Erweiterte Suchsyntax:**

| Token | Beschreibung |
|---|---|
| Freitext | Titel, Content, Autor, URL, Feed, Labels |
| `is:unread / is:starred / is:readlater` | Statusfilter |
| `feed:name / category:name / label:name` | Scope-Filter |
| `after:7d / before:2026-01-01` | Datumsfilter |
| `intitle: / intext: / author:` | Feldfilter |
| `-term / !term` | Negation |
| `wort OR wort` | Oder-Verknüpfung |

- Saved Searches mit Quick-Access
- **Saved Search Sharing:** Öffentliche HTML-Seite + RSS-Feed via geheimem Token
- Teilen aktivieren/deaktivieren pro Suche (Token wird sofort invalidiert)

### 3.6 Labels, Starred, Read Later

- Labels erstellen, bearbeiten, löschen
- Farbcodierte Labels
- Labels Artikeln zuweisen (manuell, per Auto-Rule, oder — optional — per KI-Auto-Tagging, siehe 3.9d)
- Starred-Workflow
- Read-Later-Workflow
- Unread/Read State Tracking

**"Send to" — Export-Ziele (jeweils optional, pro Nutzer konfigurierbar):**
- **Obsidian:** kein API-Schlüssel nötig — Obsidian hat keine API, es ist eine lokale Vault-App. FeedFerret baut einen `obsidian://new`-Deep-Link mit dem Artikel als Markdown und übergibt ihn direkt ans bereits installierte Obsidian; keine Netzwerkanfrage, keine Zugangsdaten
- **Wallabag:** selbst gehostetes Read-Later — OAuth2, "Test Connection"-Button, Artikel landet als Markdown-Eintrag
- Erscheint als "Send to"-Aktion im Reader (Desktop-Toolbar + Mobile-Overflow-Menü), zeigt nur die vom Nutzer tatsächlich konfigurierten Ziele

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
- Delivery-Kanäle: In-App Bell, Browser Push, E-Mail, Outbound Webhook, Telegram, Gotify, ntfy
- Alert-History mit Read/Unread-Status
- Match-Count-Badge pro Alert

### 3.8 KI-Zusammenfassungen (BYOK, optional)

> **Standardmäßig aus.** Erst nach Eintragen eines eigenen API-Schlüssels sichtbar/nutzbar.

- Unterstützte Provider: OpenAI, Anthropic, Google Gemini, OpenRouter, **Ollama (komplett lokal, kein Cloud-Anbieter nötig)**
- Default-Modelle: gpt-4o-mini, claude-haiku, gemini-1.5-flash, llama3
- On-Demand-Zusammenfassung per Button im Reader
- Auto-Zusammenfassung beim Sync (eigenes Opt-in, mit Limit pro Sync)
- API-Schlüssel verschlüsselt gespeichert (AES-256-GCM)
- Sprache der Zusammenfassung konfigurierbar
- Zusammenfassungen in E-Mail-Digests (nur wenn dort ebenfalls aktiviert)

### 3.9 Feed Intelligence ⭐ — jede Webseite wird zum Feed

Das größte neue Feature-Paket. Kombiniert eine mehrstufige Extraktions-Engine mit optionaler KI-Unterstützung — **jede Stufe funktioniert eigenständig ohne KI**, KI beschleunigt lediglich die Einrichtung bzw. springt bei hartnäckigen Einzelfällen ein.

**3.9.1 Automatische Volltext-Extraktion**
- Wandelt gekürzte RSS-Feeds (nur Teaser) automatisch in vollständige Artikel um
- Mehrstufige, rein deterministische Engine ganz ohne KI: über 1.000 vorgefertigte Seiten-Regeln (FiveFilters `ftr-site-config`, CC0), Defuddle, Mozilla Readability, ein weiterer Extraktions-Algorithmus als vierte Stufe, sowie Wiederherstellung aus strukturierten Schema.org-Daten bei Paywall-/Teaser-Seiten
- Wählbares Speicherformat: Markdown oder HTML, pro Feed einstellbar
- Erkennt automatisch "diese Quelle liefert nur Teaser" und schlägt die Aktivierung vor
- Auto-Fetch beim Sync, oder manueller "Volltext holen"-Button

**3.9.2 "Seite → Feed"-Baukasten (Scout Studio)**
- Eine Listing-Seite (Blog-Index, Forum, Suchergebnisse) hat keinen eigenen RSS-Feed? URL einfügen → FeedFerret schlägt automatisch die passenden Auswahlregeln vor, mit Live-Vorschau
- Übernehmen speichert einen normalen, sich selbst aktualisierenden Feed — dedupliziert, exportierbar wie jeder andere Feed
- Funktioniert **komplett ohne KI** über eine heuristische Ranking-Engine
- Advanced-Modus: XPath, JSON, HTTP-Optionen, Unicity, Filter, Extended-OPML-Import/Export (`ffx:*`-Namespace, FreshRSS-kompatibel)

**3.9.3 KI-Konfigurationsvorschlag — "Paste-a-URL" (optional, BYOK)**
> **Standardmäßig aus.** Nur sichtbar, wenn ein eigener KI-Schlüssel hinterlegt ist.
- Beliebige URL einfügen → die KI analysiert die Seite und schlägt die komplette Konfiguration vor (Volltext-Selektor *oder* die komplette Seite→Feed-Konfiguration)
- **Der KI-Vorschlag wird nie blind übernommen** — er läuft immer zuerst durch die echte Extraktions-Engine zur Validierung, mit Live-Vorschau, bevor der Nutzer bestätigt
- Rate-limitiert, Kostenkontrolle durch Größenlimits auf den gesendeten Seiteninhalt

**3.9.4 KI-Auto-Tagging (optional, BYOK)**
> **Standardmäßig aus**, eigener Schalter unabhängig von der Zusammenfassungs-Funktion.
- Schlägt beim Sync bis zu vier kurze thematische Labels pro neuem Artikel vor
- Nutzt bestehende, vom Nutzer angelegte Labels bevorzugt weiter, statt Duplikate zu erzeugen ("KI" vs. "Künstliche Intelligenz")
- KI-vorgeschlagene Labels sind ganz normale Labels — erscheinen in denselben Badges, demselben Label-Filter, demselben Dropdown wie von Hand angelegte
- Begrenzt auf wenige Artikel pro Sync-Durchlauf (Kostenschutz)

**3.9.5 KI-Volltext-Extraktion als letzter Fallback (optional, BYOK, pro Feed)**
> **Standardmäßig aus**, muss pro Feed einzeln aktiviert werden.
- Wenn selbst die mehrstufige deterministische Engine (3.9.1) bei einer besonders unruhigen Seitenstruktur nichts findet, wird — nur für Feeds, die das explizit aktiviert haben — die bereits geladene Seite an den konfigurierten KI-Anbieter geschickt, um den Artikeltext direkt herauszuziehen
- Größen- und Token-limitiert, maximal 5 Artikel pro Sync-Durchlauf pro Feed

**3.9.6 Anti-Bot & Heavy-Fetch-Stack — vier gestaffelte, alle optionale Ebenen**
- **Ebene 0 (immer aktiv, kein Opt-in nötig):** Browser-Fingerprint-Fetches (echte Chrome-TLS/HTTP2-Signaturen) statt eines erkennbaren Bot-User-Agents
- **Ebene 1 (immer aktiv):** über 1.000 vorgefertigte Seiten-Regeln + strukturierte Daten-Wiederherstellung (siehe 3.9.1) — komplett in-process, kein zusätzlicher Dienst
- **Ebene 2 (optional, Admin-konfiguriert):** eigener Render-Sidecar (crawl4ai oder eine ~30-Zeilen-Playwright-Referenzimplementierung ist mitgeliefert) für Seiten, deren Inhalt erst durch JavaScript entsteht — läuft in einem eigenen Container, das Standard-Image bleibt unverändert (kein Browser darin)
- **Ebene 3 (optional, BYOK, pro Nutzer):** eigener API-Schlüssel für Jina Reader oder Firecrawl Cloud als allerletzter Fallback gegen aktive Anti-Bot-Systeme — inkl. kostenlosem Firecrawl-Tier ganz ohne Schlüssel zum Ausprobieren
- Jede Ebene ist einzeln per Kill-Switch abschaltbar; ohne jede Konfiguration bleibt reines In-Process-Fetching übrig — funktioniert für die überwiegende Mehrheit aller Feeds bereits vollständig

**3.9.7 RSSHub-Connector (optional, Admin-konfiguriert, selbst gehostet)**
- Eigene, selbst gehostete [RSSHub](https://docs.rsshub.app/)-Instanz anbinden (Basis-URL + optionaler Zugriffs-Schlüssel)
- "Aus dieser Plattform einen Feed bauen": YouTube-Kanal, Subreddit, GitHub-Repo-Releases u. v. m. — die passende RSSHub-Route wird gebaut (optional KI-unterstützt, immer echt validiert bevor sie übernommen wird)
- Ein RSSHub-Feed ist danach ein ganz normaler RSS-Feed — kein Sonderfall im Sync, Export oder Deduplizierung
- Komplett unsichtbar, solange kein Admin es einrichtet

**3.9.8 changedetection.io-Connector — "Diese Seite beobachten" (optional, Admin-konfiguriert, selbst gehostet)**
- Eigene, selbst gehostete [changedetection.io](https://changedetection.io)-Instanz anbinden
- Verwandelt **jede Seite** — auch komplett JS-gerenderte, da changedetection.io selbst rendert — in einen Feed ihrer eigenen Änderungen über Zeit: Preisänderungen, News-Updates, Stellenausschreibungen, Verfügbarkeits-Status u. v. m., auch ganz ohne jeden RSS-Feed der Quelle
- Optionaler KI-Konfigurationsvorschlag für den zu beobachtenden Seitenausschnitt (gleiche "AI schlägt vor, Engine validiert"-Logik wie überall sonst)
- Auch ein changedetection.io-Feed ist danach ein ganz normaler RSS-Feed — kein Sonderfall im Sync, Export oder Deduplizierung
- Komplett unsichtbar, solange kein Admin es einrichtet

### 3.10 Retention Policies & Feed Health

- Retention-Fenster pro Feed
- Dry-Run-Vorschau (welche Artikel würden gelöscht?)
- Geschützte Artikel: Starred + Labeled werden nie gelöscht
- Minimum Article Count pro Feed
- Health Dashboard: Artikelzahl, Unread-Count, Letzter Sync, Ø Artikel/Tag, Error Rate
- **Auto-Mute für dauerhaft fehlschlagende Feeds:** konfigurierbare Schwelle an aufeinanderfolgenden Fehlversuchen (Default 10, abschaltbar), danach stoppt der Hintergrund-Sync automatisch weitere Versuche gegen die tote URL und eine einmalige In-App-Benachrichtigung erklärt warum — "Jetzt aktualisieren" funktioniert trotzdem weiter und gibt dem Feed eine Chance zur Selbstheilung; manuelles Entstummen gibt eine "letzte Chance"

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

### 3.13b Externe Notification-Kanäle (jeweils optional)

- **Telegram:** Bot-API, MarkdownV2-Formatierung, per Keyword-Alert und Auto-Rule
- **Gotify:** Self-Hosted Push-Server, konfigurierbare Priorität
- **ntfy:** Self-Hosted oder ntfy.sh, Bearer-Token-Unterstützung für private Topics
- Alle Kanäle: per-Channel aktivieren/deaktivieren, Test-Button in Settings, fehlertolerant (fire-and-forget), standardmäßig alle deaktiviert

### 3.14 E-Mail-Digests

- Aktivieren/Deaktivieren pro User
- Frequenz, Wochentag und Uhrzeit konfigurierbar
- Scope-Filter: Alle Feeds, bestimmte Feeds/Kategorien
- Test-Digest senden
- Abmelde-Links in Digest-Mails
- KI-Zusammenfassungen in Digests (rein optional, siehe 3.8)

### 3.15 Flexible E-Mail-Delivery (jeweils optional konfigurierbar)

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
- Ganz ohne Mail-Provider läuft die App vollständig — Digests/Passwort-Reset-Mails sind dann einfach nicht verfügbar

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
- Token-Scopes: `read` / `write` / `admin`

**MCP Endpoint (`/api/mcp`):**
- JSON-RPC 2.0 über HTTP (Streamable HTTP)
- 28 Tools: vollständige CRUD-Kontrolle über Artikel, Feeds, Kategorien, Labels, Saved Searches, Alerts, Rules, Notifications, Stats
- Für AI-Agenten, Claude, GPT, LangChain etc. — **die Nutzung von MCP setzt keinerlei eigene KI-Konfiguration in FeedFerret voraus**, das Agent-System auf der anderen Seite bringt seine eigene KI mit

**Google Reader API:**
- Kompatibel mit Reeder, NetNewsWire, FeedMe, ReadKit
- Batch-Fetch via `POST stream/items/contents` (wie alle vier Clients es erwarten)
- Cursor-basierte Paginierung, Oldest-First-Sort (`r=o`), Older-Than-Filter (`ot`)
- Streams, Tags, Subscriptions, Preferences, echte Unread-Timestamps
- Per-Client Setup-Anleitungen in `docs/google-reader-api.md`

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
| `⌘K` / `Ctrl+K` | Command Palette |
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
- Conditional GET (ETag/Last-Modified) — nur geänderte Feeds werden neu geladen
- Externer Sync-API-Endpoint (`GET /api/sync`)
- Status-Endpoint (`GET /api/sync/status`)
- Admin UI: Sync-Interval und Status

### 3.20 Admin-Funktionen

- Benutzerverwaltung (Roles, Suspend/Reactivate, Löschen)
- Registrierungen global ein-/ausschalten
- E-Mail-Provider und Mail-Service konfigurieren (alle optional, s. 3.15)
- Instanz-Branding (Name, Icon/Logo)
- Admin-anpassbare Starter Packs (erstellen, bearbeiten, importieren, exportieren)
- SSRF-Einstellungen (Trusted Internal Feeds)
- Optionale Connector-Konfiguration: Render-Sidecar, RSSHub (jeweils per Schalter aktivierbar, standardmäßig unsichtbar, s. 3.9.6/3.9.7)
- Storage Dashboard (Artikel/Feeds pro Nutzer)
- SaaS Provisioning API (`/api/internal/*`)

### 3.21 Auth & Sicherheit

- Lokale E-Mail/Passwort-Accounts (inkl. Self-Service-Passwortänderung)
- Magic Link (Passwortlos via E-Mail)
- Google OAuth
- GitHub OAuth
- Authelia OIDC (für Homelab SSO)
- Optionales TOTP 2FA (für lokale Accounts), optional für Admins erzwingbar
- Verschlüsselte API-Credentials (AES-256-GCM), inkl. aller optionalen KI- und Connector-Schlüssel
- SSRF-Schutz für alle server-seitigen Fetches — auch für jeden optionalen Connector (Render-Sidecar, RSSHub, Hosted-Fetch)
- Content-Sanitization (DOMPurify)
- Automatisierte Barrierefreiheits-Prüfung (axe) als CI-Gate
- GDPR: Self-Service Account-Deletion (vollständiger Cascade)

### 3.22 Self-Hosting & Deployment

- Docker Compose mit PostgreSQL (Standard) oder SQLite
- Coolify-kompatibel (Docker Compose Deployment Type)
- Admin Onboarding Wizard (5-Schritt Setup)
- Automatische DB-Migrations via `prisma db push` beim Start
- Background Sync ohne externen Cron
- SQLite für minimale Infrastruktur, PostgreSQL für Produktion
- **Jede optionale Komponente (Render-Sidecar, alle KI-Provider, RSSHub) ist ein eigener, separat startbarer Container/Dienst — das Kern-Image bleibt davon unberührt und schlank**

---

## 4. Integrationen im Überblick — für Marketing explizit ausformuliert

**Kernbotschaft: FeedFerret braucht keine einzige der folgenden Integrationen. Jede ist eine bewusste Zusatzentscheidung — standardmäßig deaktiviert, jederzeit abschaltbar, nie Voraussetzung für den Betrieb.** Diese Tabelle sollte 1:1 als eigene Landing-Page-Sektion ("Integrationen" / "Bring your own everything") dienen — idealerweise mit den jeweiligen Provider-Logos.

### 4.1 KI-Provider (alle BYOK, alle optional)

| Provider | Genutzt für | Selbst gehostet möglich? |
|---|---|---|
| OpenAI | Zusammenfassungen, Feed-Konfiguration, Auto-Tagging, Volltext-Fallback | Nein (Cloud) |
| Anthropic (Claude) | s. o. | Nein (Cloud) |
| Google Gemini | s. o. | Nein (Cloud) |
| OpenRouter | s. o. (Zugriff auf viele Modelle über einen Schlüssel) | Nein (Cloud) |
| **Ollama** | s. o. | **Ja — komplett lokal, keine Daten verlassen das eigene Netzwerk** |

→ Botschaft: *"Nutze KI nur, wenn du willst. Mit deinem eigenen Schlüssel. Oder komplett lokal mit Ollama — dann verlässt kein einziges Wort deiner Artikel je deinen Server."*

### 4.2 Volltext- & Anti-Bot-Connectoren (alle optional)

| Connector | Zweck | Betrieb |
|---|---|---|
| Render-Sidecar (crawl4ai oder mitgelieferte Playwright-Referenz) | JS-gerenderte Seiten für Volltext/Seite→Feed | Admin-konfiguriert, eigener Container |
| Jina Reader (BYOK) | Letzter Fallback gegen aktive Anti-Bot-Systeme | Cloud, eigener Schlüssel |
| Firecrawl Cloud (BYOK, inkl. kostenlosem Tier ohne Schlüssel) | s. o. | Cloud, eigener oder kein Schlüssel |
| RSSHub | Plattform-Feeds (YouTube, Reddit, GitHub Releases, u. v. m.) | Selbst gehostet, Admin-konfiguriert |
| changedetection.io | Jede Seite als Änderungs-Feed (auch JS-gerendert) | Selbst gehostet, Admin-konfiguriert |

### 4.3 Auth-Provider (frei kombinierbar)

| Provider | Typ |
|---|---|
| E-Mail/Passwort (lokal) | Immer verfügbar |
| Magic Link | Braucht Mail-Provider (s. 4.4) |
| Google OAuth | Optional |
| GitHub OAuth | Optional |
| Authelia (OIDC) | Optional, Homelab-SSO |
| TOTP 2FA | Optional, pro Nutzer oder für Admins erzwingbar |

### 4.4 Mail-Provider (jeweils optional, frei wählbar)

SMTP · Resend · Postmark · Mailgun · SendGrid — ohne jeden dieser Provider läuft FeedFerret vollständig, nur E-Mail-Digests/Passwort-Reset-Mails entfallen dann.

### 4.5 Externe Notification-Kanäle (jeweils optional, einzeln aktivierbar)

Browser Push (VAPID) · E-Mail · Telegram · Gotify · ntfy · Outbound-Webhooks (HMAC-signiert, für n8n/Zapier/eigene Systeme)

### 4.6 Native-Client- & Automatisierungs-Schnittstellen

| Schnittstelle | Für wen |
|---|---|
| Google Reader API | Reeder, NetNewsWire, FeedMe, ReadKit — jeder Google-Reader-kompatible Client |
| REST API v1 | Eigene Skripte, Automatisierungen, mobile Zweit-Clients |
| MCP-Endpoint (28 Tools) | AI-Agenten — Claude, GPT, LangChain, jedes MCP-fähige Tool |
| Outbound Webhooks | n8n, Zapier, eigene Endpunkte |
| OPML Import/Export | Migration von/zu jedem anderen RSS-Reader |
| PWA Share-Target | "Share → FeedFerret" aus jeder installierten App direkt ins OS-Share-Sheet |

### 4.7 Export-Ziele — "Send to" (jeweils optional, pro Nutzer konfigurierbar)

| Ziel | Zweck | Zugangsdaten |
|---|---|---|
| Obsidian | Artikel als Markdown in die lokale Vault übernehmen | Keine — reiner `obsidian://`-Deep-Link, keine API |
| Wallabag | Artikel ins selbst gehostete Read-Later sichern | OAuth2 (Client-ID/Secret + Nutzername/Passwort) |

**Ein-Satz-Zusammenfassung für die Landing Page:**
> Jede KI-Funktion ist optional und BYOK. Jeder Connector ist optional und einzeln abschaltbar. Kein einziger externer Dienst ist Voraussetzung — FeedFerret läuft komplett autark, und wächst nur so weit mit externen Diensten mit, wie du es zulässt.

---

## 5. Landing Page Architektur

### Empfohlene Sektionsreihenfolge

```
1. Hero
2. Proof / Trust Signals
3. Reading Experience
4. Feed Intelligence ⭐ NEU — "Jede Webseite wird zum Feed"
5. Mobile & PWA
6. Organization (Feeds, Categories, Labels)
7. Power-User (Rules, Alerts, Search, API, Webhooks)
8. Integrations ⭐ NEU — "Bring your own everything" (KI optional, Connectoren optional)
9. Native Client Compatibility
10. Self-Hosting & Admin
11. Authentication & Security
12. Pricing
13. FAQ
14. CTA
```

### Sektion 1: Hero

**Headline-Varianten (zum Testen):**
- "The self-hosted RSS reader that finally feels modern."
- "Own your feeds. Enjoy reading again."
- "A beautiful RSS reader for self-hosters and power users."
- "Your personal reading command center."
- **NEU:** "Paste a URL. Get a feed. Even if it never had one."
- **NEU:** "Every website has an RSS feed now. Yours just doesn't know it yet."

**Subheadline:**
> Read, filter, organize, and automate your RSS feeds — on your own server, in a polished interface built for both desktop and mobile. Turn any web page into a feed, with AI as an optional assist — never a requirement.

**CTA-Buttons:**
- Primary: "Deploy with Docker" → `#deploy`
- Secondary: "See the features" → `#features`

**Hero Asset:** Desktop-Screenshot mit Reader + Feed-Liste (3-Spalten-Layout, Dark Mode)

### Sektion 2: Trust Signals

- GitHub Stars
- Docker Pulls
- "Used by X self-hosters" (wenn verfügbar)
- Frühe Nutzer-Quotes / Testimonials
- "Open Source, AGPL-3.0 License"
- Kompatible App-Icons: Reeder, NetNewsWire, n8n, etc.
- "AI optional — bring your own key, or none at all"

### Sektion 3: Reading Experience

**Headline:** "Built for actual reading, not just feed storage."

Content:
- Screenshot: Article Reader (Desktop, Light Mode)
- Screenshot: Article Reader (Mobile, Dark Mode)
- Feature-Bullets: Multiple Layouts, Reader Width, Mark-as-Read Timing, Dark Mode, Keyboard Navigation, rich rendering (tables/code/math)

### Sektion 4: Feed Intelligence ⭐ NEU

**Headline:** "No RSS feed? We'll build one."

Content:
- Screenshot/GIF: URL einfügen → vorgeschlagene Konfiguration → Live-Vorschau → Feed gespeichert
- Feature-Bullets: Automatische Volltext-Extraktion (über 1.000 vorgefertigte Seiten-Regeln, kein KI nötig), Seite→Feed-Baukasten, **optionaler** KI-Konfigurationsvorschlag ("Paste a URL, AI sets it up"), **optionaler** KI-Volltext-Fallback für hartnäckige Seiten, **optionaler** RSSHub-Connector für Plattformen (YouTube, Reddit, GitHub Releases), **optionaler** changedetection.io-Connector ("jede Seite als Änderungs-Feed beobachten")
- Durchgängiger Hinweis-Chip: **"AI-assisted, never AI-required"**

### Sektion 5: Mobile & PWA

**Headline:** "A self-hosted RSS reader that actually feels good on a phone."

Content:
- iPhone Screenshot: Bottom Navigation + Reader
- Android Screenshot: Feed-Liste
- Feature-Bullets: Swipe-Gesten, PWA Install, Offline-Fallback, One-Handed Reading, **Share-Target** ("Share → FeedFerret" aus jeder App)

### Sektion 6: Organize Everything

**Headline:** "Use categories for structure, labels for meaning, saved searches for intelligence."

Content:
- Screenshot: Sidebar mit Kategorien + Labels
- Screenshot: Saved Search Sharing
- Feature-Grid: Feeds, Categories, Labels (inkl. optionalem KI-Auto-Tagging), Saved Searches, Shared Searches

### Sektion 7: Power-User Features

**Headline:** "From inbox-style reading to research automation."

Feature-Cards (je mit Icon + kurzer Beschreibung):
- **Smart Rules:** Auto-mark, star, label — with preview before enabling
- **Keyword Alerts:** Notify via push, email, or webhook when articles match
- **Advanced Search:** 15+ search tokens, save and share as RSS
- **REST API + MCP:** Automate via n8n, connect AI agents
- **Outbound Webhooks:** HMAC-signed, with retry logic
- **AI Summaries (optional):** BYOK — OpenAI, Anthropic, Gemini, or fully local via Ollama
- **AI Auto-Tagging (optional):** propose labels on sync, reuses your existing ones
- **Full-Text Extraction:** works fully without AI; AI is an optional last-resort fallback
- **Feed Health:** Stats, error rates, retention policies, auto-mute for feeds that keep failing
- **Send to (optional):** push any article straight to Obsidian or Wallabag

### Sektion 8: Integrations ⭐ NEU — "Bring your own everything"

**Headline:** "Every integration is optional. FeedFerret works completely without any of them."

Content: die fünf Karten-Reihen aus Abschnitt 4 (KI-Provider, Volltext-/Änderungs-Connectoren, Auth-Provider, Notification-Kanäle, Export-Ziele) als Logo-Grid, jeweils mit "optional"-Badge. Kernaussage prominent wiederholen.

### Sektion 9: Native Client Compatibility

**Headline:** "Use FeedFerret as your server backend while keeping your favorite RSS client."

Content:
- App-Icons: Reeder, NetNewsWire, FeedMe, ReadKit
- "Google Reader API compatible"
- Code-Snippet: Base URL konfigurieren

### Sektion 10: Self-Hosting & Admin

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
- Keine externen Dienste erforderlich — alle Connectoren optional nachrüstbar

### Sektion 11: Auth & Security

**Headline:** "Sign in your way. Keep your data private."

- Login-Optionen-Grid: Password, Magic Link, Google, GitHub, Authelia OIDC
- Optional TOTP 2FA
- "Your data stays on your server"
- GDPR: Vollständige Account-Löschung
- AES-256-GCM verschlüsselte API-Credentials (inkl. jedes optionalen KI-/Connector-Schlüssels)
- SSRF-Schutz für Feed-Fetching und jeden optionalen Connector

### Sektion 12: Preise

**Self-Hosted (Kostenlos, AGPL-3.0-only):**
- Alle Features, inklusive der gesamten Feed-Intelligence-Säule
- Unbegrenzte Nutzer
- PostgreSQL oder SQLite
- Community-Support via GitHub Issues
- Alle KI-Funktionen optional und BYOK — keine versteckten Nutzungskosten seitens FeedFerret selbst

**SaaS — coming soon:**

> **Status:** Die SaaS-Variante ist nach dem OSS-Launch geplant. Tier-Definition und Pricing werden nach Abschluss der Wettbewerbsanalyse finalisiert.

Erwartete Tiers:
- **Personal** — Managed Hosting für Einzelnutzer, automatische Updates, E-Mail-Support
- **Team** — Mehrere Nutzer mit Isolation, Priority-Support, SSO

Für die OSS-Landing Page zum Launch: SaaS-Sektion als "Coming Soon"-Teaser mit Mail-Capture (z.B. Listmonk, Mailchimp, Buttondown) statt fester Preise rendern.

### Sektion 13: FAQ

Top-Fragen (Entwurf, erweitert):
1. Was ist der Unterschied zwischen Self-Hosted und dem SaaS-Angebot?
2. Kann ich meine Feedly/Inoreader-Abonnements importieren?
3. Welche nativen RSS-Apps sind kompatibel?
4. Wie werden meine Daten gesichert?
5. Brauche ich technisches Wissen für den Self-Hosted-Betrieb?
6. **Brauche ich einen KI-Schlüssel, um FeedFerret zu nutzen?** → Nein. Jede KI-Funktion ist optional und standardmäßig deaktiviert. FeedFerret ist ein vollwertiger RSS-Reader ganz ohne KI.
7. **Was passiert mit meinen Daten, wenn ich KI-Funktionen aktiviere?** → Nur der jeweils angefragte Artikel-/Seiteninhalt geht an den von dir selbst gewählten Anbieter, mit deinem eigenen Schlüssel. Mit Ollama bleibt alles komplett lokal.
8. **Kann ich einen Feed für eine Seite ohne RSS erstellen?** → Ja, über den Seite→Feed-Baukasten — auch ganz ohne KI.

### Sektion 14: CTA

- "Deploy FeedFerret" → GitHub Repo
- "Try the SaaS version" → Signup
- "Read the Docs" → Dokumentation

---

## 6. Marketing-Copy Entwürfe

### Kurzbeschreibungen

**1 Satz:**
> FeedFerret ist ein selbst hostbarer RSS-Reader, der mit optionaler KI-Unterstützung sogar Webseiten ganz ohne eigenen Feed automatisch zu Feeds macht.

**2-3 Sätze:**
> FeedFerret ist ein polierter, selbst hostbarer RSS-Reader für Nutzer, die Datenschutz, Kontrolle und ein besseres Leseerlebnis wollen. Er kombiniert mobiles Design, Labels, Saved Searches, Automatisierungs-Rules, E-Mail-Digests, flexible Auth und native Client-Kompatibilität mit einer kompletten "Feed Intelligence"-Engine, die praktisch jede Webseite zu einem Feed macht. Jede KI-Funktion und jeder externe Connector ist dabei rein optional und mit deinem eigenen Schlüssel nutzbar — nichts davon ist Voraussetzung.

**Ausführlich (ProductHunt / Press):**
> FeedFerret ist eine Self-Hosted RSS-Plattform für ernsthafte Leser. Sammle und organisiere Feeds, filtere automatisch Rauschen heraus, speichere und teile leistungsstarke Suchen, lies komfortabel auf Desktop und Mobile, installiere die App als PWA, verbinde native RSS-Clients via Google Reader API, und verwalte Auth via lokale Accounts, 2FA, OAuth oder Authelia. Hat eine Seite keinen eigenen RSS-Feed? FeedFerret baut dir automatisch einen — mit oder ohne optionale KI-Unterstützung (Bring-Your-Own-Key, inkl. komplett lokalem Betrieb via Ollama). Gebaut um leistungsstark zu sein ohne veraltet zu wirken, und ohne dass eine einzige der optionalen Integrationen je zur Pflicht wird.

### ProductHunt-Tagline (Entwurf)

> The self-hosted RSS reader that turns any web page into a feed — AI-assisted, never AI-required

### Vergleichs-Positionierung

| Vergleich | Positionierung |
|---|---|
| vs. Feedly | FeedFerret ist self-hosted, keine Daten auf fremden Servern, kein SaaS-Abo, KI komplett optional statt eingebaut |
| vs. Inoreader | Gleiche Power-Features, aber vollständig unter deiner Kontrolle |
| vs. Miniflux | Modernere UX, Mobile-First, optionale KI-Integration, Google Reader API, "Seite → Feed"-Baukasten |
| vs. FreshRSS | Schöneres Interface, bessere Mobile UX, API, Webhooks, optionale KI, mehrstufige Volltext-Engine |

---

## 7. Was seit v1.1.0 neu ist (Release-Highlights, Stand 2026-07-20)

> Package-Version ist zum Zeitpunkt dieses Updates noch auf `1.1.0` gepinnt — die untenstehende Arbeit liegt komplett im `CHANGELOG.md`-Abschnitt "Unreleased" und wartet auf eine Versions-Entscheidung. Für die Landing Page: den tatsächlichen Feature-Stand kommunizieren, unabhängig vom Versions-Label.

### Feed Intelligence (komplett neue Produktsäule)

| Feature | Botschaft | Optional? |
|---|---|---|
| **Automatische Volltext-Extraktion** | Gekürzte Feeds werden automatisch vollständig — 4-stufige Engine + 1.000+ Seiten-Regeln, ganz ohne KI | Nein — Kern-Feature |
| **"Seite → Feed"-Baukasten** | Jede Listing-Seite ohne RSS wird zum sich selbst aktualisierenden Feed | Nein — Kern-Feature |
| **KI-Konfigurationsvorschlag ⭐** | "Paste a URL, AI sets up the whole feed" — validiert, nie blind übernommen | **Ja, BYOK** |
| **KI-Auto-Tagging** | Automatische Label-Vorschläge beim Sync | **Ja, BYOK** |
| **KI-Volltext-Fallback** | Letzter Rettungsanker für hartnäckige Einzelseiten, pro Feed aktivierbar | **Ja, BYOK** |
| **RSSHub-Connector** | YouTube/Reddit/GitHub Releases & Co. werden zu Feeds | **Ja, selbst gehostet** |
| **changedetection.io-Connector ⭐ NEU** | Jede Seite als Änderungs-Feed beobachten, auch JS-gerendert | **Ja, selbst gehostet** |
| **4-stufiger Anti-Bot-Stack** | Fingerprinting → Seiten-Regeln → Render-Sidecar → Hosted-BYOK-Fetch | **Stufen 2+3 optional** |
| **Erkennung gekürzter Feeds** | Erkennt automatisch "diese Quelle liefert nur Teaser" und schlägt Aktivierung vor | Nein — Kern-Feature |

### Neue Quick Wins (NEU, 2026-07-20)

| Feature | Botschaft | Optional? |
|---|---|---|
| **"Send to" Obsidian & Wallabag** | Artikel per Klick in die eigene Notiz-App oder das eigene Read-Later übernehmen | **Ja, pro Nutzer** |
| **Feed-Auto-Mute** | Dauerhaft fehlschlagende Feeds werden automatisch stummgeschaltet statt endlos weiterzuversuchen | Nein — Kern-Feature (Schwelle konfigurierbar/abschaltbar) |
| **PWA Share-Target** | "Share → FeedFerret" aus jeder App — landet direkt im Seite→Feed-Baukasten | Nein — Kern-Feature der PWA |

### Sicherheit & Robustheit (zweite Härtungsrunde)

| Fix | Details |
|---|---|
| **`AUTH_SECRET` fail-closed** | Kein unsicherer Hardcoded-Fallback mehr im Produktivbetrieb |
| **Größenlimits auf allen neuen Fetch-Pfaden** | Volltext/Seite→Feed/KI-Fetches jeweils size-/timeout-begrenzt |
| **Markdown-Artikel werden vor externer API-Auslieferung sanitisiert** | Fever, REST v1, Google Reader API liefern nie rohes Markdown an Drittclients |
| **Diverse Scoping-Fixes** | Fever-Pivots, Summarize-Update, XPath-Class-Escaping, `rel=noopener` erzwungen |

### Qualität & Performance

| Feature | Botschaft |
|---|---|
| **Indizierte Volltextsuche** | SQLite FTS5-Trigram / PostgreSQL `pg_trgm` statt einfachem `LIKE` |
| **Zwei komplette UX/A11y-Audit-Runden** | 54 + 26 Befunde, alle behoben — Dark-Mode-Fixes, Self-Service-Passwortänderung, axe-CI-Gate |
| **Listen-Virtualisierung & Sync-Batching** | Spürbar schnellere lange Artikellisten und Feed-Syncs |

### Features aus v1.1.0 (weiterhin landing-page-relevant)

| Feature | Botschaft |
|---|---|
| **DE + EN vollständig übersetzt** | Alle Strings in Deutsch und Englisch |
| **REST API v1 + 28 MCP-Tools** | Vollständige CRUD-Kontrolle für Automatisierung und AI-Agenten |
| **OR-Operator in Suche/Rules** | `nextcloud OR tailscale` |
| **Outbound Webhooks** | HMAC-signiert, mit Retry-Logik |
| **Keyword Alerts + Telegram/Gotify/ntfy** | Homelab-native Notification-Kanäle |
| **Google Reader API (vollständig)** | Reeder, NetNewsWire, FeedMe, ReadKit |
| **Duplicate Detection** | Cross-Feed-Deduplizierung |
| **Feed Discovery + Admin Starter Packs** | Schneller Einstieg für neue Nutzer |

---

## 8. Screenshot-Anforderungen

Benötigte Assets für Launch:

| Asset | Spezifikation | Priorität |
|---|---|---|
| Hero Screenshot Desktop | 1440×900, Light + Dark | Kritisch |
| Reader Desktop | 1440×900, Light + Dark | Kritisch |
| **Feed Intelligence Flow** (URL → Vorschlag → Vorschau → gespeichert) | GIF oder 3–4 Standbilder | **Kritisch, NEU** |
| Mobile Reader iPhone | 393×852 (iPhone 15 Pro), Light + Dark | Kritisch |
| Mobile Feed-Liste | 393×852, Light + Dark | Hoch |
| **"Send to"-Menü** (Reader-Toolbar mit Obsidian/Wallabag-Optionen) | 1 Standbild, Light + Dark | Mittel, NEU |
| Integrations-Logo-Grid (KI-Provider, Connectoren inkl. changedetection.io, Export-Ziele) | Vektorgrafik/SVG-Set | Hoch, NEU |
| OG Image | 1200×630, Logo + Tagline | Kritisch |
| ProductHunt Gallery | 5 Bilder à 1270×952 | Hoch |
| Favicon Set | bereits vorhanden ✓ | — |
| Apple Touch Icon | bereits vorhanden ✓ | — |

---

## 9. SEO-Zielseiten

Empfohlene Seiten für organische Reichweite:

- `/` — Haupt-Landing Page
- `/self-hosting` — Self-Hosting Guide
- `/feed-intelligence` — **NEU:** eigene Seite für "jede Website wird zum Feed", inkl. KI-optional-Botschaft
- `/compare/feedly` — FeedFerret vs. Feedly
- `/compare/inoreader` — FeedFerret vs. Inoreader
- `/compare/miniflux` — FeedFerret vs. Miniflux
- `/blog/rss-reader-2026` — "Best Self-Hosted RSS Readers 2026"
- `/blog/websites-without-rss` — **NEU:** "How to get an RSS feed for any website (no coding required)"
- `/docs` — Dokumentations-Hub
- `/changelog` — Release Notes

---

## 10. Launch-Kanäle (Empfehlung)

| Kanal | Timing | Format |
|---|---|---|
| GitHub Release | Launch-Tag | Changelog + Screenshots |
| ProductHunt | Launch-Tag | Launch mit Gallery + Demo-GIF (Feed-Intelligence-Flow im Zentrum) |
| Hacker News (Show HN) | Launch-Tag oder +1 Tag | Kurzer Pitch + Tech-Stack, "AI optional" explizit erwähnen (HN reagiert allergisch auf KI-Zwang) |
| Reddit r/selfhosted | Launch-Woche | Screenshot-Post, Fokus auf "kein KI-Zwang, alles optional" |
| Reddit r/rss | Launch-Woche | Feature-Fokus, Seite→Feed-Baukasten hervorheben |
| Twitter/X | Laufend | Screenshots, Quick-Tips |
| Mastodon / Fediverse | Laufend | Self-Hosting Community, KI-Optionalität explizit betonen (Fediverse ist KI-skeptisch) |
