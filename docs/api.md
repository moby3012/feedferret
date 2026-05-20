# FeedFerret API-Dokumentation

FeedFerret stellt jetzt drei Integrationsflächen bereit:

1. **Public REST API v1** für n8n, mobile Apps, Browser Extensions und eigene Automationen.
2. **MCP Endpoint** für Sprachmodelle und Agenten: [`docs/mcp.md`](./mcp.md).
3. **Kompatibilitäts-APIs** wie Google Reader und bestehende Read-Later-/Webhook-Endpunkte.

> Ziel: Alle externen Schreibzugriffe sind benutzerbezogen, tokenbasiert und ohne Admin-/Server-Secrets nutzbar. Interne SaaS-Provisionierung bleibt getrennt in [`docs/internal-api.md`](./internal-api.md).

---

## Base URL

```text
https://your-feedferret-host
```

---

## Authentifizierung

### Session Cookie

Für Same-Origin-UI-Integrationen kann die normale FeedFerret-Session genutzt werden.

### Bearer Token

Für n8n, MCP, externe Apps und Skripte:

1. In FeedFerret einloggen.
2. **Settings → API Access** öffnen.
3. API-Token generieren.
4. Token sicher speichern; er wird nur einmal angezeigt.

```http
Authorization: Bearer <feedferret-api-token>
```

Sicherheitsregeln:

- Der Token ist einem Benutzerkonto zugeordnet.
- Ein deaktivierter Benutzer verliert API-Zugriff.
- Token-Rotation über `POST /api/user/token`; Widerruf über `DELETE /api/user/token`.
- Token nie clientseitig in öffentlichen Webseiten ausliefern.
- Tokens beginnen mit dem Präfix `ff_` und werden serverseitig als SHA-256-Hash gespeichert — nur der Rohwert verlässt den Server, einmalig bei der Generierung.

---

## Fehlerformat

Public REST v1 nutzt ein einheitliches JSON-Fehlerformat:

```json
{
  "error": {
    "message": "Unauthorized"
  }
}
```

| Status | Bedeutung |
|---|---|
| `400` | Ungültige Anfrage / fehlende Pflichtfelder |
| `401` | Kein oder ungültiger Token |
| `404` | Ressource nicht gefunden oder gehört nicht dem Benutzer |
| `500` | Serverfehler |

---

## OpenAPI

Eine maschinenlesbare OpenAPI-Zusammenfassung ist verfügbar unter:

```http
GET /api/v1/openapi.json
```

Dieser Endpoint ist öffentlich lesbar und beschreibt die wichtigsten REST-v1-Routen.

---

# Public REST API v1

Alle Endpunkte unter `/api/v1/*` akzeptieren Session Cookie oder `Authorization: Bearer <token>`.

## Account

### `GET /api/v1/me`

Gibt das aktuelle API-Konto zurück.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://your-host/api/v1/me
```

Antwort:

```json
{
  "id": "clu123",
  "email": "alice@example.com",
  "name": "Alice",
  "role": "USER"
}
```

---

## Artikel

### `GET /api/v1/articles`

Sucht oder listet Artikel.

Query-Parameter:

| Parameter | Typ | Beschreibung |
|---|---:|---|
| `q` / `search` | string | Volltext + erweiterte Suchsyntax |
| `feedId` | string | Nur ein Feed |
| `categoryId` | string | Nur eine Kategorie |
| `labelId` | string | Nur ein Label |
| `isRead` | boolean | `true`/`false` |
| `isStarred` | boolean | `true`/`false` |
| `isReadLater` | boolean | `true`/`false` |
| `after` | date | Publiziert nach Datum |
| `before` | date | Publiziert vor Datum |
| `sort` | enum | `newest` (default), `oldest`, `recentlyRead` |
| `limit` | number | 1–200, default 50 |
| `offset` | number | Pagination-Offset |
| `includeDuplicates` | boolean | Duplikate mitliefern |

Beispiel für n8n HTTP Request Node:

```bash
curl -G "https://your-host/api/v1/articles" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "q=is:unread intitle:AI after:7d" \
  --data-urlencode "limit=20"
```

Antwort:

```json
{
  "items": [
    {
      "id": "cla1",
      "feedId": "clf1",
      "title": "Example article",
      "link": "https://example.com/article",
      "excerpt": "Short summary…",
      "content": "<p>Full content…</p>",
      "author": "Author",
      "publishedAt": "2026-05-12T09:00:00.000Z",
      "isRead": false,
      "isStarred": false,
      "isReadLater": false,
      "feed": { "id": "clf1", "name": "Example Feed", "url": "https://example.com/rss.xml" },
      "labels": []
    }
  ],
  "pagination": {
    "limit": 20,
    "offset": 0,
    "total": 42,
    "nextOffset": 20
  }
}
```

### `GET /api/v1/articles/{id}`

Lädt einen Artikel inkl. Feed und Labels.

### `PATCH /api/v1/articles/{id}`

Ändert Artikelstatus und optional Labels.

Body:

```json
{
  "isRead": true,
  "isStarred": true,
  "isReadLater": false,
  "labelIds": ["lbl1", "lbl2"]
}
```

### `POST /api/v1/articles/mark-all-read`

Markiert passende ungelesene Artikel als gelesen.

Body-Filter sind kombinierbar:

```json
{
  "query": "feed:verge after:30d",
  "feedId": "clf1",
  "categoryId": "cat1",
  "labelId": "lbl1"
}
```

Antwort:

```json
{ "updated": 12 }
```

---

## Feeds

### `GET /api/v1/feeds`

Listet alle Feeds inkl. Kategorie, Status und Unread Count.

### `POST /api/v1/feeds`

Fügt einen Feed hinzu und synchronisiert standardmäßig direkt.

Body:

```json
{
  "url": "https://example.com/feed.xml",
  "name": "Example",
  "categoryId": "cat1",
  "sync": true
}
```

### `GET /api/v1/feeds/{id}`

Lädt einen Feed.

### `PATCH /api/v1/feeds/{id}`

Aktualisiert Feed-Metadaten und Fetch-/Reader-Optionen.

Wichtige Felder:

```json
{
  "name": "New title",
  "categoryId": "cat1",
  "updateFrequency": 60,
  "retentionDays": 90,
  "keepMinArticles": 100,
  "customUserAgent": "MyBot/1.0",
  "fetchTimeoutSecs": 15,
  "sslVerify": true,
  "maxSizeKb": 4096,
  "fullTextSelector": "article",
  "fullTextRemoveSelectors": "nav,.ads",
  "autoFetchFullText": true
}
```

### `DELETE /api/v1/feeds/{id}`

Löscht einen Feed mit Artikeln.

### `POST /api/v1/feeds/{id}/sync`

Synchronisiert genau einen Feed.

---

## Kategorien

### `GET /api/v1/categories`

Listet Kategorien/Folders.

### `POST /api/v1/categories`

```json
{ "name": "AI", "parentId": null, "order": 10 }
```

### `PATCH /api/v1/categories/{id}`

```json
{ "name": "Machine Learning", "order": 20 }
```

### `DELETE /api/v1/categories/{id}`

Löscht eine Kategorie. Feeds werden per Datenmodell entsprechend entkoppelt/gelöscht, falls Cascade greift.

---

## Labels

### `GET /api/v1/labels`

Listet Labels inkl. Artikelzählung.

### `POST /api/v1/labels`

```json
{ "name": "Research", "color": "#8b5cf6" }
```

### `PATCH /api/v1/labels/{id}`

```json
{ "name": "Important", "color": "#ef4444" }
```

### `DELETE /api/v1/labels/{id}`

Löscht ein Label und seine Artikelzuordnungen.

---

## Gespeicherte Suchen

### `GET /api/v1/saved-searches`

Listet gespeicherte Suchen.

### `POST /api/v1/saved-searches`

```json
{ "name": "Unread AI", "query": "is:unread AI", "order": 1 }
```

### `PATCH /api/v1/saved-searches/{id}`

```json
{ "query": "is:unread AI after:14d" }
```

### `DELETE /api/v1/saved-searches/{id}`

Löscht eine gespeicherte Suche.

### `POST /api/v1/saved-searches/{id}/share`

Aktiviert/deaktiviert öffentliche RSS-/Web-Freigabe der Suche.

```json
{ "enabled": true }
```

---

## OPML

### `GET /api/v1/opml`

Exportiert alle Feeds und Kategorien als OPML/XML.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://your-host/api/v1/opml > feedferret.opml
```

### `POST /api/v1/opml`

Importiert OPML.

```json
{ "xml": "<?xml version=\"1.0\"?><opml>...</opml>" }
```

Antwort:

```json
{
  "feedsAdded": 10,
  "feedsUpdated": 2,
  "categoriesAdded": 3,
  "categoriesUpdated": 1,
  "errors": []
}
```

---

## Sync

### `POST /api/v1/sync`

Synchronisiert alle Feeds des aktuellen Benutzers.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  https://your-host/api/v1/sync
```

---

## Keyword-Alerts

### `GET /api/v1/alerts`

Listet alle Keyword-Alerts des Benutzers.

### `POST /api/v1/alerts`

```json
{ "name": "AI News", "query": "is:unread AI", "scope": "all", "actions": ["notify_inapp"], "enabled": true }
```

### `GET /api/v1/alerts/{id}`

Lädt einen Keyword-Alert.

### `PATCH /api/v1/alerts/{id}`

Aktualisiert einen Keyword-Alert (alle Felder optional).

```json
{ "name": "AI & ML News", "enabled": false }
```

### `DELETE /api/v1/alerts/{id}`

Löscht einen Keyword-Alert.

---

## Auto-Read Regeln

### `GET /api/v1/rules`

Listet alle Auto-Read-Regeln des Benutzers (sortiert nach `order` aufsteigend).

### `POST /api/v1/rules`

```json
{ "name": "Mark newsletters read", "query": "feed:newsletter", "actions": ["mark_read"], "enabled": true }
```

### `GET /api/v1/rules/{id}`

Lädt eine Auto-Read-Regel.

### `PATCH /api/v1/rules/{id}`

Aktualisiert eine Auto-Read-Regel (alle Felder optional).

```json
{ "enabled": false }
```

### `DELETE /api/v1/rules/{id}`

Löscht eine Auto-Read-Regel.

---

## Benachrichtigungen

### `GET /api/v1/notifications`

Listet Benachrichtigungen, sortiert nach Erstelldatum absteigend.

Query-Parameter: `isRead` (bool), `limit` (1–100, default 50), `offset`.

### `POST /api/v1/notifications/mark-all-read`

Markiert alle Benachrichtigungen des Benutzers als gelesen.

Antwort:

```json
{ "updated": 5 }
```

### `POST /api/v1/notifications/{id}/read`

Markiert eine einzelne Benachrichtigung als gelesen.

---

## Statistiken

### `GET /api/v1/stats`

Gibt Aggregatwerte zurück: Feeds, Artikel, Unread, Starred, ReadLater, Labels, Kategorien, Suchen, Alerts, Regeln, Benachrichtigungen.

Antwort:

```json
{
  "totalFeeds": 42,
  "totalArticles": 1500,
  "unreadArticles": 87,
  "starredArticles": 12,
  "readLaterArticles": 5,
  "totalLabels": 8,
  "totalCategories": 6,
  "totalSavedSearches": 3,
  "totalKeywordAlerts": 4,
  "totalAutoReadRules": 2,
  "unreadNotifications": 1
}
```

---

# Bestehende Spezial-APIs

## Read Later Kurz-API

Die ältere Kurz-API bleibt kompatibel:

- `GET /api/read-later`
- `POST /api/read-later`
- `DELETE /api/read-later`

Sie ist für Browser Extensions weiter praktisch. Neue Integrationen können alternativ `GET /api/v1/articles?isReadLater=true` und `PATCH /api/v1/articles/{id}` verwenden.

## API Token Management

Diese Endpunkte benötigen **Session Cookie**, nicht Bearer Token:

- `GET /api/user/token` → `{ "hasToken": true }`
- `POST /api/user/token` → erzeugt Token, zeigt ihn einmalig an
- `DELETE /api/user/token` → widerruft Token

## Google Reader API

Für native RSS-Clients: [`docs/google-reader-api.md`](./google-reader-api.md)

## Webhooks

Outbound Events zu externen Systemen: [`docs/webhooks.md`](./webhooks.md)

## Internal API

Admin-/SaaS-Provisionierung mit `INTERNAL_API_KEY`: [`docs/internal-api.md`](./internal-api.md)

---

# Suchsyntax

Die REST- und MCP-Suche nutzt die vorhandene Advanced Search Syntax.

| Token | Beschreibung | Beispiel |
|---|---|---|
| Freitext | Titel, Inhalt, Excerpt, Autor, URL, Feed, Labels | `OpenAI` |
| Phrase | Exakte Phrase | `"model context protocol"` |
| `is:unread` | Ungelesene Artikel | `is:unread` |
| `is:read` | Gelesene Artikel | `is:read` |
| `is:starred` | Favoriten | `is:starred` |
| `is:readlater` | Read Later | `is:readlater` |
| `feed:name` | Feed nach ID, Name oder URL | `feed:verge` |
| `category:name` | Kategorie nach ID oder Name | `category:AI` |
| `label:name` | Label nach ID oder Name | `label:research` |
| `#label` | Kurzform für Label | `#research` |
| `author:name` | Autor | `author:alice` |
| `intitle:word` | Titel enthält | `intitle:llm` |
| `intext:word` | Content/Excerpt enthält | `intext:security` |
| `inurl:word` | URL enthält | `inurl:github` |
| `after:date` | Nach Datum | `after:2026-01-01` |
| `before:date` | Vor Datum | `before:2026-06-01` |
| Relative Zeit | `d`, `w`, `m`, `y` | `after:7d` |
| Negation | `-` oder `!` | `AI -feed:spam` |

Aliases:

- `is:later`, `is:saved`, `is:toread` → `is:readlater`
- `by:` → `author:`
- `title:` → `intitle:`
- `text:` / `content:` → `intext:`
- `url:` / `link:` → `inurl:`

---

# n8n Beispiele

## Neue ungelesene KI-Artikel ziehen

HTTP Request Node:

- Method: `GET`
- URL: `https://your-host/api/v1/articles`
- Authentication: Header Auth
- Header: `Authorization = Bearer {{$env.FEEDFERRET_TOKEN}}`
- Query:
  - `q = is:unread AI after:1d`
  - `limit = 25`

## Artikel nach Verarbeitung markieren

```http
PATCH /api/v1/articles/{{ $json.id }}
Authorization: Bearer {{$env.FEEDFERRET_TOKEN}}
Content-Type: application/json

{ "isRead": true, "isStarred": true }
```

## Feed per Workflow hinzufügen

```http
POST /api/v1/feeds
Authorization: Bearer {{$env.FEEDFERRET_TOKEN}}
Content-Type: application/json

{
  "url": "https://example.com/rss.xml",
  "name": "Example",
  "sync": true
}
```

---

# API Roadmap

Shipped in v1.0: articles, feeds, categories, labels, saved searches, OPML, sync, MCP, Google Reader API.

Shipped in v1.1: keyword alerts (`/api/v1/alerts`), auto-read rules (`/api/v1/rules`), notifications (`/api/v1/notifications`), aggregate stats (`/api/v1/stats`), batch article actions (`POST /api/v1/articles/batch`), fine-grained API token scopes (`read` / `write` / `admin`), 18 new MCP tools (28 total).

Planned — see [`docs/releases/backlog.md`](releases/backlog.md) for status:

- Webhook management via REST v1 (currently UI/Server Actions only)
