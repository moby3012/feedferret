# Security

---

## Feed Fetch SSRF Protection

FeedFerret fetches RSS feeds, full-text article pages, and Dynamic OPML URLs server-side. To prevent the server from being abused as a proxy into private networks, feed fetching applies SSRF protections by default.

### Default protections

For feed fetches, Dynamic OPML, full-text extraction, and full-text preview:

- HTTP/HTTPS protocol allowlist.
- Private/internal IP blocking by default: localhost, RFC1918 IPv4 ranges, link-local, loopback, and local IPv6 ranges.
- DNS resolution checks before every fetch and every redirect target.
- Manual redirect handling with per-hop safety checks.
- Timeout limits.
- Maximum response-size limits.

### Admin override for trusted deployments

For single-tenant or otherwise trusted instances that need internal feed URLs:

**Server Management → Sync → Trusted internal feed URLs**

When enabled, fetches are still restricted to HTTP/HTTPS but private/internal IPs are allowed.

Use only when all feed-managing users are trusted. Keep disabled for public or multi-user instances.

Environment override for immutable deployments:

```bash
TRUSTED_FEED_FETCHING=true
# or
ALLOW_INTERNAL_FEED_URLS=true
```

The database admin setting is preferred — it can be changed without redeploying.

### Blocked URLs (default safe mode)

- `http://localhost:...`
- `http://127.0.0.1/...`
- `http://192.168.x.x/...`
- `http://10.x.x.x/...`
- `http://172.16.x.x` through `172.31.x.x`
- `http://169.254.x.x/...`
- Private/local IPv6 addresses

---

## Existing Security Measures

| Area | Implementation |
|---|---|
| Credentials encryption | API keys, email provider credentials, AI keys: AES-256-GCM with key derived from `AUTH_SECRET` |
| Password hashing | bcrypt via Auth.js |
| Sessions | Signed JWT tokens — no server-side session state |
| CSRF | Next.js Server Actions have built-in CSRF protection |
| Data isolation | All data is strictly per-user — no cross-user access possible at the query layer |
| Content sanitization | Article HTML is sanitized by DOMPurify before rendering |
| 2FA | Optional TOTP for local accounts |
| Admin safety | Last admin cannot be deleted or demoted |
| GDPR | Self-service account deletion with full cascade delete |
| SSRF | See above |

---

## Security Hardening Roadmap (Pre-Launch)

Detailed task breakdown is in `docs/ROADMAP.md` section 0.2.

### Rate Limiting (planned)

Protection against brute-force and API abuse:

| Endpoint group | Limit | Window |
|---|---|---|
| `POST /api/auth/signin` | 10 attempts | 15 minutes |
| Magic link request | 3 attempts | 10 minutes |
| `POST /api/v1/*` (write) | 60 requests | 1 minute |
| `GET /api/v1/*` (read) | 200 requests | 1 minute |
| `POST /api/internal/*` | 30 requests | 1 minute |
| `POST /api/mcp` | 100 requests | 1 minute |

Response: HTTP 429 with `Retry-After` header.

### Security Headers (planned)

Via `next.config.mjs` `headers()`:

```
Content-Security-Policy: default-src 'self'; ...
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

HSTS should be set at the reverse proxy (Nginx/Caddy/Traefik) level.

### API Token Hardening (planned)

Current state: tokens are stored as plaintext in the database.

Target state:
- SHA-256 hash of the token stored in DB, never plaintext
- Token prefix `ff_` for identification and secret scanning detection
- Optional configurable expiry

Note: this is a breaking change for existing tokens — a migration plan is required.

---

## Configuration Security Notes

**`AUTH_SECRET`**
- Must be at least 32 characters.
- Used for JWT signing and credential encryption.
- Never commit to version control.
- Keep stable across deploys — changing it invalidates all sessions and makes stored encrypted credentials unreadable.
- Generate: `openssl rand -base64 32`

**`POSTGRES_PASSWORD`**
- Must be changed before first deploy.
- `feedferret-change-me` in `docker-compose.yaml` is an example placeholder — never use in production.

**`INTERNAL_API_KEY`**
- Only set if you use the Internal API (SaaS provisioning).
- Never expose client-side.
- Generate: `openssl rand -base64 32`

**Postgres port exposure**
- The `docker-compose.yaml` exposes port `5432` to the host for maintenance access.
- For public-facing servers: remove the `ports` entry or block it at the firewall. The app container communicates with Postgres over the internal Docker network.

---

## Vulnerability Reporting

For critical vulnerabilities, contact the maintainers directly instead of filing a public GitHub issue. For non-critical issues, open a GitHub issue with the `security` label.
