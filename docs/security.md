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
| Credentials encryption | Selected API keys, email provider credentials and AI keys use AES-256-GCM derived from `AUTH_SECRET` (v1). The v2 format (per-column HKDF keys, key ids, see "Stored secrets") can already be read for every secret column; TOTP seeds, feed passwords, notification tokens and webhook secrets are still written as plaintext until the next release switches writes to v2 |
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
| `POST /api/auth/*` (sign-in, credentials), per IP | 10 requests | 15 minutes |
| Password sign-in, per account (database) | 10 attempts, then locked until the window ends | 15 minutes |
| GReader ClientLogin / Basic (per IP and email) | 10 failed GReader attempts | 15 minutes |
| Password sign-in for unknown / passwordless addresses (per address, in memory) | 10 attempts, then refused like a locked account | 15 minutes |
| 2FA setup confirmation, per user | 10 code attempts | 15 minutes |
| Magic link requests | 3 attempts | 10 minutes |
| `POST /api/mcp` | 100 requests | 1 minute |
| `POST /api/internal/*` | 30 requests | 1 minute |
| `GET /api/v1/*` (read) | 200 requests | 1 minute |
| `POST/PATCH/DELETE /api/v1/*` (write) | 60 requests | 1 minute |
| Article search (`q` on `/api/app/articles`, REST v1 `GET /articles?q=`, MCP `search_articles`), per user | 60 queries | 1 minute |
| `/api/app/articles/count` (saved searches, search), per user | 120 requests | 1 minute |
| "Mark up to here" range (`markListRangeRead`), per user | 20 calls | 1 minute |
| Read/star/read-later toggle batches (`applyArticleStateOps`), per user | 300 calls | 1 minute |
| Bulk mark read: GReader `mark-all-as-read`, Fever `mark=feed\|group`, REST v1 mark-all, per user (shared) | 300 calls | 10 minutes |
| AI "Test connection", per user | 10 tests | 10 minutes |
| "Defekte Feeds" re-test / repair (`retestBrokenFeed`, `applyFeedRepair`), per user | 150 calls | 10 minutes |
| FreshRSS migration upload / OPML import, per user | 6 / 10 | 10 minutes / 1 minute |
| Imported articles (FreshRSS migration), per user | 200 000 rows | 1 day |

The per-user limits on search, counts and bulk state writes (N13) are sized so normal use never reaches them: the web client debounces search and sends toggles in batches (at most one call every 400 ms–1 s), and sync clients (Reeder, NetNewsWire, FeedMe, ReadKit) send item state through GReader `edit-tag` / Fever `mark=item`, which only count against the general GReader/Fever limit (120/min). The bulk-mark bucket allows a burst of 300 (a client marking a large folder feed by feed) but caps a sustained loop at one call every 2 s. Above a limit the web client shows a toast and changes nothing; toggles are rolled back.

On PostgreSQL, search reads (ad-hoc `q` and saved searches, list and count) run in a transaction with `SET LOCAL statement_timeout = 8s`; a cancelled query answers `503` instead of holding a connection.

Imports run one at a time per instance (`FEEDFERRET_MAX_CONCURRENT_IMPORTS`, default 1) and per user; see [FreshRSS migration](freshrss-migration.md#security).

AI: digest prompts escape and delimit every feed-supplied field (titles, feed names, excerpts) like the briefing, and the generated subject and summary are stripped of HTML, markdown, URLs, e-mail addresses and bare `host/path` links before they reach the digest e-mail. Every AI call — summaries, tagging, briefing, digest (also the preview), full-text extraction, feed-config and RSSHub proposals, the connection test — reserves against the user's daily token cap (`AI_DAILY_TOKEN_CAP`, default 150 000) and is recorded in `AiUsage`.

#### Isolated limiter stores and the per-account lockout

- **One store per limiter.** Every limiter (`prefix`) has its own in-memory store with its own cap (50 000 keys), so a flood of distinct keys against one endpoint (many IPs, attacker-chosen key parts) can only evict entries of that endpoint, never the sign-in lockout.
- **Fail-safe stores for credential guessing.** Limiters marked `critical` (sign-in, GReader/Fever password budgets, the synthetic unknown-address budget, magic link, internal API key, inbound-mail webhook auth failures, email-change and API-password step-up, password change, 2FA disable and 2FA setup confirmation) never evict a lockout while something else can go: when full they drop expired entries, then lightly used entries (below half of the limit), then entries that are not yet locked. Only when the store holds nothing but active lockouts does the limiter's `overflow` policy apply:
  - `refuse` (internal API key, webhook auth failures, step-ups, password change, 2FA disable): lockouts are never evicted and **new keys are refused** (answered as rate limited) until the earliest lockout expires. Filling such a store takes `cap × limit` requests from `cap` distinct keys. **Webhook trade-off:** the inbound-email signature check peeks at this store before it reads the body (a signature cannot be verified earlier), so a saturated store makes it refuse *untracked* clients too. Saturating it needs 50 000 keys × 10 failures ≈ **500 000 failed requests within one 5-minute window** (≈1 700 requests/s sustained) spread over 50 000 client keys; IPv6 clients are keyed by `/64`, so a single `/48` (65 536 prefixes) is enough. While it holds, signature-mode mail from a client not seen before is answered 429 (providers retry); the refusal ends when the earliest lockout expires (≤ 5 minutes after it started). Basic-auth mode is not affected: its credentials are verified before any budget is consulted, and a correct request never spends from it. Peeking never evicts anybody's lockout.
  - `evict-oldest` (**sign-in, GReader/Fever IP budgets, the synthetic unknown-address budget, magic link**): the oldest lockouts are dropped instead. These limiters are keyed by client IP and are backed elsewhere (the per-account database lockout below, and for magic link the requirement that the unlock path can never be denied globally), so one host cannot lock every other client out of signing in. Cost: a botnet with 50 000+ distinct keys can age out older per-IP lockouts, which the per-account lockout still covers.
- **Few keys per attacker.** IPv6 clients are keyed by their `/64` (every VPS gets one, so per-address keys would let a single host mint unlimited keys), IPv4-mapped IPv6 as IPv4. The GReader/Fever login charges the per-address budget only for addresses that have an account, so invented addresses cannot grow that store.
- **Per-account lockout in the database** (`User.failedLoginCount` / `failedLoginWindowEnd`, `lib/account-lockout.ts`): browser password sign-in reserves one attempt per account in a fixed 15-minute window before any password/OTP check (a single atomic UPDATE, so parallel guesses cannot overshoot) and gives it back on a fully successful sign-in. After 10 outstanding attempts the account refuses password sign-in (answered like a wrong password, no audit row; the login form says "incorrect … or too many attempts") until the window ends; refused attempts do not extend it. It survives restarts, is shared by all replicas and holds against guessing spread over many IPs; the per-IP limiter stays. A password change, `create-user` and the unlock command clear it. Window times come from the application server's clock (keep replicas NTP-synchronised); each attempt touches `User.updatedAt`.
- **GReader/Fever with the main password.** When the Google Reader login accepts the account's main password (no separate API password configured), every uncached check is also charged to a second, independent database counter (`failedApiLoginCount` / `failedApiLoginWindowEnd`, same 10 per 15 minutes), so this endpoint is not a way around the lockout. Separate counters mean a sync client with a stale password cannot lock the owner out of the web sign-in; the price is that a guesser gets at most 2 × 10 tries per window. An API password (Settings → API) is not charged and is the recommended setup for sync clients.
- **Trade-off.** Someone who knows an address can burn its 10 attempts and block password sign-in for up to 15 minutes at a time. This is bounded and limited to password sign-in: existing sessions, magic-link and OAuth/OIDC sign-in, API tokens and the GReader/Fever API password are unaffected, and a correct password + TOTP does not bypass an active lockout (otherwise the attacker could keep guessing). **Recovery without SMTP or OAuth:** an operator clears the lockout with `node scripts/auth-cli.mjs unlock-user <email>` (Docker: `docker compose exec feedferret node scripts/auth-cli.mjs unlock-user owner@example.com`; source checkout: `pnpm cli unlock-user <email>`); re-running `create-user` for the address also clears it. A "known device" cookie that exempts previously used browsers is a possible follow-up, not implemented.
- **Client address.** See [reverse-proxy.md](reverse-proxy.md#trusted-proxy-count): `TRUSTED_PROXY_COUNT=0` means no proxy; with a proxy count ≥ 1, `X-Forwarded-For` is only believed from a trusted proxy peer (`TRUSTED_PROXIES` when set, otherwise loopback/RFC 1918/link-local/ULA; never CGNAT/Tailscale). An unset count is a warned legacy mode that still believes private peers and, without peer information, believes nothing.
- **Refund bound to its window.** The attempt a successful sign-in gives back is only refunded while the window it was reserved in is still running (`reserveLoginAttempt` returns the window end, `releaseLoginAttempt` conditions on it), so a slow success that straddles a rollover cannot decrement the next window's counter.
- **Account existence.** `/api/auth/credentials-status` is gone (it answered 401 for unknown and 200 + a 2FA flag for known addresses). The login form asks for the one-time code only after the password has been verified (Auth.js error code `otp_required`; the attempt is given back because it is not a guess). Unknown and passwordless addresses run the same bcrypt verification against a dummy hash and are throttled per address with the same 10 per 15 minutes budget, answered like a locked account. Remaining, accepted differences: a correct password on a 2FA account is distinguishable (it asks for a code) — only for someone who already holds the password, bounded by the lockout; account existence can still be probed through registration and magic link flows if those are enabled. Two further, small differences remain: (1) a known account does a few more database round trips before bcrypt (lockout reservation, refund) than an unknown address, a difference of a few milliseconds that is measurable only with many samples and a quiet network; (2) the unknown-address budget lives in process memory, so with several replicas an invented address gets up to `replicas × 10` tries before refusals start, where a real account's budget is shared through the database. Both are about *when* refusals appear, not about any secret. Password hashes are bcrypt cost 12 everywhere and the dummy hash has the same cost; accounts created at the old cost 10 are upgraded on their next successful sign-in, and until then (or if never) such a real account verifies faster than an unknown address.
- **2FA setup.** Confirming a setup only works on a pending setup (never on an account that already has 2FA), is throttled (10 codes per 15 minutes per user) and enables 2FA in one transaction with a compare-and-set on the pending secret it verified; the accepted TOTP step is recorded, so the code used for setup cannot be replayed at the first sign-in.

Limits are per process, not shared across replicas. MCP is limited by source IP. `TRUSTED_PROXY_COUNT=1` selects the right-most `X-Forwarded-For` entry for a single Nginx, Caddy or Traefik proxy. For Cloudflare → Traefik → FeedFerret, set `TRUSTED_PROXY_COUNT=2`. Restrict origin access to Cloudflare and app access to Traefik; only trust headers appended by this controlled chain.

Response on limit exceeded: HTTP 429 with `Retry-After`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers.

### Security Headers ✅

Set via `next.config.mjs` `headers()` — applied to all routes (`/api/*` and
`/offline.html` get stricter policies, and pages additionally carry a report-only
nonce policy; see [CSP nonce rollout (L3)](#csp-nonce-rollout-l3)):

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

Note: `unsafe-inline` and `unsafe-eval` in the enforced `script-src` remain until the
nonce policy below is enforced (L3, PR 7).

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

**`FEEDFERRET_ENCRYPTION_KEY`** (optional, recommended for production)
- Master key for secrets stored in the database. Base64 of ≥ 32 random bytes (`openssl rand -base64 32`); production refuses to start with a shorter or non-base64 value.
- Falls back to `AUTH_SECRET`. Setting it decouples stored secrets from `AUTH_SECRET`, so rotating `AUTH_SECRET` no longer touches them (once values are stored in v2).
- `FEEDFERRET_ENCRYPTION_KEYS_OLD`: comma-separated, decrypt-only keys (previous `FEEDFERRET_ENCRYPTION_KEY` values or an old `AUTH_SECRET`). A value is used verbatim, so moving it between the variables keeps its key id.

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

## CSP nonce rollout (L3)

**Mode switch:** `FEEDFERRET_CSP` (read per request; restart to change).

| Value | Pages (proxied routes) |
|---|---|
| `report` (default; also any unknown value) | old static policy **enforced** + per-request nonce policy as `Content-Security-Policy-Report-Only` + `Reporting-Endpoints` |
| `legacy` | old static policy only (rollback: no nonce, no report-only policy, no reports) |

Report mode changes no behaviour: the browser still enforces the old policy and only
*reports* what the nonce policy would block. Enforcing the nonce policy is a separate
release (PR 7) after a clean report window.

**Nonce policy** (`lib/csp.ts`, built in `proxy.ts` for every proxied request):

```
default-src 'self'; script-src 'self' 'nonce-<n>' 'strict-dynamic'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; worker-src 'self';
manifest-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';
report-to csp; report-uri /api/csp-report
```

`<n>` is 128 random bits per request. Dev mode adds `'unsafe-eval'` (React refresh).
Client-sent `content-security-policy*` / `x-nonce` request headers are dropped.

**How the nonce reaches the HTML.** The proxy sets the nonce policy as the *request's*
`content-security-policy` header; Next 16 reads the nonce from it and stamps it on
every framework, chunk and Flight script — including the cold-start bootstrap data,
which travels in the Flight payload. The root layout reads `x-nonce` and passes it to
next-themes' anti-flash script. There are no other inline scripts (`next/script` is
not used). `'strict-dynamic'` then trusts the chunks those scripts load.

**Why the enforced policy stays in `next.config.mjs`.** Next copies every header of
a proxy *response* onto the request as well (`router-utils/resolve-routes.js`). An
enforced `Content-Security-Policy` set by the proxy would therefore replace the nonce
policy Next reads, and pages would render without nonces. The proxy only adds the
report-only header; the enforced header comes from `next.config.mjs`, which touches
the response only. For the same header key the last matching `headers()` entry wins,
so every response carries exactly one enforced policy:

| Path | Enforced policy |
|---|---|
| `/api/*` (JSON + tiny HTML pages: digest unsubscribe, Telegram callback, Auth.js) | `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` |
| `/offline.html` | `script-src 'self'` (no inline script; the retry button is bound in `offline-reader.js`) |
| everything else (pages, `sw.js`, static files) | the old static policy above |

These static headers are baked in at build time, so `FEEDFERRET_CSP=legacy` does not
change them. PR 7 has to move the enforced page policy into the proxy and make it
carry the nonce (the request-header copy above).

**Rendering and caching.** The root layout was already dynamic (session and locale
reads), so the nonce adds no new rendering boundary and loses no HTML cache. The
build fails (`scripts/check-csp-build.mjs`) if any app HTML route is prerendered; only
`robots.txt`, `sitemap.xml` and Next's synthetic `/_global-error` are allowed. Never
cache application HTML at a CDN or reverse proxy (Traefik included) and do not enable
`cacheComponents`/PPR without redesigning nonce handling: a cached nonce is a reusable
nonce. Dynamic HTML is sent as `private, no-cache, no-store`.

**Known gap before enforcement (PR 7).** Next 16 always builds a static
`/_global-error` (and `pages/500.html`) fallback, served only on a catastrophic render
failure. It has no nonce; under report mode it still works (and may report), under an
enforced nonce policy its scripts would be blocked. Give it a script-free strategy
before enforcing.

**Service worker / offline.** The service worker never caches navigations or `/api/*`;
the only cached HTML is the public offline shell, which needs no nonce. The precache
version moved to `feedferret-pwa-v5`, so installed workers fetch the new offline HTML
(without the inline `onclick`) and handler together. The sandboxed article `srcdoc`
keeps its own meta CSP.

**Bookmarklet.** Clicking the `javascript:` bookmarklet link *on FeedFerret's own page*
is reported in report mode and blocked once enforced; dragging it to the bookmarks bar
(what the UI asks for) is unaffected.

**Report endpoint.** `POST /api/csp-report` needs no session (browsers send reports
without cookies). It is rate-limited to 30 requests per minute per client IP (behind
`TRUSTED_PROXY_COUNT`), caps the streamed body at 16 KiB (413 above), accepts both the
legacy `application/csp-report` and the Reporting API format, and answers 204 with an
empty body. It logs at most one line per minute per process: counts per allowlisted
directive (`CSP report counts (untrusted telemetry) { "script-src-elem": 3 }`). It
deliberately logs no URLs (document paths can carry share tokens), IPs, samples,
policies or nonces — stricter than the spec's origin/path sampling. Reports are
attacker-controllable telemetry, never security evidence. The last partial minute is
lost on restart.

**Tests.** `tests/lib/csp*.test.ts` cover the header builder, mode switch and report
ingestion. Every Playwright spec runs under an auto fixture (`e2e/helpers/csp-test.ts`)
that records `securitypolicyviolation` events (enforced and report-only) and report
POSTs and fails the test on any; `e2e/csp.spec.ts` checks headers, fresh nonces per
load, that every served `<script>` carries the nonce, the static paths, and the offline
page.

**Performance of `/`** (production build, local, seeded desktop session, 5 warm-up +
60 sequential requests, full HTML read, two alternating runs per mode): report mode
median 20.5–20.6 ms / p90 22.9–23.4 ms, legacy 20.9–21.1 ms / p90 22.6–22.8 ms — no
measurable difference. HTML grows from 311,989 to 314,614 bytes (+0.8 %, repeated
nonce attributes, before compression).

## Stored secrets (encryption at rest)

Formats (`lib/secret-box-core.mjs`):

| Format | Shape | Key |
|---|---|---|
| v2 | `ff2.<kid>.<iv>.<ciphertext+tag>` | AES-256-GCM, key = HKDF-SHA256(master, salt `feedferret/v2`, info = column purpose such as `feed.authPassword`); the purpose is also the GCM AAD, so a value cannot be moved to another column. `kid` = first 4 bytes of HKDF(master, info `kid`) |
| v1 | `iv:tag:ct` (base64) | AES-256-GCM, key = sha256(`AUTH_SECRET`) — API keys, mail credentials, connector tokens |
| plaintext | — | TOTP seeds, feed Basic-Auth and fetch options, notification tokens, webhook secret/header values |

Rollout (two releases, so a rollback never locks anyone out):

1. **This release reads v2 everywhere and still writes v1/plaintext.** An image from before this release cannot read `ff2.` values, so nothing writes them yet.
2. The next release writes v2, re-seals legacy values lazily and in the background, and adds `secrets:rotate`.

A value that cannot be decrypted with the configured keys is never used silently: TOTP login fails closed, a feed fetch ends with an error status naming the column (never the value), a notification channel or webhook is skipped, and the column is logged once.

Check the state at any time (counts per column, format and key id; never prints a value; exit code 2 if anything is undecryptable):

```bash
node scripts/secrets-cli.mjs status          # inside the Docker image
pnpm cli secrets:status                      # from a source checkout
```

Key rotation (effective once the next release writes v2):

1. Set the new `FEEDFERRET_ENCRYPTION_KEY` and put the old value (or the old `AUTH_SECRET`) into `FEEDFERRET_ENCRYPTION_KEYS_OLD`.
2. Restart. `secrets:status` shows values under the old key id as `v2:<kid>:old`.
3. Once no value uses the old key id, remove it from `FEEDFERRET_ENCRYPTION_KEYS_OLD`.

Signed tokens use domain-separated HMAC keys derived from the master key (`greader-token`, `telegram-callback`). This release verifies both the derived and the legacy `AUTH_SECRET` MAC and still issues the legacy one; GReader logins and Telegram buttons keep working across the switch.

Read surfaces never return stored secrets:
- Notification channels report `hasTelegramBotToken` / `hasGotifyToken` / `hasNtfyToken` (an empty field keeps the token, "Remove" / `null` clears it). A token that is stored but cannot be decrypted skips the channel instead of sending without it.
- Webhook configs (settings UI, REST, MCP) report `hasSecret`, a `secretRef`, and header names whose values are masked as `"__keep__"`. Sending an entry back with its `secretRef` keeps the stored secret (omitted, `""` or `"__keep__"`; `null` removes it) and every header sent as `"__keep__"` (`null` or leaving the header out removes it).
- The feed dialog's fetch options (`httpOptions`) show only non-sensitive cURL options; cookies, headers, POST bodies, proxy URLs and any other option appear as `"__keep__"`. Saving keeps those values, a removed key clears it.
- Values starting with the reserved `ff2.` prefix that are not valid v2 are rejected as malformed (never read as plaintext); `secrets:status` lists them as `malformed`.

### Email address changes

With mail delivery enabled, changing the account email requires the existing step-up
proof and confirmation at the new address. The old login remains active until the
confirmation button is submitted. Pending requests expire after 24 hours; resending
replaces both links and shares a limit of three requests per hour per account
(using the existing process-local rate limiter). The old address receives a cancel
link, and settings also offer authenticated cancellation. Link GETs never consume
requests. Confirmation revokes browser sessions and GReader tokens and clears Fever
keys; sign in again and rotate Fever credentials afterward.

Password changes, two-factor setup/enable/disable, and administrator suspension
invalidate pending requests atomically with the account mutation. Without mail
configured, the existing immediate change after step-up remains available and the
settings warning still applies. The old-address security notice must be delivered before a pending request is
created or replaced. If it fails, the request is refused. Failure delivering the
new-address confirmation leaves the pending request available for resend and shows
an error; resend requires step-up again. Cancellation via the old-address link
revokes browser/API sessions and clears Fever keys because it may signal compromise.

The request/resend rate limit is per process: it resets on restart and is not
shared between replicas. Operators running multiple replicas must also enforce
shared limits at their ingress if they require a global quota.
