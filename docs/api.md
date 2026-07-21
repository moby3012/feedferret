# FeedFerret API Documentation

FeedFerret now provides three integration surfaces:

1. **Public REST API v1** for n8n, mobile apps, browser extensions, and custom automations.
2. **MCP endpoint** for language models and agents: [`docs/mcp.md`](./mcp.md).
3. **Compatibility APIs** such as Google Reader and existing read-later/webhook endpoints.

> Goal: All external write access is user-scoped, token-based, and usable without admin/server secrets. Internal SaaS provisioning remains separate in [`docs/internal-api.md`](./internal-api.md).

---

## Base URL

```text
https://your-feedferret-host
```

---

## Authentication

### Session Cookie

For same-origin UI integrations, the normal FeedFerret session can be used.

### Bearer Token

For n8n, MCP, external apps, and scripts:

1. Log in to FeedFerret.
2. Open **Settings → API Access**.
3. Generate an API token.
4. Store the token securely; it is shown only once.

```http
Authorization: Bearer <feedferret-api-token>
```

Security rules:

- The token is tied to a user account.
- A deactivated user loses API access.
- Token rotation via `POST /api/user/token`; revocation via `DELETE /api/user/token`.
- Never expose the token client-side on public web pages.
- Tokens start with the prefix `ff_` and are stored server-side as a SHA-256 hash — only the raw value ever leaves the server, once, at generation time.

### Token Scopes

When creating a token under **Settings → API Access**, a scope can be selected:

| Scope | Access |
|---|---|
| `read` | Read-only `GET` endpoints only |
| `write` | `GET` + all writing `POST`/`PATCH`/`DELETE` endpoints on the user's own data |
| `admin` | Full access (same as session auth) |

Session auth (cookie) always has full access. A `read` token receives HTTP 403 on mutating endpoints.

---

## Error Format

Public REST v1 uses a uniform JSON error format:

```json
{
  "error": {
    "message": "Unauthorized"
  }
}
```

| Status | Meaning |
|---|---|
| `400` | Invalid request / missing required fields |
| `401` | No token or invalid token |
| `404` | Resource not found or does not belong to the user |
| `500` | Server error |

---

## OpenAPI

A machine-readable OpenAPI summary is available at:

```http
GET /api/v1/openapi.json
```

This endpoint is publicly readable and describes the most important REST v1 routes.

---

# Public REST API v1

All endpoints under `/api/v1/*` accept a session cookie or `Authorization: Bearer <token>`.

## Account

### `GET /api/v1/me`

Returns the current API account.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://your-host/api/v1/me
```

Response:

```json
{
  "id": "clu123",
  "email": "alice@example.com",
  "name": "Alice",
  "role": "USER"
}
```

---

## Articles

### `GET /api/v1/articles`

Searches or lists articles.

Query parameters:

| Parameter | Type | Description |
|---|---:|---|
| `q` / `search` | string | Full text + advanced search syntax |
| `feedId` | string | Only one feed |
| `categoryId` | string | Only one category |
| `labelId` | string | Only one label |
| `isRead` | boolean | `true`/`false` |
| `isStarred` | boolean | `true`/`false` |
| `isReadLater` | boolean | `true`/`false` |
| `after` | date | Published after date |
| `before` | date | Published before date |
| `sort` | enum | `newest` (default), `oldest`, `recentlyRead` |
| `limit` | number | 1–200, default 50 |
| `offset` | number | Pagination offset |
| `includeDuplicates` | boolean | Include duplicates |

Example for an n8n HTTP Request node:

```bash
curl -G "https://your-host/api/v1/articles" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "q=is:unread intitle:AI after:7d" \
  --data-urlencode "limit=20"
```

Response:

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

Loads an article including feed and labels.

### `PATCH /api/v1/articles/{id}`

Changes article status and optionally labels.

Body:

```json
{
  "isRead": true,
  "isStarred": true,
  "isReadLater": false,
  "labelIds": ["lbl1", "lbl2"]
}
```

### `POST /api/v1/articles/{id}/fetch-full-text`

Fetches the article's source page, extracts the full readable text (Defuddle → Readability → JSON-LD `articleBody` fallback), and — if it's a genuine improvement over the current (often truncated) feed content — persists it onto the article. Ideal for feeds that ship only teaser/summary items.

The fetch is SSRF-safe and impersonating; if you've configured a hosted full-text BYOK connector (e.g. Firecrawl/Jina) it is eligible as the final fallback for this explicit, user-initiated action.

Returns the updated article (same shape as `GET /articles/{id}`) plus an optional `suggestAutoFullText` hint when the feed looks like it deliberately truncates its items:

```json
{
  "id": "cla1",
  "title": "Example article",
  "content": "<p>Full extracted content…</p>",
  "...": "…",
  "suggestAutoFullText": { "feedId": "clf1", "feedName": "Example Feed" }
}
```

Error responses use the uniform error format:

| Status | When |
|---|---|
| `404` | Article not found or not owned by the user |
| `422` | Page couldn't be read (blocked/anti-bot/timeout), has no source link, or the result wouldn't improve the article |

> **Scope:** Requires `write` scope (or session auth).

### `POST /api/v1/articles/mark-all-read`

Marks matching unread articles as read.

Body filters can be combined:

```json
{
  "query": "feed:verge after:30d",
  "feedId": "clf1",
  "categoryId": "cat1",
  "labelId": "lbl1"
}
```

Response:

```json
{ "updated": 12 }
```

### `POST /api/v1/articles/batch`

Applies an action to up to 500 article IDs in a single request. Ideal for sync clients that need to transfer large volumes of read-status changes.

Body:

```json
{
  "ids": ["art1", "art2", "art3"],
  "action": "read",
  "labelId": "lbl1"
}
```

| Field | Type | Description |
|---|---|---|
| `ids` | `string[]` | Article IDs (max 500). Only articles belonging to the authenticated user are changed. |
| `action` | `string` | Required. See table below. |
| `labelId` | `string` | Required only for `label` / `unlabel`. |

Available actions:

| `action` | Effect |
|---|---|
| `read` | Mark as read |
| `unread` | Mark as unread |
| `star` | Add a star |
| `unstar` | Remove the star |
| `read_later` | Add to "Read Later" |
| `remove_read_later` | Remove from "Read Later" |
| `label` | Attach a label (`labelId` required) |
| `unlabel` | Remove a label (`labelId` required) |

Response:

```json
{ "updated": 42 }
```

> **Scope:** Requires `write` scope (or session auth). Read-only tokens (`read`) receive HTTP 403.

---

## Feeds

A feed object exposes its full per-feed configuration so an automation (or an
LLM via MCP) can inspect and reconfigure exactly how a feed is fetched,
extracted, and displayed. The per-feed HTTP auth **password is never returned**
(`authType` and `authUsername` are; `authPassword` is write-only).

Feed object:

```json
{
  "id": "clf1",
  "url": "https://example.com/feed.xml",
  "name": "Example Feed",
  "icon": "📰",
  "sourceType": "rss",
  "htmlUrl": "https://example.com",
  "description": "…",
  "priority": "normal",
  "categoryId": "cat1",
  "category": { "id": "cat1", "name": "News" },
  "order": 3,
  "updateFrequency": 60,
  "retentionDays": 90,
  "keepMinArticles": 100,

  "lastFetchedAt": "2026-07-21T08:00:00.000Z",
  "lastStatus": "ok",
  "lastError": null,
  "consecutiveFailureCount": 0,
  "autoMuted": false,

  "customUserAgent": "MyBot/1.0",
  "fetchTimeoutSecs": 15,
  "sslVerify": true,
  "maxSizeKb": 4096,
  "authType": "basic",
  "authUsername": "reader",

  "fullTextMode": "selector",
  "fullTextSelector": "article",
  "fullTextRemoveSelectors": "nav,.ads",
  "fullTextConditions": null,
  "autoFetchFullText": true,
  "defaultContentFormat": "markdown",

  "filtersActionRead": "sponsored\ngiveaway",

  "hideArticleImage": null,
  "hideFromAllFeeds": false,
  "readerFontSizeOverride": null,
  "readerWidthOverride": null,
  "openOriginalOverride": null,

  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-07-21T08:00:00.000Z",
  "unreadCount": 12
}
```

### `GET /api/v1/feeds`

Lists all feeds including category, health/status, unread count, and the full
per-feed configuration shown above.

### `POST /api/v1/feeds`

Adds a feed and syncs it immediately by default.

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

Loads a single feed with its full configuration.

### `PATCH /api/v1/feeds/{id}`

Updates any subset of a feed's configuration. Only the fields present in the
body are changed; everything else is left untouched.

**Metadata & scheduling**

| Field | Type | Description |
|---|---|---|
| `name` | string | Display name |
| `icon` | string | Emoji / short icon |
| `categoryId` | string \| null | Category/folder; `null` to remove |
| `priority` | string | `low` \| `normal` \| `high` |
| `updateFrequency` | number \| null | Refresh interval in minutes; `null` inherits the default |
| `retentionDays` | number \| null | Auto-clean articles older than N days |
| `keepMinArticles` | number \| null | Always keep at least N articles |
| `sourceType` | string | Feed source type |

**Fetch / HTTP options**

| Field | Type | Description |
|---|---|---|
| `customUserAgent` | string \| null | Override the User-Agent for this feed |
| `fetchTimeoutSecs` | number \| null | Per-request timeout |
| `sslVerify` | boolean | Verify TLS certificates |
| `maxSizeKb` | number \| null | Max response size to download |
| `authType` | string \| null | `none` \| `basic` |
| `authUsername` | string \| null | HTTP Basic Auth username |
| `authPassword` | string \| null | HTTP Basic Auth password — **write-only**, never returned |
| `unicityCriteria`, `unicityCriteriaForced` | — | De-duplication controls |
| `scraperConfig`, `httpOptions` | — | Advanced fetch/scraper config |

**Full-text extraction (Feed Intelligence)**

| Field | Type | Description |
|---|---|---|
| `fullTextMode` | string \| null | `off` \| `auto` \| `selector` \| `ai` |
| `fullTextSelector` | string \| null | CSS selector for the article body (selector mode) |
| `fullTextRemoveSelectors` | string \| null | CSS selectors to strip from extracted content |
| `fullTextConditions` | string \| null | Conditional extraction rules |
| `autoFetchFullText` | boolean | Fetch full text automatically on sync |
| `defaultContentFormat` | string \| null | `html` \| `markdown` |

**Content filters**

| Field | Type | Description |
|---|---|---|
| `filtersActionRead` | string \| null | Newline-separated keywords. New articles containing any of these words (in title, summary, or body) are marked read on arrival — they won't count as unread or trigger notifications. |

**Per-feed reader / display overrides** (all nullable; `null` = inherit the user default)

| Field | Type | Description |
|---|---|---|
| `hideArticleImage` | boolean \| null | Hide the lead image in the reader |
| `hideFromAllFeeds` | boolean \| null | Exclude this feed from the "All feeds" view |
| `readerFontSizeOverride` | string \| null | Reader font size for this feed |
| `readerWidthOverride` | string \| null | Reader column width for this feed |
| `openOriginalOverride` | boolean \| null | Open the original link instead of the reader |

**Muting**

| Field | Type | Description |
|---|---|---|
| `autoMuted` | boolean | Mute/unmute the feed (suppresses notifications & unread counting) |

Example — switch a feed to selector-based markdown extraction and mute it:

```json
{
  "fullTextMode": "selector",
  "fullTextSelector": "article.post-body",
  "fullTextRemoveSelectors": "nav,.ads,.newsletter-signup",
  "autoFetchFullText": true,
  "defaultContentFormat": "markdown",
  "autoMuted": true
}
```

### `DELETE /api/v1/feeds/{id}`

Deletes a feed along with its articles.

### `POST /api/v1/feeds/{id}/sync`

Syncs exactly one feed.

---

## Categories

### `GET /api/v1/categories`

Lists categories/folders.

### `POST /api/v1/categories`

```json
{ "name": "AI", "parentId": null, "order": 10 }
```

### `PATCH /api/v1/categories/{id}`

```json
{ "name": "Machine Learning", "order": 20 }
```

### `DELETE /api/v1/categories/{id}`

Deletes a category. Feeds are decoupled/deleted according to the data model if cascade applies.

---

## Labels

### `GET /api/v1/labels`

Lists labels including article counts.

### `POST /api/v1/labels`

```json
{ "name": "Research", "color": "#8b5cf6" }
```

### `PATCH /api/v1/labels/{id}`

```json
{ "name": "Important", "color": "#ef4444" }
```

### `DELETE /api/v1/labels/{id}`

Deletes a label and its article associations.

---

## Saved Searches

### `GET /api/v1/saved-searches`

Lists saved searches.

### `POST /api/v1/saved-searches`

```json
{ "name": "Unread AI", "query": "is:unread AI", "order": 1 }
```

### `PATCH /api/v1/saved-searches/{id}`

```json
{ "query": "is:unread AI after:14d" }
```

### `DELETE /api/v1/saved-searches/{id}`

Deletes a saved search.

### `POST /api/v1/saved-searches/{id}/share`

Enables/disables public RSS/web sharing of the search.

```json
{ "enabled": true }
```

---

## OPML

### `GET /api/v1/opml`

Exports all feeds and categories as OPML/XML.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://your-host/api/v1/opml > feedferret.opml
```

### `POST /api/v1/opml`

Imports OPML.

```json
{ "xml": "<?xml version=\"1.0\"?><opml>...</opml>" }
```

Response:

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

Syncs all feeds for the current user.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  https://your-host/api/v1/sync
```

---

## Connectors

### `GET /api/v1/connectors`

Lists the server-level connectors an admin may have configured and whether each
is currently available. Lets an automation or LLM discover which connector-backed
feeds it can create before trying.

```json
{
  "rsshub": { "configured": true },
  "changedetection": { "configured": false }
}
```

### `POST /api/v1/connectors/rsshub/feeds`

Creates a feed from an RSSHub **route path**. The route is validated against the
server's configured RSSHub instance before the feed is created (a bad route
returns `422`); the built route URL — including any admin-configured access key —
is then added through the normal add-feed flow.

Body:

```json
{ "routePath": "/github/trending/daily/any", "name": "GH Trending", "categoryId": "cat1", "sync": true }
```

| Field | Type | Description |
|---|---|---|
| `routePath` | string | Required. RSSHub route path, e.g. `/github/issue/DIYgod/RSSHub`. |
| `name`, `categoryId`, `icon`, `sync` | — | Same as `POST /feeds`. |

Returns the created feed (`201`). `400` if RSSHub isn't configured; `422` if the route doesn't validate.

### `POST /api/v1/connectors/changedetection/feeds`

Creates a changedetection.io **watch** for a page URL and adds it as a feed.

```json
{ "url": "https://example.com/pricing", "name": "Example pricing", "categoryId": "cat1" }
```

> The feed stays **empty until changedetection has checked the page at least twice**, so the initial sync is skipped unless you pass `"sync": true`.

Returns the created feed (`201`). `400` if changedetection isn't configured or the URL is invalid; `422` if the watch couldn't be created.

### `POST /api/v1/connectors/page/suggest`

Given an arbitrary web page URL, heuristically detects repeating item lists and
returns candidate feed configs (XPath selectors) with scores and sample titles —
the same detection the "Create feed from web page" UI uses.

```json
{ "url": "https://example.com/blog" }
```

Response:

```json
{
  "candidates": [
    {
      "config": { "xPathItem": "//article", "xPathItemTitle": ".//h2", "xPathItemUri": ".//a/@href" },
      "score": 88,
      "itemCount": 12,
      "sampleTitles": ["First post", "Second post"]
    }
  ]
}
```

### `POST /api/v1/connectors/page/feeds`

Creates an `HTML+XPath` page-feed from a web page. Pass a `config` (as returned by
`/connectors/page/suggest`) to use it, or omit it to auto-pick the top-scoring
detected candidate.

```json
{
  "url": "https://example.com/blog",
  "config": { "xPathItem": "//article", "xPathItemTitle": ".//h2", "xPathItemUri": ".//a/@href" },
  "name": "Example blog",
  "categoryId": "cat1"
}
```

| Field | Type | Description |
|---|---|---|
| `url` | string | Required. The page to scrape. |
| `config` | object | Optional. XPath field config; `xPathItem` is required when given. Omit to auto-detect. |
| `name`, `categoryId`, `sync` | — | Same as `POST /feeds`. |

Returns the created feed (`201`). `422` if no config is given and no repeating item list is found.

> **Scope:** All connector create/suggest endpoints require `write` scope (or session auth).

---

## Keyword Alerts

### `GET /api/v1/alerts`

Lists all keyword alerts for the user.

### `POST /api/v1/alerts`

```json
{ "name": "AI News", "query": "is:unread AI", "scope": "all", "actions": ["notify_inapp"], "enabled": true }
```

### `GET /api/v1/alerts/{id}`

Loads a keyword alert.

### `PATCH /api/v1/alerts/{id}`

Updates a keyword alert (all fields optional).

```json
{ "name": "AI & ML News", "enabled": false }
```

### `DELETE /api/v1/alerts/{id}`

Deletes a keyword alert.

---

## Auto-Read Rules

### `GET /api/v1/rules`

Lists all auto-read rules for the user (sorted by `order` ascending).

### `POST /api/v1/rules`

```json
{ "name": "Mark newsletters read", "query": "feed:newsletter", "actions": ["mark_read"], "enabled": true }
```

#### Webhook actions

A rule can fire outbound webhooks when it matches. Add `webhook_call:<index>`
entries to `actions` and supply the matching targets in `webhookConfigs`:

```json
{
  "name": "Ping on AI news",
  "query": "is:unread AI",
  "actions": ["webhook_call:0"],
  "webhookConfigs": [
    {
      "url": "https://hooks.example.com/feedferret",
      "method": "POST",
      "headers": { "X-Source": "feedferret" },
      "bodyTemplate": "{\"title\":\"{{article_title}}\",\"link\":\"{{article_link}}\"}",
      "secret": "your-hmac-signing-secret"
    }
  ]
}
```

- `bodyTemplate` supports `{{event}}`, `{{rule_name}}`, `{{timestamp}}`, `{{article_id}}`, `{{article_title}}`, `{{article_link}}`, `{{feed_name}}` placeholders.
- `secret`, when set, signs each request with an `X-FeedFerret-Signature: sha256=…` HMAC header.
- **The secret is write-only.** Rule responses return a `webhooks` array where each entry has `hasSecret: true|false` in place of `secret` — the value itself is never sent back:

```json
{
  "id": "rule1",
  "name": "Ping on AI news",
  "actions": "[\"webhook_call:0\"]",
  "webhooks": [
    { "url": "https://hooks.example.com/feedferret", "method": "POST", "headers": { "X-Source": "feedferret" }, "bodyTemplate": "…", "hasSecret": true }
  ]
}
```

A `webhook_call:<index>` action that points past the end of `webhookConfigs` is rejected with `400`.

### `GET /api/v1/rules/{id}`

Loads an auto-read rule (webhook secrets redacted).

### `PATCH /api/v1/rules/{id}`

Updates an auto-read rule (all fields optional). Passing `webhookConfigs`
replaces the whole list.

```json
{ "enabled": false }
```

### `DELETE /api/v1/rules/{id}`

Deletes an auto-read rule.

---

## Notifications

### `GET /api/v1/notifications`

Lists notifications, sorted by creation date descending.

Query parameters: `isRead` (bool), `limit` (1–100, default 50), `offset`.

### `POST /api/v1/notifications/mark-all-read`

Marks all of the user's notifications as read.

Response:

```json
{ "updated": 5 }
```

### `POST /api/v1/notifications/{id}/read`

Marks a single notification as read.

---

## Statistics

### `GET /api/v1/stats`

Returns aggregate values: feeds, articles, unread, starred, read later, labels, categories, saved searches, alerts, rules, notifications.

Response:

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

# Existing Special APIs

## Read Later Short API

The older short API remains compatible:

- `GET /api/read-later`
- `POST /api/read-later`
- `DELETE /api/read-later`

It's still convenient for browser extensions. New integrations can alternatively use `GET /api/v1/articles?isReadLater=true` and `PATCH /api/v1/articles/{id}`.

## API Token Management

These endpoints require a **session cookie**, not a bearer token:

- `GET /api/user/token` → `{ "hasToken": true }`
- `POST /api/user/token` → generates a token, shows it once
- `DELETE /api/user/token` → revokes the token

## Google Reader API

For native RSS clients: [`docs/google-reader-api.md`](./google-reader-api.md)

## Webhooks

Outbound events to external systems: [`docs/webhooks.md`](./webhooks.md)

## Internal API

Admin/SaaS provisioning with `INTERNAL_API_KEY`: [`docs/internal-api.md`](./internal-api.md)

---

# Search Syntax

REST and MCP search use the existing advanced search syntax.

| Token | Description | Example |
|---|---|---|
| Free text | Title, content, excerpt, author, URL, feed, labels | `OpenAI` |
| Phrase | Exact phrase | `"model context protocol"` |
| `is:unread` | Unread articles | `is:unread` |
| `is:read` | Read articles | `is:read` |
| `is:starred` | Starred | `is:starred` |
| `is:readlater` | Read Later | `is:readlater` |
| `feed:name` | Feed by ID, name, or URL | `feed:verge` |
| `category:name` | Category by ID or name | `category:AI` |
| `label:name` | Label by ID or name | `label:research` |
| `#label` | Shorthand for label | `#research` |
| `author:name` | Author | `author:alice` |
| `intitle:word` | Title contains | `intitle:llm` |
| `intext:word` | Content/excerpt contains | `intext:security` |
| `inurl:word` | URL contains | `inurl:github` |
| `after:date` | After date | `after:2026-01-01` |
| `before:date` | Before date | `before:2026-06-01` |
| Relative time | `d`, `w`, `m`, `y` | `after:7d` |
| Negation | `-` or `!` | `AI -feed:spam` |

Aliases:

- `is:later`, `is:saved`, `is:toread` → `is:readlater`
- `by:` → `author:`
- `title:` → `intitle:`
- `text:` / `content:` → `intext:`
- `url:` / `link:` → `inurl:`

---

# n8n Examples

## Fetching New Unread AI Articles

HTTP Request node:

- Method: `GET`
- URL: `https://your-host/api/v1/articles`
- Authentication: Header Auth
- Header: `Authorization = Bearer {{$env.FEEDFERRET_TOKEN}}`
- Query:
  - `q = is:unread AI after:1d`
  - `limit = 25`

## Marking Articles After Processing

```http
PATCH /api/v1/articles/{{ $json.id }}
Authorization: Bearer {{$env.FEEDFERRET_TOKEN}}
Content-Type: application/json

{ "isRead": true, "isStarred": true }
```

## Adding a Feed via Workflow

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

Shipped in v1.2: **full per-feed configuration parity across REST and MCP.**
`GET`/`PATCH /api/v1/feeds/{id}` and the MCP `update_feed` / `get_feed` tools now
cover every per-feed setting — fetch/HTTP options, HTTP Basic Auth (password
write-only), Feed Intelligence full-text extraction (`fullTextMode`, selectors,
`autoFetchFullText`, `defaultContentFormat`), per-feed reader/display overrides,
feed health (`lastStatus`, `lastError`, `consecutiveFailureCount`), and mute
state (`autoMuted`). This makes everything an LLM needs to run and tune a feed
controllable purely via the API/MCP surface. MCP tool total: 29.

Shipped in v1.3: **per-article full-text (re)fetch** via REST
(`POST /api/v1/articles/{id}/fetch-full-text`) and MCP (`fetch_full_text`),
sharing the same extraction engine and improvement check as the UI's "Fetch
full text" action. MCP tool total: 30.

Shipped in v1.4: **connector discovery** — `GET /api/v1/connectors` and the MCP
`list_connectors` tool report which server-level connectors (RSSHub,
changedetection.io) are configured, and the per-feed keyword content filter
(`filtersActionRead`) is now exposed across REST and MCP. MCP tool total: 31.

Shipped in v1.5: **create connector-backed feeds** — `POST /api/v1/connectors/rsshub/feeds`
(RSSHub route → feed) and `POST /api/v1/connectors/changedetection/feeds`
(changedetection watch → feed), plus the MCP `create_rsshub_feed` and
`create_changedetection_feed` tools. MCP tool total: 33.

Shipped in v1.6: **page→feed builder** — `POST /api/v1/connectors/page/suggest`
detects repeating item lists on any web page, and `POST /api/v1/connectors/page/feeds`
creates an HTML+XPath feed from a given or auto-detected config; MCP
`suggest_page_feed` and `create_page_feed` tools mirror them. With this, all
three connector paths (RSSHub, changedetection.io, page-feed) are fully
controllable over REST and MCP. MCP tool total: 35.

Shipped in v1.7: **webhook management** — auto-read rules' outbound webhooks are
now settable over REST (`webhookConfigs` on `POST`/`PATCH /rules`) and via the new
MCP `list/create/update/delete_auto_read_rule` tools. Webhook signing secrets are
write-only: read surfaces return a redacted `webhooks` array with a `hasSecret`
flag and never the secret value (this also closes a prior leak where the raw
`webhookConfigs` JSON was returned). MCP tool total: 39.

The REST v1 + MCP surfaces now cover the full user-facing feature set. Further
additions are tracked in [`docs/releases/backlog.md`](releases/backlog.md).
