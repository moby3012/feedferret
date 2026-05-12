# Outbound Webhooks

FeedFerret sends signed HTTP POST requests to your configured endpoints when feed events occur.

## Events

| Event | Trigger |
|-------|---------|
| `new_article` | A new article is synced (non-duplicate only) |
| `keyword_match` | A keyword alert matches one or more articles |
| `feed_error` | A feed fails to sync |
| `test` | Manual test ping from Settings |

## Payload format

```json
{
  "event": "new_article",
  "timestamp": "2026-05-12T10:30:00.000Z",
  "data": { ... }
}
```

### `new_article`

```json
{
  "event": "new_article",
  "timestamp": "2026-05-12T10:30:00.000Z",
  "data": {
    "id": "clxyz123",
    "title": "Article title",
    "link": "https://example.com/article",
    "feedId": "clf001",
    "feedName": "Example Blog",
    "publishedAt": "2026-05-12T09:00:00.000Z",
    "excerpt": "First 200 characters of article text…"
  }
}
```

### `keyword_match`

```json
{
  "event": "keyword_match",
  "timestamp": "2026-05-12T10:30:00.000Z",
  "data": {
    "alertId": "cla001",
    "alertName": "My alert",
    "query": "rust OR typescript",
    "article": {
      "id": "clxyz123",
      "title": "Article title",
      "link": "https://example.com/article",
      "feedId": "clf001",
      "feedName": "Example Blog",
      "publishedAt": "2026-05-12T09:00:00.000Z"
    }
  }
}
```

### `feed_error`

```json
{
  "event": "feed_error",
  "timestamp": "2026-05-12T10:30:00.000Z",
  "data": {
    "feedId": "clf001",
    "feedName": "Example Blog",
    "feedUrl": "https://example.com/feed.xml",
    "error": "HTTP 404"
  }
}
```

## Signature verification

Every request includes the header:

```
X-FeedFerret-Signature: sha256=<hex>
X-FeedFerret-Event: new_article
```

The signature is `HMAC-SHA256(secret, raw_request_body)`.

### Node.js verification example

```javascript
const crypto = require("crypto");

function verifySignature(secret, body, signature) {
  const expected = "sha256=" + crypto
    .createHmac("sha256", secret)
    .update(typeof body === "string" ? body : JSON.stringify(body))
    .digest("hex");
  return signature === expected;
}

// Express example
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["x-feedferret-signature"];
  if (!verifySignature(process.env.WEBHOOK_SECRET, req.body, sig)) {
    return res.status(401).send("Invalid signature");
  }
  const payload = JSON.parse(req.body);
  // handle payload.event ...
  res.sendStatus(200);
});
```

### Python verification example

```python
import hmac
import hashlib

def verify_signature(secret: str, body: bytes, signature: str) -> bool:
    expected = "sha256=" + hmac.new(
        secret.encode(), body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)
```

## Retry policy

Failed deliveries are retried with bounded exponential backoff:

| Attempt | Delay before retry |
|---------|--------------------|
| 1 | Immediate |
| 2 | 5 minutes |
| 3 | 30 minutes |
| 4 | 2 hours |
| 5 | 8 hours |

After 5 failed attempts the delivery is marked **failed** and no further retries occur.

Retries are processed during the background sync tick (default every 5 minutes).

## Feed filter

When creating a webhook you can optionally restrict it to specific feeds. Leave the filter empty to receive events from all feeds.

## Secret rotation

Rotating the secret immediately invalidates the old secret. Any in-flight deliveries using the old signature will appear as verification failures on the receiving end. Update your endpoint's secret before rotating if possible.
