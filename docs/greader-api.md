# Google Reader / FreshRSS API

Clients may use `/api/greader` or `/api/greader.php` as the server base.
`GET /api/greader.php` returns plain `OK`. ClientLogin is at
`/accounts/ClientLogin`; other endpoints use `/reader/api/0/`.
`/api/fever.php` aliases `/api/fever`. Aliases forward requests directly without
redirecting, preserving POST bodies and repeated fields.

## Credentials and revocation

Settings → API password lets you set, rotate and revoke a separate password
(16–72 bytes). It is bcrypt-hashed; only creation and last-used timestamps are
returned to the UI. Fever requires a deterministic lookup key, so the standard
`md5(email:API-password)` key is also stored. Treat that key as a credential.
Use TLS. Never put passwords or keys in logs.

| Client authentication | No API password, no 2FA | API password configured | 2FA enabled |
| --- | --- | --- | --- |
| GReader ClientLogin / Basic | Login password, unless requirement enabled | API password only | API password only |
| GReader GoogleLogin / Bearer Auth | Versioned Auth token | Versioned Auth token | Versioned Auth token |
| GReader REST bearer token | Existing token scope | Existing token scope | Existing token scope |
| Fever api_key | Existing REST-token key | API-password key or existing REST-token key | API-password key or existing REST-token key |

Fever cannot verify a bcrypt login-password hash from its MD5-only request.
Existing Fever REST-token keys continue working. An API-password key is
`md5(email:API-password)` and works with 2FA. REST tokens have their own scope,
expiry and revoke controls; rotating the API password does not revoke those.
Read-only bearer tokens cannot perform management writes or mint action tokens.

Rotating, revoking, changing the password requirement, or suspending a user
increments the API token version, invalidating existing GReader Auth and T tokens.
Re-enabling a suspended account does not restore old tokens. On upgrade, clients
must sign in once to obtain versioned tokens. Revocation enables the requirement
so it does not silently restore login-password access. You can explicitly disable
that requirement to restore legacy password fallback for accounts without 2FA.
Missing or `x` action tokens are accepted for client compatibility, like FreshRSS;
a supplied T token must match the current user/version. Authorization is always
required, including for raw OPML imports.

## Management contracts

- `rename-tag`: `s=user/-/label/Old&dest=user/-/label/New`.
- `disable-tag`: one or more `s=user/-/label/Name`. Unfiles feeds, detaches child
  folders, and removes article-label links, preserving feeds and articles.
- `subscription/edit`: `ac=subscribe|unsubscribe|edit`, repeated `s=feed/ID` or
  `s=feed/URL`, optional `t`, repeated `a`/`r` folder references. A feed has one
  folder: the last added folder wins; addition takes precedence over removal.
  Batches are limited to 100, processed in order; earlier successful operations
  can persist if a later operation fails.
- `subscription/quickadd`: `quickadd=URL` (or `url`), uses the shared smart source
  resolver and HTML discovery, validates the final URL, and fetches with SSRF
  protection. Limited to 20 attempts per minute per user, including batch subscribe.
- `tag/list`: custom types are `folder` or `tag`. A namesake folder/label is
  represented once as `folder`. Rename/delete address both namesakes, preserving
  their shared wire identity. Renaming onto another existing folder or label
  returns 409; no implicit merge occurs. Names are limited to 255 characters.
- `GET subscription/export`: user-scoped OPML with FreshRSS extensions.
- `POST subscription/import`: raw OPML XML, capped at 5 MiB, through the shared
  OPML import core with remote trust (no trusted internal URL bypass). Returns
  the shared structured import report. Invalid XML returns 400.

Other forms are capped at 128 KiB (ClientLogin: 8 KiB). Existing GReader request
rate limits and scoped user queries apply. Import does not fetch all feeds inline.

## Operators

The schema changes are additive User fields. Back up your database and apply
`pnpm run prisma:push` with the intended DATABASE_PROVIDER/DATABASE_URL before
starting the new version. No data rewrite or existing token deletion is needed.
Keep AUTH_SECRET stable across instances. Failed-login and discovery limits are
process-local, consistent with the existing limiter; use a proxy-level shared
limit for multiple instances. Suspension through both admin and internal routes
invalidates GReader tokens. API password revocation is independent of web sessions.
