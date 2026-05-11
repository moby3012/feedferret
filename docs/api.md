# FeedFerret REST API

This document covers the public REST API endpoints available for external integrations such as browser extensions and mobile apps.

> **Internal API (SaaS provisioning):** If you need to provision or suspend users programmatically from an external system (e.g., a Stripe webhook), see [docs/internal-api.md](./internal-api.md).

## Authentication

All API endpoints require authentication. Two methods are supported:

### Session Cookie (Web App)
Standard Next.js session cookie set after logging in at `/login`. Works automatically in same-origin contexts (the web UI).

### Bearer Token (External Apps)
For browser extensions, mobile apps, or any non-browser client:

1. Log in to FeedFerret in your browser
2. Go to **Settings → API Access**
3. Click **Generate API token**
4. Copy the token immediately — it is only shown once

Pass the token in every API request:
```
Authorization: Bearer <your-token>
```

> **Security:** The token grants access to the Read Later list (and future API endpoints) scoped to your account only. Treat it like a password. Revoke and regenerate it in Settings if compromised.

---

## Base URL

```
https://your-feedferret-host
```

All endpoints are relative to this base URL.

---

## Endpoints

### Read Later

#### `GET /api/read-later`

List all articles in your Read Later queue, sorted by most recently saved first.

**Auth:** Session or Bearer token

**Response `200 OK`:**
```json
[
  {
    "id": "clxyz123",
    "title": "Article Title",
    "link": "https://example.com/article",
    "excerpt": "Short preview text…",
    "author": "Author Name",
    "publishedAt": "2026-05-11T10:00:00.000Z",
    "imageUrl": "https://example.com/image.jpg",
    "isRead": false,
    "isStarred": false,
    "isReadLater": true,
    "readLaterSavedAt": "2026-05-11T12:34:56.000Z",
    "feed": {
      "id": "feed123",
      "name": "The Verge",
      "icon": "📱"
    }
  }
]
```

---

#### `POST /api/read-later`

Add an article to your Read Later queue.

**Auth:** Session or Bearer token

**Body (JSON):** Provide either `articleId` or `url`:
```json
{ "articleId": "clxyz123" }
```
```json
{ "url": "https://example.com/article" }
```

The `url` field looks up the article by its stored link. The article must already exist in your FeedFerret feeds.

**Response `200 OK`:**
```json
{
  "id": "clxyz123",
  "isReadLater": true,
  "readLaterSavedAt": "2026-05-11T12:34:56.000Z"
}
```

**Response `404 Not Found`:**
```json
{ "error": "Article not found" }
```

**Response `400 Bad Request`:**
```json
{ "error": "Provide articleId or url" }
```

---

#### `DELETE /api/read-later`

Remove an article from your Read Later queue.

**Auth:** Session or Bearer token

**Body (JSON):** Provide either `articleId` or `url`:
```json
{ "articleId": "clxyz123" }
```
```json
{ "url": "https://example.com/article" }
```

**Response `200 OK`:**
```json
{
  "id": "clxyz123",
  "isReadLater": false
}
```

---

### API Token Management

These endpoints are for managing your personal API token. They require **session cookie auth only** (not Bearer token), to prevent a compromised token from being used to regenerate itself.

#### `GET /api/user/token`

Check whether you have an active API token.

**Auth:** Session cookie only

**Response `200 OK`:**
```json
{ "hasToken": true }
```

---

#### `POST /api/user/token`

Generate or regenerate your API token. **Returns the raw token only once** — it cannot be retrieved again after this response.

**Auth:** Session cookie only

**Response `200 OK`:**
```json
{ "token": "a3f4e8b2c1d5...64-char hex string" }
```

---

#### `DELETE /api/user/token`

Revoke your API token. All active integrations will immediately stop working.

**Auth:** Session cookie only

**Response `200 OK`:**
```json
{ "revoked": true }
```

---

## Search Syntax

When using the web app or future search API endpoints, you can use advanced search tokens:

| Token | Description | Example |
|---|---|---|
| `is:readlater` | Articles in Read Later queue | `is:readlater` |
| `is:unread` | Unread articles | `is:unread` |
| `is:starred` | Starred articles | `is:starred` |
| `feed:name` | Filter by feed name | `feed:verge` |
| `category:name` | Filter by category | `category:tech` |
| `label:name` | Filter by label | `label:important` |
| `author:name` | Filter by author | `author:john` |
| `intitle:word` | Word in title | `intitle:react` |
| `after:date` | Published after date | `after:2026-01-01` |
| `before:date` | Published before date | `before:2026-06-01` |

Aliases: `is:later`, `is:saved`, `is:toread` all match Read Later.

---

## Browser Extension Integration Pattern

A typical browser extension workflow for "Save current page to Read Later":

```js
// 1. User clicks extension button on https://example.com/some-article

const FEEDFERRET_HOST = "https://your-feedferret-host";
const API_TOKEN = "<stored-token>";

const response = await fetch(`${FEEDFERRET_HOST}/api/read-later`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${API_TOKEN}`,
  },
  body: JSON.stringify({ url: window.location.href }),
});

if (response.ok) {
  showBadge("Saved to Read Later ✓");
} else if (response.status === 404) {
  showBadge("Article not in your feeds");
} else if (response.status === 401) {
  showBadge("Check your API token in FeedFerret Settings");
}
```

---

## Error Responses

All endpoints return JSON error objects on failure:

| Status | Meaning |
|---|---|
| `400` | Bad request — missing or invalid body parameters |
| `401` | Unauthorized — missing or invalid auth |
| `404` | Not found — article does not exist in your feeds |
| `500` | Internal server error |

```json
{ "error": "Human-readable error message" }
```
