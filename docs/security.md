# Feed Fetch SSRF Protection

FeedFerret fetches RSS feeds, full-text article pages, and Dynamic OPML URLs server-side. To prevent the server from being abused as a proxy into private networks, feed fetching now applies SSRF protections by default.

## Default protections

For feed fetches, Dynamic OPML, full-text extraction, and full-text preview, FeedFerret enforces:

- HTTP/HTTPS protocol allowlist.
- Private/internal IP blocking by default, including localhost, RFC1918 IPv4 ranges, link-local ranges, loopback, and local IPv6 ranges.
- DNS resolution checks before every fetch and redirect target.
- Manual redirect handling with per-hop safety checks.
- Timeout limits.
- Maximum response-size limits.

## Admin override for trusted deployments

If your instance is single-tenant or otherwise trusted and you intentionally need internal feeds, an admin can enable:

**Server Management → Sync → Trusted internal feed URLs**

When enabled, FeedFerret still restricts fetches to HTTP/HTTPS, but allows URLs resolving to private/internal IPs.

Use this only when all feed-managing users are trusted. On public or multi-user instances, keep it disabled.

An environment override is also available for immutable deployments:

```bash
TRUSTED_FEED_FETCHING=true
# or
ALLOW_INTERNAL_FEED_URLS=true
```

The database admin setting is preferred because it can be changed without redeploying.

## Expected consequences

With the default safe mode, these URLs are blocked:

- `http://localhost:...`
- `http://127.0.0.1/...`
- `http://192.168.x.x/...`
- `http://10.x.x.x/...`
- `http://172.16.x.x` through `172.31.x.x`
- `http://169.254.x.x/...`
- private/local IPv6 addresses

This may block legitimate internal feeds until the trusted-deployment override is enabled.
