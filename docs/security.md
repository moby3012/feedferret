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

## Implemented Security Hardening

### Rate Limiting ✅

In-memory sliding window rate limiter (`lib/rate-limit.ts`) protects against brute-force and API abuse:

| Endpoint group | Limit | Window |
|---|---|---|
| `POST /api/auth/*` (sign-in, credentials) | 10 attempts | 15 minutes |
| Magic link requests | 3 attempts | 10 minutes |
| `POST /api/mcp` | 100 requests | 1 minute |
| `POST /api/internal/*` | 30 requests | 1 minute |
| `GET /api/v1/*` (read) | 200 requests | 1 minute |
| `POST/PATCH/DELETE /api/v1/*` (write) | 60 requests | 1 minute |

Response on limit exceeded: HTTP 429 with `Retry-After`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers.

### Security Headers ✅

Set via `next.config.mjs` `headers()` — applied to all routes:

```
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'unsafe-inline' 'unsafe-eval';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: https:;
  font-src 'self' data:;
  connect-src 'self';
  worker-src 'self' blob:;
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self'
```

HSTS (`Strict-Transport-Security`) should be set at the reverse proxy (Nginx/Caddy/Traefik) level — not in Next.js to avoid conflicts with local development.

Note: `unsafe-inline` and `unsafe-eval` in `script-src` are required by Next.js App Router's runtime. Removing them requires nonce-based CSP configuration — planned as a future hardening step.

### Startup Environment Validation ✅

On server start, `instrumentation.ts` checks:

- `AUTH_SECRET` — length ≥ 32 characters, not a known placeholder value
- `POSTGRES_PASSWORD` — not the default `feedferret-change-me` placeholder
- `AUTH_URL` — not the placeholder `feedferret.example.com`

Warnings are printed to stdout as `⚠️` log lines. The server continues to start to avoid outages, but the warnings are clearly visible in Docker logs.

### Health Endpoint ✅

`GET /api/health` returns:

```json
{ "status": "ok", "db": "ok", "version": "0.1.0", "uptime": 3600 }
```

Returns HTTP 503 if the database is unreachable. Used as the Docker healthcheck target.

### Docker Healthcheck ✅

`docker-compose.yaml` now includes a healthcheck for the FeedFerret container:

```yaml
healthcheck:
  test: ["CMD-SHELL", "curl -f http://localhost:3000/api/health || exit 1"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 60s
```

### API Token Hardening ✅

API tokens are stored as SHA-256 hashes — the raw token is never persisted.

- **Format:** `ff_<base64url(32 random bytes)>` — the `ff_` prefix enables secret scanning detection in CI and Git hooks.
- **Storage:** `SHA-256(rawToken)` hex digest stored in the `apiToken` column. Only the hash is ever written to the database.
- **Auth:** Incoming `Authorization: Bearer ff_...` is hashed on every request before the database lookup — constant-time hash comparison via Prisma unique index.
- **Rotation:** Generating a new token via `POST /api/user/token` immediately overwrites the stored hash; the old token stops working at that instant.

> ⚠️ **Upgraders:** tokens issued before this hardening were stored as plaintext and will no longer authenticate. Regenerate your token in **Settings → API Access**.

### Input Validation ✅

All entry points for untrusted data enforce explicit limits:

| Input | Limit |
|---|---|
| Feed URL | Max 2 048 characters, must be a valid `http`/`https` URL |
| OPML import | Max 5 MB |
| Label name | Max 100 characters |
| Saved search name | Max 255 characters |
| Search query | Max 1 000 characters |
| Discovery query | Max 500 characters |

Feed URLs are format-validated before the SSRF guard is invoked.

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
