# FeedFerret MCP

> **v1.6.0** — 35 tools available. All tools are user-scoped (token owner only).

FeedFerret exposes an MCP-compatible HTTP JSON-RPC endpoint so language models and agents can work directly with the reader.

## Tools at a Glance

| Tool | Type | Description |
|---|---|---|
| `feedferret.search_articles` | read | Full-text + advanced search syntax |
| `feedferret.get_article` | read | Fetch one article by ID |
| `feedferret.fetch_full_text` | write | Fetch & persist an article's full text from its source page |
| `feedferret.update_article_state` | write | Set read / starred / read-later |
| `feedferret.list_feeds` | read | List feeds with unread counts + full per-feed config |
| `feedferret.get_feed` | read | Get one feed with its full configuration |
| `feedferret.add_feed` | write | Add an RSS/Atom feed |
| `feedferret.sync_feeds` | write | Sync all feeds or one feed |
| `feedferret.list_categories` | read | List feed categories |
| `feedferret.list_labels` | read | List article labels |
| `feedferret.create_label` | write | Create a label |
| `feedferret.mark_all_read` | write | Bulk mark-as-read (use with care) |
| `feedferret.delete_feed` | write | Delete a feed and all its articles |
| `feedferret.update_feed` | write | Update full per-feed config (fetch, full-text, display, mute) |
| `feedferret.create_category` | write | Create a feed category/folder |
| `feedferret.update_category` | write | Update a category name, parent or order |
| `feedferret.delete_category` | write | Delete a feed category |
| `feedferret.update_label` | write | Update a label name or color |
| `feedferret.delete_label` | write | Delete a label and its article associations |
| `feedferret.label_article` | write | Replace all labels on an article |
| `feedferret.batch_update_articles` | write | Bulk update read/star state on multiple articles |
| `feedferret.list_saved_searches` | read | List saved searches |
| `feedferret.create_saved_search` | write | Create a saved search |
| `feedferret.delete_saved_search` | write | Delete a saved search |
| `feedferret.list_keyword_alerts` | read | List keyword alerts |
| `feedferret.create_keyword_alert` | write | Create a keyword alert |
| `feedferret.update_keyword_alert` | write | Update a keyword alert |
| `feedferret.delete_keyword_alert` | write | Delete a keyword alert |
| `feedferret.list_notifications` | read | List notifications ordered by newest first |
| `feedferret.get_stats` | read | Get aggregate stats for the current user |
| `feedferret.list_connectors` | read | List server-configured connectors (RSSHub, changedetection.io) |
| `feedferret.create_rsshub_feed` | write | Create a feed from an RSSHub route path |
| `feedferret.create_changedetection_feed` | write | Create a changedetection.io watch and add it as a feed |
| `feedferret.suggest_page_feed` | write | Detect repeating-item feed candidates on a web page |
| `feedferret.create_page_feed` | write | Create an HTML+XPath feed from a web page |

```text
POST /api/mcp
```

Auth:

```http
Authorization: Bearer <FeedFerret API token>
Content-Type: application/json
```

Der API-Token wird in **Settings → API Access** erzeugt. Der MCP-Zugriff ist benutzerbezogen und sieht nur Daten des Token-Inhabers.

---

## Transport

- Streamable HTTP / JSON-RPC 2.0
- Endpoint: `https://your-host/api/mcp`
- Server Info: `feedferret`
- Capabilities: `tools`

Health/Discovery:

```http
GET /api/mcp
```

---

## Initialisierung

```bash
curl -X POST https://your-host/api/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

Antwort:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": { "tools": {} },
    "serverInfo": { "name": "feedferret", "version": "1.0.0" }
  }
}
```

---

## Tools auflisten

```bash
curl -X POST https://your-host/api/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

---

## Verfügbare Tools

### `feedferret.search_articles`

Sucht Artikel.

Input:

```json
{
  "query": "is:unread AI after:7d",
  "feedId": "optional",
  "categoryId": "optional",
  "labelId": "optional",
  "isRead": false,
  "isStarred": true,
  "isReadLater": false,
  "limit": 10
}
```

### `feedferret.get_article`

Lädt einen Artikel vollständig.

```json
{ "articleId": "cla123" }
```

### `feedferret.fetch_full_text`

Holt die Quellseite eines Artikels, extrahiert den vollständigen lesbaren Text
(Defuddle → Readability → JSON-LD-`articleBody`-Fallback) und speichert ihn am
Artikel, **wenn** er den bestehenden (oft nur angerissenen) Feed-Inhalt echt
verbessert. Ideal für Feeds, die nur Teaser/Zusammenfassungen ausliefern. Der
Fetch ist SSRF-sicher und impersonierend; ein konfigurierter Hosted-BYOK-Connector
(Firecrawl/Jina) ist als finaler Fallback für diese explizite Aktion zulässig.

Gibt den aktualisierten Artikel zurück, plus optional `suggestAutoFullText`, wenn
der Feed wie ein absichtlich kürzender Feed aussieht. Wirft eine klare Meldung,
wenn die Seite nicht gelesen werden kann oder das Ergebnis keine Verbesserung wäre.

```json
{ "articleId": "cla123" }
```

### `feedferret.update_article_state`

Ändert Lesestatus, Favorit oder Read Later.

```json
{
  "articleId": "cla123",
  "isRead": true,
  "isStarred": true,
  "isReadLater": false
}
```

### `feedferret.list_feeds`

Listet Feeds inkl. Kategorie, Unread Count und der **vollständigen Feed-Konfiguration**
(Fetch-/HTTP-Optionen, Full-Text-/Feed-Intelligence-Einstellungen, Reader-/Anzeige-Overrides,
Health-Status). Das Auth-Passwort wird nie zurückgegeben.

```json
{}
```

### `feedferret.get_feed`

Lädt einen einzelnen Feed anhand seiner ID mit vollständiger Konfiguration
(dieselben Felder wie `list_feeds`, plus `unreadCount`). Das Auth-Passwort wird nie zurückgegeben.

```json
{ "feedId": "clf123" }
```

### `feedferret.add_feed`

Fügt einen Feed hinzu.

```json
{
  "url": "https://example.com/feed.xml",
  "name": "Example",
  "icon": "📰",
  "categoryId": "cat123",
  "sync": true
}
```

### `feedferret.sync_feeds`

Synchronisiert alle Feeds oder einen Feed.

```json
{}
```

```json
{ "feedId": "clf123" }
```

### `feedferret.list_categories`

Listet Kategorien.

### `feedferret.list_labels`

Listet Labels.

### `feedferret.create_label`

```json
{ "name": "Research", "color": "#8b5cf6" }
```

### `feedferret.mark_all_read`

Markiert passende Artikel als gelesen. Vorsichtig verwenden.

```json
{ "query": "is:unread after:30d" }
```

### `feedferret.delete_feed`

Löscht einen Feed und alle zugehörigen Artikel.

```json
{ "feedId": "clf123" }
```

### `feedferret.update_feed`

Aktualisiert die **vollständige** Feed-Konfiguration. Nur übergebene Felder werden
geändert; alles andere bleibt unverändert. Das Auth-Passwort ist write-only und
wird im Ergebnis nie zurückgegeben.

Unterstützte Felder:

- **Metadaten/Zeitplan:** `name`, `icon`, `categoryId`, `priority`, `updateFrequency`, `retentionDays`, `keepMinArticles`
- **Fetch/HTTP:** `customUserAgent`, `fetchTimeoutSecs`, `sslVerify`, `maxSizeKb`, `authType`, `authUsername`, `authPassword` (write-only)
- **Full-Text (Feed Intelligence):** `fullTextMode` (`off`/`auto`/`selector`/`ai`), `fullTextSelector`, `fullTextRemoveSelectors`, `fullTextConditions`, `autoFetchFullText`, `defaultContentFormat` (`html`/`markdown`)
- **Content-Filter:** `filtersActionRead` (durch Zeilenumbrüche getrennte Stichwörter; passende neue Artikel werden beim Abruf als gelesen markiert)
- **Reader-/Anzeige-Overrides (nullable, `null` = User-Default erben):** `hideArticleImage`, `hideFromAllFeeds`, `readerFontSizeOverride`, `readerWidthOverride`, `openOriginalOverride`
- **Muting:** `autoMuted`

Beispiel — Feed auf Selector-basierte Markdown-Extraktion umstellen und stummschalten:

```json
{
  "feedId": "clf123",
  "fullTextMode": "selector",
  "fullTextSelector": "article.post-body",
  "fullTextRemoveSelectors": "nav,.ads",
  "autoFetchFullText": true,
  "defaultContentFormat": "markdown",
  "autoMuted": true
}
```

### `feedferret.create_category`

Erstellt eine neue Kategorie/Ordner.

```json
{ "name": "AI", "parentId": null }
```

### `feedferret.update_category`

Aktualisiert eine Kategorie.

```json
{ "categoryId": "cat123", "name": "Machine Learning", "order": 5 }
```

### `feedferret.delete_category`

Löscht eine Kategorie.

```json
{ "categoryId": "cat123" }
```

### `feedferret.update_label`

Aktualisiert Name oder Farbe eines Labels.

```json
{ "labelId": "lbl123", "name": "Important", "color": "#ef4444" }
```

### `feedferret.delete_label`

Löscht ein Label und seine Artikelzuordnungen.

```json
{ "labelId": "lbl123" }
```

### `feedferret.label_article`

Ersetzt alle Labels eines Artikels (ownership wird geprüft).

```json
{ "articleId": "cla123", "labelIds": ["lbl1", "lbl2"] }
```

### `feedferret.batch_update_articles`

Ändert Lesestatus oder Favorit für bis zu 200 Artikel gleichzeitig.

```json
{ "ids": ["cla1", "cla2", "cla3"], "action": "read" }
```

Gültige Aktionen: `read`, `unread`, `star`, `unstar`.

### `feedferret.list_saved_searches`

Listet gespeicherte Suchen.

```json
{}
```

### `feedferret.create_saved_search`

Erstellt eine gespeicherte Suche.

```json
{ "name": "Unread AI", "query": "is:unread AI after:7d" }
```

### `feedferret.delete_saved_search`

Löscht eine gespeicherte Suche.

```json
{ "searchId": "ss123" }
```

### `feedferret.list_keyword_alerts`

Listet alle Keyword-Alerts.

```json
{}
```

### `feedferret.create_keyword_alert`

Erstellt einen Keyword-Alert.

```json
{ "name": "AI News", "query": "is:unread AI", "scope": "all", "actions": ["notify_inapp"] }
```

### `feedferret.update_keyword_alert`

Aktualisiert einen Keyword-Alert.

```json
{ "alertId": "ka123", "enabled": false, "query": "is:unread ML" }
```

### `feedferret.delete_keyword_alert`

Löscht einen Keyword-Alert.

```json
{ "alertId": "ka123" }
```

### `feedferret.list_notifications`

Listet Benachrichtigungen, neueste zuerst.

```json
{ "isRead": false, "limit": 20 }
```

### `feedferret.get_stats`

Gibt aggregierte Nutzungsstatistiken zurück.

```json
{}
```

### `feedferret.list_connectors`

Listet die serverseitig konfigurierten Connectors (RSSHub, changedetection.io)
und ob sie jeweils verfügbar sind — nützlich, um vor dem Anlegen herauszufinden,
welche connector-basierten Feeds auf diesem Server möglich sind.

```json
{}
```

Antwort:

```json
{ "rsshub": { "configured": true }, "changedetection": { "configured": false } }
```

### `feedferret.create_rsshub_feed`

Erstellt einen Feed aus einem RSSHub-**Route-Pfad**. Die Route wird vor dem
Anlegen gegen die konfigurierte RSSHub-Instanz validiert. Erfordert den
RSSHub-Connector.

```json
{ "routePath": "/github/trending/daily/any", "name": "GH Trending", "categoryId": "cat1", "sync": true }
```

### `feedferret.create_changedetection_feed`

Erstellt einen changedetection.io-**Watch** für eine Seiten-URL und fügt ihn als
Feed hinzu. Der Feed bleibt leer, bis changedetection die Seite mindestens
zweimal geprüft hat — der Initial-Sync wird daher übersprungen, außer `sync`
ist explizit `true`. Erfordert den changedetection.io-Connector.

```json
{ "url": "https://example.com/pricing", "name": "Example pricing", "categoryId": "cat1" }
```

### `feedferret.suggest_page_feed`

Erkennt auf einer beliebigen Webseite wiederkehrende Item-Listen und gibt
Kandidaten-Configs (XPath-Selektoren) mit Score und Beispieltiteln zurück.

```json
{ "url": "https://example.com/blog" }
```

### `feedferret.create_page_feed`

Erstellt einen HTML+XPath-Feed aus einer Webseite. Mit `config` (wie von
`suggest_page_feed` geliefert) wird diese verwendet; ohne `config` wird der
bestbewertete erkannte Kandidat automatisch gewählt.

```json
{ "url": "https://example.com/blog", "config": { "xPathItem": "//article", "xPathItemTitle": ".//h2", "xPathItemUri": ".//a/@href" } }
```

---

## Tool Call Beispiel

```bash
curl -X POST https://your-host/api/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0",
    "id":3,
    "method":"tools/call",
    "params":{
      "name":"feedferret.search_articles",
      "arguments":{"query":"is:unread MCP after:14d","limit":5}
    }
  }'
```

Antwortform:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "[...]"
      }
    ]
  }
}
```

---

## Sicherheitsnotizen

- MCP braucht denselben Bearer Token wie REST v1.
- Tools schreiben nur im Kontext des Token-Benutzers.
- Alle Datenbankabfragen erzwingen `userId` als Filterkriterium — kein Cross-User-Zugriff möglich.
- Mutierende Tools: `fetch_full_text`, `update_article_state`, `add_feed`, `sync_feeds`, `create_label`, `mark_all_read`, `delete_feed`, `update_feed`, `create_category`, `update_category`, `delete_category`, `update_label`, `delete_label`, `label_article`, `batch_update_articles`, `create_saved_search`, `delete_saved_search`, `create_keyword_alert`, `update_keyword_alert`, `delete_keyword_alert`, `create_rsshub_feed`, `create_changedetection_feed`, `create_page_feed`, `suggest_page_feed`.
- `label_article` prüft zusätzlich, ob der Artikel dem Token-Inhaber gehört, bevor Labels geändert werden.
- Das per-Feed HTTP-Basic-Auth-Passwort (`authPassword`) verlässt den Server nie: `list_feeds`, `get_feed`, `add_feed`, `update_feed` und `get_article` (eingebetteter Feed) entfernen es aus jeder Ausgabe. Es kann nur gesetzt, nie gelesen werden.
- Für fremde Agenten empfiehlt sich ein dedizierter FeedFerret-Benutzer oder ein frisch rotierbarer Token.
