# Self-Hosting FeedFerret

This guide describes the complete installation and operation of FeedFerret on your own server.

---

## Requirements

| Requirement | Details |
|---|---|
| **Docker** | Version 24+ with Docker Compose plugin (v2) |
| **RAM** | At least 512 MB, 1 GB recommended |
| **Port** | 3000 (or any free port, configurable) |
| **Alternative** | [Coolify](https://coolify.io/) — supports Git-based deployment directly from the repository |

> **Note on Coolify:** FeedFerret can be deployed as a Docker Compose service in Coolify. Environment variables are set in the Coolify dashboard instead of in an `.env` file.

---

## Choosing a Docker Compose variant

The repository ships three ready-to-use compose files. All three run the exact same FeedFerret image — the only difference is which optional pieces are bundled alongside it. Pick one, there is no need to edit it further unless you want a fourth combination (see the note at the end of this section).

| File | Database | Browser render sidecar | RSSHub | changedetection.io | Best for |
|---|---|---|---|---|---|
| `docker-compose.minimal.yaml` | SQLite | ✗ | ✗ | ✗ | Personal use, quick try-out, low-resource hosts — a single container |
| `docker-compose.yaml` (default) | PostgreSQL | ✓ | ✗ | ✗ | Most self-hosted deployments — full-text extraction works fully, JS-heavy pages still handled |
| `docker-compose.ultimate.yaml` | PostgreSQL | ✓ | ✓ | ✓ | Power users who want every optional connector available out of the box |

```bash
# Minimal
docker compose -f docker-compose.minimal.yaml up -d --build

# Default (same as just `docker compose up -d --build`)
docker compose -f docker-compose.yaml up -d --build

# Ultimate
docker compose -f docker-compose.ultimate.yaml up -d --build
```

All three read the same `.env` file (`cp .env.example .env` first) — see [Environment Variables](#environment-variables) below for what to set. `docker-compose.minimal.yaml` ignores the `POSTGRES_*` variables since it doesn't use PostgreSQL at all.

RSSHub and changedetection.io are still fully **optional** even in the ultimate stack: their containers just sit there, unused, until an admin actually turns the connector on in **Server Management → Sync** (see [Optional Connectors](#optional-connectors) below) — nothing is exposed to users or enabled by default just because the container exists.

> **Want a different combination** (e.g. SQLite + render sidecar, or PostgreSQL + only RSSHub)? There's no separate file for every permutation — copy the relevant `services:` block(s) from `docker-compose.ultimate.yaml` into a copy of `docker-compose.minimal.yaml` or `docker-compose.yaml`, and add the matching `FEEDFERRET_*` environment lines to the `feedferret` service. All three files use the same service/network conventions, so blocks copy across cleanly.

---

## Deploying with Coolify

[Coolify](https://coolify.io/) is a self-hosted PaaS platform that offers Git-based deployment with automatic SSL certificates and a web UI for environment variables.

### Step by Step

**1. Create a new project in Coolify**

1. Open Coolify → *Projects* → *Add New Project*
2. *Add New Resource* → **Docker Compose**
3. Select **GitHub** (or your Git instance) as the source and connect the `feedferret` repository

**2. Configure the deployment type**

- Deployment Type: **Docker Compose**
- Docker Compose File: `docker-compose.yaml` (in the repo root) — or `docker-compose.minimal.yaml` / `docker-compose.ultimate.yaml` for the other two variants, see [Choosing a Docker Compose variant](#choosing-a-docker-compose-variant) above
- Branch: `main`

> **Important:** Do not define your own `networks:` block in any of the three compose files. Coolify automatically adds its own Traefik network entry. A hardcoded custom bridge network isolates the containers from Traefik and causes *Gateway Timeout* errors. All three bundled compose files are already configured correctly.

**3. Set environment variables in the Coolify dashboard**

Instead of an `.env` file, the variables are entered under *Environment Variables*. Required fields:

| Variable | Description | Example |
|---|---|---|
| `AUTH_SECRET` | Session key (32+ characters) | `openssl rand -base64 32` |
| `AUTH_URL` | Public URL of the instance | `https://rss.example.com` |
| `AUTH_TRUST_HOST` | Must be `true` behind Coolify's Traefik | `true` |
| `POSTGRES_PASSWORD` | DB password (PostgreSQL mode) | random string |

Optional variables (OAuth, email, VAPID) can also be set here — all fields from the *Environment Variables* section further below work identically.

> **Browser render sidecar:** `docker-compose.yaml` and `docker-compose.ultimate.yaml` both start a `render-sidecar` service (see [`docs/render-sidecar.md`](render-sidecar.md)) alongside `feedferret` and `postgres` — an isolated headless Chromium service for JavaScript-heavy/purely client-side pages that the normal fetcher can't read (used as a fallback for full text and "page → feed"). It is active by default in both; set `RENDER_SIDECAR_TOKEN` to your own value (the default is `change-me`). To disable it, remove the `render-sidecar` service and the `FEEDFERRET_RENDER_SIDECAR_URL` line — the rest of the app works unchanged without it. `docker-compose.minimal.yaml` doesn't include it at all.

**4. Configure the domain**

Enter the desired domain in Coolify under *Domains*. Coolify automatically issues a Let's Encrypt certificate.

**5. Deploy**

Click *Deploy* — Coolify builds the image, starts the containers, and sets up HTTPS. The first build takes 3–5 minutes.

### Troubleshooting Coolify

| Problem | Cause | Solution |
|---|---|---|
| *Gateway Timeout* after deploy | Custom `networks:` block in the compose file | Remove the `networks:` section from the compose file you're using — Coolify manages networks itself |
| Login fails / CSRF error | `AUTH_TRUST_HOST` missing | Set `AUTH_TRUST_HOST=true` in Coolify's environment variables |
| `AUTH_URL` is ignored | Coolify doesn't set an `AUTH_URL` | Set it manually in the environment variables with the full `https://` prefix |
| Build fails with `prisma generate` | Cache issue | Enable *Force Rebuild* in Coolify and deploy again |
| PostgreSQL password error after rebuild | Volume still has the old password | Delete the PostgreSQL volume in Coolify's *Volumes* and redeploy (all data will be lost — back up first!) |

---

## Quick Start (5 Minutes)

```bash
# 1. Clone the repository
git clone https://github.com/moby3012/feedferret.git && cd feedferret

# 2. Create the env file
cp .env.example .env

# 3. Set the three required fields (see below)
nano .env

# 4. Start the stack — this uses docker-compose.yaml (the default variant:
#    PostgreSQL + render sidecar). See "Choosing a Docker Compose variant"
#    above for the minimal/ultimate alternatives.
docker compose up -d --build
```

Then go through the setup wizard at `http://localhost:3000` (or your configured domain).

---

## Environment Variables

### Required Fields

These three variables **must** be set before the first start:

| Variable | Description | Example |
|---|---|---|
| `AUTH_SECRET` | Secret key for sessions and encrypted DB fields | `openssl rand -base64 32` |
| `AUTH_URL` | Public URL of the instance (with protocol, no trailing slash) | `https://rss.example.com` |
| `POSTGRES_PASSWORD` | Password for the PostgreSQL database | `secure-password-here` |

**Generate `AUTH_SECRET`:**

```bash
openssl rand -base64 32
```

> **Important:** `AUTH_SECRET` must remain stable across all deploys. FeedFerret uses this key to encrypt stored API credentials (e.g. AI summary credentials). If you change it, encrypted data in the database becomes unreadable.

**Minimal `.env` to get started:**

```env
AUTH_SECRET="your-generated-key"
AUTH_URL="https://rss.example.com"
AUTH_TRUST_HOST=true
POSTGRES_PASSWORD="secure-password-here"
```

---

### Optional Variables

#### OAuth Login

For login via external identity providers. More details in [`docs/self-hosting-auth-email.md`](./self-hosting-auth-email.md).

```env
# Google OAuth
GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="your-google-secret"

# GitHub OAuth
GITHUB_CLIENT_ID="your-github-client-id"
GITHUB_CLIENT_SECRET="your-github-secret"
```

#### OIDC (e.g. Authelia, Keycloak)

```env
AUTHELIA_CLIENT_ID="feedferret"
AUTHELIA_CLIENT_SECRET="your-oidc-secret"
AUTHELIA_ISSUER="https://auth.example.com"
AUTHELIA_PROVIDER_NAME="Authelia"
```

#### Email Sending

Credentials can be configured here via ENV or in the admin UI (under *Server Management → Email*). Values from the database take precedence.

```env
# Resend
RESEND_API_KEY="re_xxxxxxxxxxxx"
RESEND_FROM_EMAIL="FeedFerret <noreply@example.com>"

# Postmark
POSTMARK_SERVER_TOKEN="your-postmark-token"
POSTMARK_FROM_EMAIL="noreply@example.com"
POSTMARK_MESSAGE_STREAM="outbound"

# Mailgun
MAILGUN_API_KEY="your-mailgun-key"
MAILGUN_DOMAIN="mg.example.com"
MAILGUN_FROM_EMAIL="FeedFerret <noreply@example.com>"
MAILGUN_BASE_URL="https://api.mailgun.net"

# SendGrid
SENDGRID_API_KEY="SG.xxxxxxxxxxxx"
SENDGRID_FROM_EMAIL="noreply@example.com"

# SMTP (any SMTP provider)
SMTP_HOST="smtp.example.com"
SMTP_PORT="587"
SMTP_USER="noreply@example.com"
SMTP_PASSWORD="smtp-password"
SMTP_FROM="FeedFerret <noreply@example.com>"
```

#### Browser Push Notifications (Web Push / VAPID)

```bash
# Generate a VAPID key pair:
pnpm run webpush:keys
```

```env
WEB_PUSH_VAPID_PUBLIC_KEY="your-public-vapid-key"
WEB_PUSH_VAPID_PRIVATE_KEY="your-private-vapid-key"
WEB_PUSH_CONTACT="mailto:admin@example.com"
```

#### Miscellaneous

```env
# 2FA label in authenticator apps
TOTP_ISSUER="FeedFerret"

# Feed sync protection (optional shared secret for the sync endpoint)
SYNC_SECRET="random-string"

# SSRF protection (only disable on trusted single-tenant instances)
TRUSTED_FEED_FETCHING="false"
ALLOW_INTERNAL_FEED_URLS="false"
```

---

## First Start and Setup Wizard

After `docker compose up -d --build`, open the configured URL. The setup wizard walks you through initial configuration in 5 steps:

1. **Create admin account** — set the email address and password for the first administrator account.
2. **Instance settings** — instance name, public URL, registration mode (open / invite-only / closed).
3. **Configure email** (optional) — enter SMTP or API credentials for password reset emails and notifications. Can be skipped and configured later.
4. **Security settings** — 2FA requirement, session duration, privacy options.
5. **Done & starter packs** — on the last step, preconfigured feed collections (starter packs) can be chosen by topic to populate the instance with content right away.

---

## Applying Updates

```bash
# Pull the latest image and restart the containers
docker compose pull && docker compose up -d --build
```

FeedFerret automatically runs database migrations on startup. No manual migration step is needed.

---

## Backup

### PostgreSQL (Default)

```bash
# Create a database dump
docker exec feedferret-postgres pg_dump \
  -U feedferret \
  -d feedferret \
  > feedferret_backup_$(date +%Y%m%d_%H%M%S).sql

# Restore the dump (into an empty database)
docker exec -i feedferret-postgres psql \
  -U feedferret \
  -d feedferret \
  < feedferret_backup_2024_01_01_120000.sql
```

For automated backups, a cron job or a tool like [pgbackuper](https://github.com/2ndquadrant-it/barman) or Restic with the `pg_dump` command above is recommended.

### SQLite

Back up the entire database volume as a tar archive:

```bash
# Back up the volume contents
docker run --rm \
  -v feedferret_db_data:/data \
  -v $(pwd):/backup \
  alpine tar czf /backup/feedferret_sqlite_backup_$(date +%Y%m%d_%H%M%S).tar.gz -C /data .
```

---

## SQLite Mode

FeedFerret supports SQLite as an alternative to PostgreSQL — ideal for individuals or test instances without a separate database service. The easiest way to get this is `docker-compose.minimal.yaml` (see [Choosing a Docker Compose variant](#choosing-a-docker-compose-variant)): it's already configured for SQLite end to end (build args, `DATABASE_PROVIDER`/`DATABASE_URL`, and a persistent volume at `/app/data`) — just run it, no editing needed:

```bash
cp .env.example .env   # POSTGRES_* variables in it are simply ignored
docker compose -f docker-compose.minimal.yaml up -d --build
```

If you'd rather add SQLite to a customized compose file instead of starting from `docker-compose.minimal.yaml`, the three ingredients it uses are:

```yaml
services:
  feedferret:
    build:
      args:
        DATABASE_PROVIDER: sqlite
        DATABASE_URL: file:/app/data/dev.db
    environment:
      - DATABASE_PROVIDER=sqlite
      - DATABASE_URL=file:/app/data/dev.db
    volumes:
      - feedferret_db_data:/app/data
    # remove the 'postgres' dependency and depends_on block entirely

volumes:
  feedferret_db_data:
```

> **Note:** Switching from SQLite to PostgreSQL later requires a manual data export (OPML/JSON) and re-import. There is no automatic migration tool.

---

## Troubleshooting

| Problem | Cause | Solution |
|---|---|---|
| Login fails / `CSRF` error behind a reverse proxy | `AUTH_TRUST_HOST` not set | Set `AUTH_TRUST_HOST=true` in `.env` |
| Port 3000 already in use | Another service is using the port | Set `PORT=3001` in `.env` and change `ports:` in your compose file to `"3001:3001"` |
| `Connection refused` to the database at startup | PostgreSQL not ready yet | Check container logs: `docker compose logs postgres`; the health check should catch this automatically |
| `password authentication failed for user "feedferret"` | `POSTGRES_PASSWORD` in `.env` doesn't match the password set at first startup | Delete the volume (`docker compose down -v`) and restart, **or** manually reset the password in the DB |
| Build fails (`ENOENT`, `prisma generate`) | Incomplete clone or node module conflict | Run `docker compose build --no-cache` |
| Images / assets don't load | `AUTH_URL` misconfigured | `AUTH_URL` must exactly match the publicly reachable URL (including `https://`) |
| Container starts, but the health check fails | The application needs longer to start | Increase `start_period` in the health check, or check logs: `docker compose logs feedferret` |

---

## Docker Image Architecture

The `Dockerfile` uses five stages:

| Stage | Base | Purpose |
|---|---|---|
| `base-runtime` | `node:22-slim` + openssl, curl | Shared runtime base (no build tooling) |
| `base-build` | `base-runtime` + python3, make, g++ | Base for all build stages |
| `deps` | `base-build` | Installs npm dependencies via pnpm |
| `builder` | `base-build` | Compiles Next.js |
| `runner` | `base-runtime` | Production image — contains no build tools |

The runner image deliberately contains no native compilers (`g++`, `make`, `python3`) and no `libvips`. The Prisma CLI is installed explicitly at the version pinned in `package.json` (`npm install -g prisma@<version>`) so the CLI and client are guaranteed to match.

---

## Optional Connectors

FeedFerret runs completely on its own — none of the following are required. Each is an admin-configured, opt-in connector, hidden from every user until an admin turns it on in **Server Management → Sync**. All three require an outbound network path from the FeedFerret container to the connector's own container/host; if you run them on the same Docker network (the default for anything added to any of the three compose files), no extra firewall configuration is needed.

`docker-compose.ultimate.yaml` already bundles all three — if you're using it, skip straight to each connector's admin-configuration step below (the "minimal compose addition" snippets are for adding a connector to `docker-compose.minimal.yaml` or `docker-compose.yaml` manually).

> **Port note (matters on Coolify and similar platforms):** RSSHub and changedetection.io both read the generic `PORT` environment variable to pick their listen port (their own defaults are 1200 and 5000). Some deploy platforms — **Coolify included** — inject one project-wide `PORT` value into *every* service of a Compose stack, which silently moves both connectors onto that port (3000, matching FeedFerret) instead of their defaults. To stay predictable everywhere, `docker-compose.ultimate.yaml` pins both connectors to `PORT=3000`, exposes them on 3000, and points FeedFerret at `http://rsshub:3000/`. The snippets below do the same. If you ever see a *Bad Gateway* reaching one of these services, it's almost always this: the container is listening on a different port than the one you're routing to.

### Browser render sidecar

For JavaScript-heavy pages the normal fetcher can't read (used as a fallback for full-text extraction and "page → feed"). Bundled by default in `docker-compose.yaml` and `docker-compose.ultimate.yaml` — see [`docs/render-sidecar.md`](./render-sidecar.md) for the full setup, security model, and how to swap in your own service (e.g. crawl4ai).

### RSSHub connector

Turns a platform source without its own feed — a YouTube channel, a subreddit, a GitHub repo's releases, and hundreds of other routes — into a real feed, via your own self-hosted [RSSHub](https://docs.rsshub.app/) instance. Configure the base URL (and, only if your RSSHub instance sets an `ACCESS_KEY`, the matching key) in **Server Management → Sync → RSSHub connector**. Once configured, users get a 4th "From platform" tab in the Add Feed dialog. A resolved RSSHub route is stored as a plain feed URL — no different from any other RSS feed — so no extra sync/export handling is needed, but note that if you set an access key, it becomes part of that feed's URL and is therefore visible to whichever user added it (OPML export, feed settings, etc.).

In `docker-compose.ultimate.yaml`, this is already pre-wired via the `FEEDFERRET_RSSHUB_URL`/`FEEDFERRET_RSSHUB_KEY` environment variables against the bundled `rsshub` service — it works immediately with no admin-UI step needed. Users get the "From platform" tab in the Add Feed dialog straight away. Set `RSSHUB_ACCESS_KEY` in `.env` to turn on `ACCESS_KEY` auth for both the `rsshub` service and FeedFerret's own connector config at once; leave it unset to run with no auth.

> **Heads-up:** when the connector is configured via `FEEDFERRET_RSSHUB_URL` (env), the RSSHub fields under **Server Management → Sync** intentionally read back **empty** — that panel reflects the database row, and the env value takes precedence over it. This is expected: the connector is still active (env wins). Don't re-enter the URL there to "fix" it; if you do want to manage it from the UI instead, remove the `FEEDFERRET_RSSHUB_*` env vars so the database row becomes the live config.

**When a route fails, the error is RSSHub's, not FeedFerret's.** FeedFerret only builds the route URL and fetches it; whether a given route works depends entirely on your RSSHub instance. FeedFerret now surfaces RSSHub's own message with the failure (e.g. `Fetch failed: 503 — Twitter API is not configured`). Common cases:

| RSSHub message | What it means |
|---|---|
| `Twitter API is not configured` / similar for other platforms | That route needs credentials configured **in RSSHub itself** (see [RSSHub's config docs](https://docs.rsshub.app/deploy/config)) — X/Twitter, and some others, don't work on a stock RSSHub without keys. |
| `This channel does not exist` / `404` | The identifier is wrong. When you paste a URL and let AI propose a route, it can guess the wrong channel/user ID — prefer pasting the **exact** RSSHub route path (e.g. `/youtube/channel/UC…` with the real ID from the channel's page) when a proposal fails. |
| `The route does not exist or has been deleted` | That route category isn't available in your RSSHub version/build. |

A quick way to confirm the connector itself is wired up correctly (independent of any one platform's quirks) is a route that needs no external credentials, e.g. a GitHub repo's releases: `/github/repos/DIYgod/RSSHub`. If that returns items, FeedFerret ↔ RSSHub is working and any other failure is that specific route's own requirement.

Minimal compose addition (for `docker-compose.minimal.yaml` / `docker-compose.yaml`):

```yaml
services:
  rsshub:
    image: diygod/rsshub
    restart: unless-stopped
    environment:
      - PORT=3000              # see the port note above — keeps it deterministic
      - ACCESS_KEY=change-me   # optional — omit to run without a key
    expose:
      - "3000"
```

Point FeedFerret's RSSHub base URL at `http://rsshub:3000/` (the Docker Compose service name).

### changedetection.io connector

Turns *any* page — including JS-rendered ones, since [changedetection.io](https://changedetection.io) does its own browser rendering — into a feed of its changes over time. Configure the base URL and **two separate secrets** in **Server Management → Sync → changedetection.io connector**:

- **API key** — from changedetection.io's own Settings → **API** tab (shown next to a "Regenerate API key" button). Used to create/manage watches via the `x-api-key` header.
- **RSS access token** — a **different**, auto-generated secret required to read a watch's RSS output (the API key alone does not work there). **There is no copyable field for it anywhere in Settings.** Fill in the base URL and API key, then click **"Test connection"** — FeedFerret fetches the instance's homepage in the background and auto-fills the RSS token from the hidden RSS-autodiscovery `<link>` tag changedetection.io embeds in every page's HTML `<head>`. Review the auto-filled value and hit Save.

  If auto-detection fails (e.g. password protection is enabled on the changedetection.io instance), grab the token manually instead:
  - `curl -s https://your-changedetection-host/ | grep -o 'token=[a-f0-9]*' | head -1` (from a shell that can reach it), or
  - "View Page Source" on changedetection's main watch-list page (not Settings) in a desktop browser, then search for `token=` in the `<head>`.

  The same token also appears in the URL of any individual watch's own RSS link once you've created one, if you'd rather copy it from there.

Once configured, users get a "Monitor page" tab in the Add Feed dialog. **A freshly created watch's feed has no items until changedetection.io has checked the page at least twice** — this is expected, not a bug; the feed fills in on its own once enough history exists.

`docker-compose.ultimate.yaml` bundles the `changedetection` service, but deliberately does **not** pre-wire FeedFerret's connector via environment variables — both secrets above only exist after changedetection.io's own container has started and you've opened its web UI at least once to generate them, so there's nothing to default them to at deploy time. After starting the ultimate stack, open changedetection's UI (route a domain to the `changedetection` service's port 3000 in your reverse proxy / Coolify, or use a temporary port-forward), grab both values from Settings, then configure the connector once in **Server Management → Sync** with base URL `http://changedetection:3000/`. It's usable immediately after that — no restart needed.

Minimal compose addition (for `docker-compose.minimal.yaml` / `docker-compose.yaml`):

```yaml
services:
  changedetection:
    image: ghcr.io/dgtlmoon/changedetection.io
    restart: unless-stopped
    environment:
      - PORT=3000              # see the port note above — keeps it deterministic
    volumes:
      - changedetection-data:/datastore
    expose:
      - "3000"
volumes:
  changedetection-data:
```

Point FeedFerret's changedetection.io base URL at `http://changedetection:3000/` (the Docker Compose service name).

### Network isolation / SSRF notes

- Every URL a connector is asked to fetch or watch (the *target* page, not the connector itself) still goes through FeedFerret's normal SSRF checks — a connector cannot be used to make FeedFerret (or the connector) reach an internal/private address a plain feed fetch wouldn't already be allowed to reach.
- The connector's own base URL is treated as trusted admin configuration. Because the recommended setup runs each connector on the **same private Docker network** as FeedFerret (so its base URL is a private hostname like `http://rsshub:3000/`), FeedFerret automatically allows internal/private fetches **to that specific configured host only** — both when validating a route and on every ongoing background sync of the resulting feed. You do **not** need to turn on the instance-wide "Allow internal feed URLs" switch just to use a connector, and doing so is not recommended (it would let any user point any feed at internal addresses). Only the exact host of a configured connector is trusted; arbitrary internal addresses stay blocked.
- Keep each connector on the same private Docker network as FeedFerret and do not expose its port publicly (changedetection.io's own web UI is the one exception — you need to reach it once to copy its API key and RSS access token; route a domain to it temporarily or use a port-forward, then you can lock it back down). There is no reason for RSSHub's own web UI to be reachable from outside your server.

---

## Further Documentation

- **Reverse proxy (Nginx, Caddy, Traefik):** [`docs/reverse-proxy.md`](./reverse-proxy.md)
- **OAuth, OIDC, and email providers in detail:** [`docs/self-hosting-auth-email.md`](./self-hosting-auth-email.md)
- **REST API and Google Reader API:** [`docs/api.md`](./api.md)
- **Example feeds/pages to smoke-test each fetch path (incl. connectors):** [`docs/testing-feeds.md`](./testing-feeds.md)
- **Database details:** [`docs/database.md`](./database.md)
- **Security:** [`docs/security.md`](./security.md)
