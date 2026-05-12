# FeedFerret MCP

FeedFerret bietet einen MCP-kompatiblen HTTP-JSON-RPC-Endpunkt, damit Sprachmodelle und Agenten direkt mit dem Reader arbeiten können.

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

Listet Feeds inkl. Kategorie und Unread Count.

```json
{}
```

### `feedferret.add_feed`

Fügt einen Feed hinzu.

```json
{
  "url": "https://example.com/feed.xml",
  "name": "Example",
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
- Mutierende Tools: `update_article_state`, `add_feed`, `sync_feeds`, `create_label`, `mark_all_read`.
- Für fremde Agenten empfiehlt sich ein dedizierter FeedFerret-Benutzer oder ein frisch rotierbarer Token.
