# Security

---

## Feed Fetch SSRF Protection

FeedFerret fetches RSS feeds, full-text article pages, and Dynamic OPML URLs server-side. To prevent the server from being abused as a proxy into private networks, feed fetching applies SSRF protections by default.

### Default protections

For feed fetches, Dynamic OPML, full-text extraction, and full-text preview:

- HTTP/HTTPS protocol allowlist.
- Private/internal IP blocking by default: localhost, RFC1918 IPv4 ranges, link-local, loopback, and local IPv6 ranges.
- DNS resolution checks before every fetch and every redirect target.
- Manual redirect handling with per-hop safety checks; Authorization and Cookie headers are stripped on cross-origin redirects.
- User-configured webhooks, Gotify/ntfy, Ollama and Wallabag reject redirects.
- DNS checks do not pin connection addresses: DNS rebinding remains a known limitation. Render-sidecar navigation and connector isolation require further hardening.
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
| Credentials encryption | Selected API keys, email provider credentials and AI keys use AES-256-GCM derived from `AUTH_SECRET`; TOTP seeds, feed passwords and some notification/webhook secrets remain plaintext |
| Password hashing | bcrypt via Auth.js |
| Sessions | Signed JWT tokens — no server-side session state |
| CSRF | Next.js Server Actions have built-in CSRF protection |
| Data isolation | Queries generally scope data by user; connector feed isolation and category ownership still need further hardening |
| Content sanitization | Article HTML is sanitized by DOMPurify before rendering |
| 2FA | Optional TOTP for local accounts; can be made mandatory for admins |
| Session invalidation | `sessionVersion` pattern — Password/2FA changes invalidate browser JWT sessions; legacy GReader tokens are unaffected |
| Login attempt logging | Browser credentials attempts and GReader failures recorded (best effort) with IP, user agent, and fail reason |
| Admin audit log | All admin mutations (role change, suspend, delete, settings) recorded with actor and timestamp |
| Admin safety | Last admin cannot be deleted or demoted |
| GDPR | Self-service account deletion with full cascade delete |
| SSRF | See above |

---

## Implemented Security Hardening

### Rate Limiting ✅

In-memory sliding window rate limiter (`lib/rate-limit.ts`) protects against brute-force and API abuse:

| Endpoint group | Limit | Window |
|---|---|---|
| `POST /api/auth/*` (sign-in, credentials) | 10 failed GReader attempts (credentials-status counts requests) | 15 minutes |
| GReader ClientLogin / Basic (per IP and email), credentials-status (per IP) | 10 failed GReader attempts (credentials-status counts requests) | 15 minutes |
| Magic link requests | 3 attempts | 10 minutes |
| `POST /api/mcp` | 100 requests | 1 minute |
| `POST /api/internal/*` | 30 requests | 1 minute |
| `GET /api/v1/*` (read) | 200 requests | 1 minute |
| `POST/PATCH/DELETE /api/v1/*` (write) | 60 requests | 1 minute |

Limits are per process, not shared across replicas. MCP is limited by source IP. `TRUSTED_PROXY_COUNT=1` selects the right-most `X-Forwarded-For` entry for a single Nginx, Caddy or Traefik proxy. For Cloudflare → Traefik → FeedFerret, set `TRUSTED_PROXY_COUNT=2`. Restrict origin access to Cloudflare and app access to Traefik; only trust headers appended by this controlled chain.

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

In production, an absent, short or placeholder `AUTH_SECRET` logs a clear error and stops startup. Build-time validation is skipped. Other configuration issues produce warnings.

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
- **Auth:** Incoming `Authorization: Bearer ff_...` is hashed on every request before the database lookup — database lookup by hash (not a constant-time comparison).
- **Rotation:** Generating a new token via `POST /api/user/token` immediately overwrites the stored hash; the old token stops working at that instant.

> ⚠️ **Upgraders:** tokens issued before this hardening were stored as plaintext and will no longer authenticate. Regenerate your token in **Settings → API Access**.

### Input Validation ✅

Selected entry points enforce explicit limits:

| Input | Limit |
|---|---|
| Feed URL | Max 2 048 characters, must be a valid `http`/`https` URL |
| OPML import | Max 5 MB |
| Label name | Max 100 characters |
| Saved search name | Max 255 characters |
| Search query | Max 1 000 characters |
| Discovery query | Max 500 characters |

Feed URLs are format-validated before the SSRF guard is invoked.

### Admin & Session Hardening ✅

#### Session invalidation

Sessions are JWT-based. A `sessionVersion` integer on the `User` record is stored inside the JWT (`token.sv`). On every request the JWT callback compares `token.sv` to the current `user.sessionVersion` in the database. A mismatch strips `sub` from the token, immediately invalidating the session.

Events that increment `sessionVersion`:

- Enabling TOTP 2FA
- Disabling TOTP 2FA

This guarantees that if a user changes their security state, all existing browser sessions are invalidated instantly — no grace period.

#### Login attempt logging

Browser credentials sign-in attempts are recorded regardless of outcome. GReader records only failed password attempts (including throttled requests); successful Basic polling and ClientLogin do not create rows. Recording is best effort in the `LoginAttempt` table:

| Field | Description |
|---|---|
| `email` | Email address used in the attempt |
| `userId` | Resolved user ID (null if account does not exist) |
| `success` | Boolean — whether authentication succeeded |
| `failReason` | `no_account` / `password` / `otp` / `inactive` / `rate_limit` |
| `ip` | Client IP from `X-Forwarded-For` / `X-Real-IP` |
| `userAgent` | Browser/client user agent string |
| `createdAt` | Timestamp |

Admins can review the last 100 login attempts in **Server Management → Audit Log**.

#### Admin audit log

All admin mutations are recorded in the `AdminAuditLog` table:

| Action | Trigger |
|---|---|
| `user.role_change` | Role promoted or demoted |
| `user.suspend` | Account suspended |
| `user.unsuspend` | Account reactivated |
| `user.delete` | Account permanently deleted |
| `settings.update` | Any global setting changed (fields listed in metadata) |

Each entry stores the actor's user ID, the target's email address (denormalised — survives user deletion), and a JSON metadata blob. Viewable in **Server Management → Audit Log → Admin Actions**.

#### 2FA requirement for admins

Admins can require all admin accounts to have TOTP 2FA enabled before they can perform any administrative action:

**Server Management → Access → Require 2FA for admins**

When enabled, any admin without 2FA active receives an error on every admin server action until they enable 2FA via **Settings → Security**.

---

## Quick-win access controls

- `GET /api/sync` requires a configured `SYNC_SECRET` in `Authorization: Bearer …`; unset or incorrect secrets return 404. Responses omit feed URLs. The built-in scheduler calls sync directly and needs no secret.
- Local and OAuth/OIDC registration allow bootstrap with zero users, including with a disabled setting. Only an installation with zero users AND no GlobalSettings row initializes a persisted disabled setting. After bootstrap, new users require registration to be enabled. Legacy installations with users and no settings row retain open registration; existing settings values are preserved. Local registration uses a serializable transaction to create one bootstrap ADMIN. Serialization/time-out conflicts return 409 for retry; duplicate accounts return generic 400.
- Deleted or inactive users lose JWT identity; admin actions re-read role and active status. Legacy GReader tokens now reject inactive users, but still lack expiry/password-change revocation.
- MCP write tools and Fever mark operations require write/admin token scope. Fever rejects expired tokens; read-later uses the common active-user resolver.
- Service workers cache no navigation responses and no `/api/*` responses; logout clears FeedFerret runtime caches while retaining the static offline precache. `_next/static` (public, content-hashed) is cached separately and bounded.
- Offline reading keeps sanitized article bodies in IndexedDB (`feedferret-offline`), keyed per user id and bounded (≤ 300 entries, ≤ 50 MB, LRU; a full browser quota evicts the oldest entries and retries once, a second refusal is reported in Settings → Reading). Nothing in it is a credential or token. Offline is read-only: no write queue exists. The static offline page renders stored bodies in a script-less, sandboxed iframe.
- **Offline session policy.** The store is not a login. A `session` record (`userId`, random generation id `gen`, `verifiedAt`) says whose data it holds.
  - *Binding:* every write carries `(userId, gen)` and re-checks the record inside its own IndexedDB transaction, so a stale tab or a fetch that answers after logout / an account switch writes nothing. Logout bumps the in-memory generation first (in-flight prefetches are aborted), then clears the store (the record goes with it), then tells other tabs (BroadcastChannel + `storage` event). Another account claiming the device issues a new generation and drops the previous account's rows; stale tabs stop syncing, clear their caches and reload. Landing on `/login` clears the store as well.
  - *Verification:* open tabs confirm the session with `GET /api/app/session` (boot, every 10 min, on recovery); the offline page does the same when the browser is online (401 → store cleared, other account → cleared). Unreachable servers say nothing.
  - *Expiry:* data whose `verifiedAt` is older than 30 days (the NextAuth JWT lifetime), missing, or in the future is neither shown nor kept — enforced by the offline page and by in-app offline reads.
  - *Service worker:* sign-in pages, `/api/*` (OAuth callbacks) are never timed out; reader navigations wait 8 s, then the public offline page is offered in "slow" mode (offline view / keep waiting) while the request keeps running. Only public precache files are ever served from a cache; no authenticated HTML or JSON is stored.

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


### Outbound DNS pinning

User-controlled HTTP requests use `safeFetch` / `fetchWithSsrfProtection` in
`lib/ssrf.ts`, backed by npm undici's fetch and matching dispatchers. DNS answers
are checked inside the socket lookup, including every A/AAAA answer. Private,
loopback, link-local, metadata and IPv4-mapped private addresses are refused.
Disabling TLS verification does not disable this check. Per-feed proxies have
separate connection checks; connector trust never authorizes an internal proxy.
The remote target of a user-selected proxy is resolved by that proxy, so the
proxy operator controls its egress policy.

For HTTPS browser impersonation, impit uses an authenticated, ephemeral loopback
CONNECT proxy that pins target DNS while preserving end-to-end TLS/SNI. Plain
HTTP uses pinned undici. If the bridge cannot start, requests fall back to pinned
undici. `FEEDFERRET_DISABLE_IMPIT=1` disables impersonation. When `HTTPS_PROXY`
(or `HTTP_PROXY`, including lowercase equivalents) is configured by the operator,
the bridge chains CONNECT through it and logs once that target DNS pinning then
depends on that upstream. Chained upstreams must use HTTP or HTTPS.

Explicit per-feed/instance internal access and trusted connector routes retain
separate unpinned connection pools. Connector redirect guards and the test-only
Google News override remain scoped to their authorized routes. Cross-origin
redirects discard the request body and all custom headers except `accept*`,
`user-agent` and `if-*`; 303 and POST 301/302 redirects become GET. One-hop API
clients refuse automatic redirects. ESLint bans bare outbound `fetch` calls in
`lib/**` and `app/api/**` outside `lib/ssrf.ts`.
