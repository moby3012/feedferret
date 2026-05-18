# FeedFerret selbst hosten

Diese Anleitung beschreibt die vollständige Installation und den Betrieb von FeedFerret auf einem eigenen Server.

---

## Voraussetzungen

| Anforderung | Details |
|---|---|
| **Docker** | Version 24+ mit Docker Compose Plugin (v2) |
| **RAM** | Mindestens 512 MB, 1 GB empfohlen |
| **Port** | 3000 (oder beliebiger freier Port, konfigurierbar) |
| **Alternativ** | [Coolify](https://coolify.io/) — unterstützt Git-basiertes Deployment direkt aus dem Repository |

> **Hinweis zu Coolify:** FeedFerret lässt sich als Docker-Compose-Service in Coolify deployen. Umgebungsvariablen werden im Coolify-Dashboard statt in einer `.env`-Datei gesetzt.

---

## Deployment mit Coolify

[Coolify](https://coolify.io/) ist eine selbst gehostete PaaS-Plattform, die Git-basiertes Deployment mit automatischen SSL-Zertifikaten und einer Web-UI für Umgebungsvariablen bietet.

### Schritt-für-Schritt

**1. Neues Projekt in Coolify anlegen**

1. Coolify öffnen → *Projects* → *Add New Project*
2. *Add New Resource* → **Docker Compose**
3. Als Source **GitHub** (oder deine Git-Instanz) auswählen und das `feedferret`-Repository verbinden

**2. Deployment-Typ konfigurieren**

- Deployment Type: **Docker Compose**
- Docker Compose File: `docker-compose.yaml` (im Root des Repos)
- Branch: `main`

> **Wichtig:** Keinen eigenen `networks:`-Block im `docker-compose.yaml` definieren. Coolify fügt seinen eigenen Traefik-Netzwerk-Eintrag automatisch hinzu. Ein hardkodiertes custom Bridge-Netzwerk isoliert die Container von Traefik und führt zu *Gateway Timeout*-Fehlern. Das mitgelieferte `docker-compose.yaml` ist bereits korrekt konfiguriert.

**3. Umgebungsvariablen im Coolify-Dashboard setzen**

Statt einer `.env`-Datei werden die Variablen in *Environment Variables* eingegeben. Pflichtfelder:

| Variable | Beschreibung | Beispiel |
|---|---|---|
| `AUTH_SECRET` | Session-Schlüssel (32+ Zeichen) | `openssl rand -base64 32` |
| `AUTH_URL` | Öffentliche URL der Instanz | `https://rss.example.com` |
| `AUTH_TRUST_HOST` | Muss `true` sein hinter Coolify-Traefik | `true` |
| `POSTGRES_PASSWORD` | DB-Passwort (PostgreSQL-Modus) | zufälliger String |

Optionale Variablen (OAuth, E-Mail, VAPID) können ebenfalls hier gesetzt werden — alle Felder aus dem Abschnitt *Umgebungsvariablen* weiter unten funktionieren identisch.

**4. Domain konfigurieren**

In Coolify unter *Domains* die gewünschte Domain eintragen. Coolify stellt automatisch ein Let's Encrypt-Zertifikat aus.

**5. Deploy**

*Deploy* klicken — Coolify baut das Image, startet die Container und richtet HTTPS ein. Der Build dauert beim ersten Mal 3–5 Minuten.

### Troubleshooting Coolify

| Problem | Ursache | Lösung |
|---|---|---|
| *Gateway Timeout* nach Deploy | Custom `networks:` Block im Compose | `networks:` Abschnitt aus `docker-compose.yaml` entfernen — Coolify verwaltet Netzwerke selbst |
| Login schlägt fehl / CSRF-Fehler | `AUTH_TRUST_HOST` fehlt | `AUTH_TRUST_HOST=true` in Coolify-Env-Variablen setzen |
| `AUTH_URL` wird ignoriert | Coolify setzt keine `AUTH_URL` | Manuell in den Environment Variables setzen mit dem vollen `https://`-Präfix |
| Build schlägt mit `prisma generate` fehl | Cache-Problem | In Coolify *Force Rebuild* aktivieren und erneut deployen |
| PostgreSQL-Password-Fehler nach Rebuild | Volume mit altem Passwort vorhanden | In Coolify *Volumes* das PostgreSQL-Volume löschen und neu deployen (alle Daten gehen verloren — vorher Backup machen!) |

---

## Schnellstart (5 Minuten)

```bash
# 1. Repository klonen
git clone https://github.com/moby3012/feedferret.git && cd feedferret

# 2. Env-Datei anlegen
cp .env.example .env

# 3. Drei Pflichtfelder setzen (siehe unten)
nano .env

# 4. Stack starten
docker compose up -d --build
```

Danach unter `http://localhost:3000` (oder deiner konfigurierten Domain) den Setup-Wizard durchlaufen.

---

## Umgebungsvariablen

### Pflichtfelder

Diese drei Variablen **müssen** vor dem ersten Start gesetzt werden:

| Variable | Beschreibung | Beispiel |
|---|---|---|
| `AUTH_SECRET` | Geheimer Schlüssel für Sessions und verschlüsselte DB-Felder | `openssl rand -base64 32` |
| `AUTH_URL` | Öffentliche URL der Instanz (mit Protokoll, ohne Slash am Ende) | `https://rss.example.com` |
| `POSTGRES_PASSWORD` | Passwort für die PostgreSQL-Datenbank | `sicheres-passwort-hier` |

**`AUTH_SECRET` generieren:**

```bash
openssl rand -base64 32
```

> **Wichtig:** `AUTH_SECRET` muss über alle Deploys hinweg stabil bleiben. FeedFerret verwendet diesen Schlüssel zum Verschlüsseln gespeicherter API-Zugangsdaten (z. B. KI-Zusammenfassungs-Credentials). Ändert man ihn, werden verschlüsselte Daten in der Datenbank unlesbar.

**Minimales `.env` für den Start:**

```env
AUTH_SECRET="dein-generierter-schluessel"
AUTH_URL="https://rss.example.com"
AUTH_TRUST_HOST=true
POSTGRES_PASSWORD="sicheres-passwort-hier"
```

---

### Optionale Variablen

#### OAuth-Anmeldung

Für die Anmeldung über externe Identitätsprovider. Weitere Details in [`docs/self-hosting-auth-email.md`](./self-hosting-auth-email.md).

```env
# Google OAuth
GOOGLE_CLIENT_ID="deine-client-id.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="dein-google-secret"

# GitHub OAuth
GITHUB_CLIENT_ID="deine-github-client-id"
GITHUB_CLIENT_SECRET="dein-github-secret"
```

#### OIDC (z. B. Authelia, Keycloak)

```env
AUTHELIA_CLIENT_ID="feedferret"
AUTHELIA_CLIENT_SECRET="dein-oidc-secret"
AUTHELIA_ISSUER="https://auth.example.com"
AUTHELIA_PROVIDER_NAME="Authelia"
```

#### E-Mail-Versand

Zugangsdaten können hier per ENV oder im Admin-UI (unter *Server Management → E-Mail*) konfiguriert werden. Werte aus der Datenbank haben Vorrang.

```env
# Resend
RESEND_API_KEY="re_xxxxxxxxxxxx"
RESEND_FROM_EMAIL="FeedFerret <noreply@example.com>"

# Postmark
POSTMARK_SERVER_TOKEN="dein-postmark-token"
POSTMARK_FROM_EMAIL="noreply@example.com"
POSTMARK_MESSAGE_STREAM="outbound"

# Mailgun
MAILGUN_API_KEY="dein-mailgun-key"
MAILGUN_DOMAIN="mg.example.com"
MAILGUN_FROM_EMAIL="FeedFerret <noreply@example.com>"
MAILGUN_BASE_URL="https://api.mailgun.net"

# SendGrid
SENDGRID_API_KEY="SG.xxxxxxxxxxxx"
SENDGRID_FROM_EMAIL="noreply@example.com"

# SMTP (jeder SMTP-Anbieter)
SMTP_HOST="smtp.example.com"
SMTP_PORT="587"
SMTP_USER="noreply@example.com"
SMTP_PASSWORD="smtp-passwort"
SMTP_FROM="FeedFerret <noreply@example.com>"
```

#### Browser-Push-Benachrichtigungen (Web Push / VAPID)

```bash
# VAPID-Schlüsselpaar generieren:
pnpm run webpush:keys
```

```env
WEB_PUSH_VAPID_PUBLIC_KEY="dein-oeffentlicher-vapid-schluessel"
WEB_PUSH_VAPID_PRIVATE_KEY="dein-privater-vapid-schluessel"
WEB_PUSH_CONTACT="mailto:admin@example.com"
```

#### Sonstiges

```env
# 2FA-Label in Authenticator-Apps
TOTP_ISSUER="FeedFerret"

# Feed-Sync-Schutz (optionales Shared Secret für den Sync-Endpunkt)
SYNC_SECRET="zufaelliger-string"

# SSRF-Schutz (nur auf vertrauenswürdigen Single-Tenant-Instanzen deaktivieren)
TRUSTED_FEED_FETCHING="false"
ALLOW_INTERNAL_FEED_URLS="false"
```

---

## Erster Start und Setup-Wizard

Nach `docker compose up -d --build` unter der konfigurierten URL aufrufen. Der Setup-Wizard führt in 5 Schritten durch die Erstkonfiguration:

1. **Admin-Konto anlegen** — E-Mail-Adresse und Passwort für das erste Administratorkonto festlegen.
2. **Instanzeinstellungen** — Name der Instanz, öffentliche URL, Registrierungsmodus (offen / Einladung / geschlossen).
3. **E-Mail konfigurieren** (optional) — SMTP- oder API-Zugangsdaten für Passwort-Reset-Mails und Benachrichtigungen eintragen. Kann übersprungen und später nachgeholt werden.
4. **Sicherheitseinstellungen** — 2FA-Pflicht, Session-Dauer, Datenschutzoptionen.
5. **Fertig & Starter-Pakete** — Auf dem letzten Schritt können vorkonfigurierte Feed-Sammlungen (Starter Packs) nach Thema gewählt werden, um die Instanz direkt mit Inhalten zu befüllen.

---

## Updates einspielen

```bash
# Neuestes Image holen und Container neu starten
docker compose pull && docker compose up -d --build
```

FeedFerret führt Datenbankmigrationen beim Start automatisch aus. Kein manueller Migrationsschritt nötig.

---

## Backup

### PostgreSQL (Standard)

```bash
# Datenbank-Dump erstellen
docker exec feedferret-postgres pg_dump \
  -U feedferret \
  -d feedferret \
  > feedferret_backup_$(date +%Y%m%d_%H%M%S).sql

# Dump wieder einspielen (in eine leere Datenbank)
docker exec -i feedferret-postgres psql \
  -U feedferret \
  -d feedferret \
  < feedferret_backup_2024_01_01_120000.sql
```

Für automatisierte Backups empfiehlt sich ein Cron-Job oder ein Tool wie [pgbackuper](https://github.com/2ndquadrant-it/barman) bzw. Restic mit dem obigen `pg_dump`-Befehl.

### SQLite

Das gesamte Datenbankvolume als Tar-Archiv sichern:

```bash
# Volume-Inhalt sichern
docker run --rm \
  -v feedferret_db_data:/data \
  -v $(pwd):/backup \
  alpine tar czf /backup/feedferret_sqlite_backup_$(date +%Y%m%d_%H%M%S).tar.gz -C /data .
```

---

## SQLite-Modus

FeedFerret unterstützt SQLite als Alternative zu PostgreSQL — ideal für Einzelpersonen oder Testinstanzen ohne extra Datenbankdienst.

**1. `.env` anpassen:**

```env
DATABASE_PROVIDER="sqlite"
DATABASE_URL="file:/app/data/dev.db"
```

Die Variablen `POSTGRES_DB`, `POSTGRES_USER` und `POSTGRES_PASSWORD` werden im SQLite-Modus nicht benötigt.

**2. `docker-compose.yaml` anpassen:**

Den auskommentierten Volume-Eintrag aktivieren und den `postgres`-Service sowie den `depends_on`-Block entfernen oder auskommentieren:

```yaml
volumes:
  feedferret_postgres_data:
  feedferret_db_data:   # <-- diese Zeile einkommentieren
```

Im `feedferret`-Service das Volume einbinden:

```yaml
services:
  feedferret:
    # ...
    volumes:
      - feedferret_db_data:/app/data
```

Den `postgres`-Service und den `depends_on`-Block im `feedferret`-Service können dann vollständig entfernt werden.

> **Hinweis:** Ein späterer Wechsel von SQLite zu PostgreSQL erfordert einen manuellen Datenexport (OPML/JSON) und Reimport. Es gibt kein automatisches Migrationswerkzeug.

---

## Troubleshooting

| Problem | Ursache | Lösung |
|---|---|---|
| Login schlägt fehl / `CSRF`-Fehler hinter Reverse Proxy | `AUTH_TRUST_HOST` nicht gesetzt | `AUTH_TRUST_HOST=true` in `.env` setzen |
| Port 3000 bereits belegt | Anderer Dienst nutzt den Port | `PORT=3001` in `.env` setzen und `ports:` in `docker-compose.yaml` auf `"3001:3001"` ändern |
| `Connection refused` zur Datenbank beim Start | PostgreSQL noch nicht bereit | Container-Logs prüfen: `docker compose logs postgres`; der Health-Check sollte das automatisch abfangen |
| `password authentication failed for user "feedferret"` | `POSTGRES_PASSWORD` in `.env` stimmt nicht mit dem beim ersten Start gesetzten Passwort überein | Volume löschen (`docker compose down -v`) und neu starten **oder** Passwort in der DB manuell zurücksetzen |
| Build schlägt fehl (`ENOENT`, `prisma generate`) | Unvollständiger Clone oder Node-Module-Konflikt | `docker compose build --no-cache` ausführen |
| Bilder / Assets laden nicht | `AUTH_URL` falsch konfiguriert | `AUTH_URL` muss exakt der öffentlich erreichbaren URL entsprechen (inkl. `https://`) |
| Container startet, aber Health-Check schlägt fehl | Anwendung braucht länger zum Starten | `start_period` im Health-Check erhöhen oder Logs prüfen: `docker compose logs feedferret` |

---

## Docker Image Architektur

Das `Dockerfile` verwendet vier Stages:

| Stage | Basis | Zweck |
|---|---|---|
| `base-runtime` | `node:22-slim` + openssl, curl | Gemeinsame Laufzeit-Basis (kein Build-Tooling) |
| `base-build` | `base-runtime` + python3, make, g++ | Basis für alle Build-Stages |
| `deps` | `base-build` | Installiert npm-Abhängigkeiten via pnpm |
| `builder` | `base-build` | Kompiliert Next.js |
| `runner` | `base-runtime` | Produktions-Image — enthält keine Build-Tools |

Das Runner-Image enthält bewusst keine nativen Compiler (`g++`, `make`, `python3`) und kein `libvips`. Die Prisma-CLI wird aus der `deps`-Stage kopiert statt global installiert — so bleibt die Version automatisch mit `package.json` synchron.

---

## Weiterführende Dokumentation

- **Reverse Proxy (Nginx, Caddy, Traefik):** [`docs/reverse-proxy.md`](./reverse-proxy.md)
- **OAuth, OIDC und E-Mail-Provider im Detail:** [`docs/self-hosting-auth-email.md`](./self-hosting-auth-email.md)
- **REST API und Google Reader API:** [`docs/api.md`](./api.md)
- **Datenbank-Details:** [`docs/database.md`](./database.md)
- **Sicherheit:** [`docs/security.md`](./security.md)
